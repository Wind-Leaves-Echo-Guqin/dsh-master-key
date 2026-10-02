// 兼容装载器：把一个 legacy 插件交给总线协商，由认领的协议包包装激活。
// fail-open 原则：目标插件炸了 → quarantine 报告 + 返回信封，绝不外抛拖垮插件树。

import { createRequire } from 'node:module';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, isAbsolute, resolve as pathResolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { negotiate } from './core/bus.js';
import { ok, unavailable } from './core/envelope.js';

const require = createRequire(import.meta.url);
const SOURCE_READ_LIMIT = 256 * 1024;

// spec: { name?: 包名, path?: 本地路径, protocol?: 指定 pack id（跳过协商）, config?: 透传配置 }
// deps: { hostCtx, packs, caps, report, logger, dshx }
export async function mountCompatTarget(spec, { hostCtx, packs, caps, report, logger, dshx = null }) {
  const label = spec.name || spec.path || '<anonymous>';
  let plugin;
  try {
    plugin = await resolvePlugin(spec);
  } catch (err) {
    report?.quarantine?.({ plugin: label, pack: null, error: err, caps });
    return unavailable('dshx.compat.resolve', `目标插件解析失败: ${err?.message || err}`, { target: label });
  }

  let pick = null;
  if (spec.protocol) {
    pick = packs.map(p => ({ pack: p, score: 1 })).find(x => x.pack.id === spec.protocol) || null;
    if (!pick) {
      const err = new Error(`指定协议包 ${spec.protocol} 未载入或不可用`);
      report?.quarantine?.({ plugin: plugin.manifest?.name || label, pack: spec.protocol, error: err, caps });
      return unavailable('dshx.compat.pack', err.message, { target: label });
    }
  } else {
    pick = await negotiate(packs, plugin, { report });
    if (!pick) {
      // 显式 compat 目标（用户点名要适配）不被任何包认领时，落到声明了
      // genericFallback 的包（默认 cordis-bundle）——适配意图优先于认领度。
      const fallback = packs.find(p => p.descriptor?.genericFallback === true);
      if (fallback) {
        pick = { pack: fallback, score: 0 };
        report?.event?.('generic-fallback', { plugin: plugin.manifest?.name || label, pack: fallback.id });
      }
    }
    if (!pick) {
      const err = new Error('无协议包认领该插件（协议未知或包缺失）');
      report?.quarantine?.({ plugin: plugin.manifest?.name || label, pack: null, error: err, caps });
      return unavailable('dshx.compat.negotiate', err.message, { target: label });
    }
  }

  try {
    // 等待目标插件声明的服务（cordis inject 语义的挂载态复刻）：
    // legacy 插件在自己的 loader entry 里靠 inject 等服务就绪；经适配器挂载时
    // 由我们代为等待，超时则带缺失清单继续（fail-open，由插件自身行为决定成败）。
    const wanted = normalizeInjectList(plugin.entry?.inject ?? plugin.entry?.default?.inject);
    if (wanted.length > 0) {
      const wait = await waitForServices(hostCtx, wanted, 20_000);
      report?.event?.('services-wait', { plugin: plugin.manifest?.name || label, resolved: wait.resolved, missing: wait.missing });
    }
    const result = await pick.pack.mapping.wrapActivate(plugin, hostCtx, {
      caps, report, logger, dshx, config: spec.config ?? {},
    });
    report?.event?.('compat-activated', { plugin: plugin.manifest?.name || label, pack: pick.pack.id });
    return ok(result, { plugin: plugin.manifest?.name || label, pack: pick.pack.id });
  } catch (err) {
    report?.quarantine?.({ plugin: plugin.manifest?.name || label, pack: pick.pack.id, error: err, caps });
    return unavailable('dshx.compat.activate', `目标插件激活失败（已隔离，不影响插件树）: ${err?.message || err}`, { target: label, pack: pick.pack.id });
  }
}

// ── 插件解析：包名（从 profile/cwd 锚点）或本地路径；ESM import / CJS require 双轨 ──
async function resolvePlugin(spec, env = process.env) {
  let entryFile = null;
  let manifest = null;
  let entry = null;

  if (spec.path) {
    const abs = isAbsolute(spec.path) ? spec.path : pathResolve(process.cwd(), spec.path);
    entryFile = abs;
    const pkgFile = findPackageJson(dirname(abs));
    manifest = pkgFile ? safeJson(pkgFile) : { name: spec.name || basenameNoExt(abs) };
  } else if (spec.name) {
    const anchors = [env.DSH_PROFILE_DIR, process.cwd(), env.DSH_HOME].filter(Boolean);
    const resolved = require.resolve(spec.name, { paths: anchors });
    entryFile = resolved;
    const pkgFile = findPackageJson(dirname(resolved));
    manifest = pkgFile ? safeJson(pkgFile) : { name: spec.name };
  } else {
    throw new Error('compat target 需要 name 或 path');
  }

  const isEsm = manifest?.type === 'module' || entryFile.endsWith('.mjs');
  if (isEsm) {
    entry = await import(pathToFileURL(entryFile).href);
  } else {
    const req = createRequire(import.meta.url);
    entry = req(entryFile);
  }
  if (entry && entry.default && typeof entry === 'object' && !('apply' in entry)) {
    entry = { ...entry, apply: entry.default }; // ESM default 出口归一
  }
  if (!entry || typeof entry !== 'object' || !(typeof entry.apply === 'function' || typeof entry.activate === 'function')) {
    throw new Error(`入口无可调用插件（需要 apply 或 activate）: ${entryFile}`);
  }

  const sourceText = readBounded(entryFile);
  return { manifest: manifest || {}, entry, sourceText, sourcePath: entryFile };
}

function findPackageJson(dir) {
  let cur = dir;
  for (let i = 0; i < 3; i++) {
    const p = join(cur, 'package.json');
    if (existsSync(p)) return p;
    const up = dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  return null;
}

function safeJson(f) { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } }

function readBounded(f) {
  try {
    const st = statSync(f);
    const fd = require('node:fs').openSync(f, 'r');
    try {
      const buf = Buffer.alloc(Math.min(st.size, SOURCE_READ_LIMIT));
      require('node:fs').readSync(fd, buf, 0, buf.length, 0);
      return buf.toString('utf8');
    } finally { require('node:fs').closeSync(fd); }
  } catch { return ''; }
}

function basenameNoExt(p) { return p.split(/[\\/]/).pop().replace(/\.[cm]?js$/, ''); }

function normalizeInjectList(v) {
  return Array.isArray(v) ? v.filter(x => typeof x === 'string') : [];
}

async function waitForServices(hostCtx, names, timeoutMs) {
  const resolved = [];
  const missing = [];
  const deadline = Date.now() + timeoutMs;
  const pending = new Set(names);
  while (pending.size > 0 && Date.now() < deadline) {
    for (const n of [...pending]) {
      try {
        const v = typeof hostCtx.get === 'function' ? hostCtx.get(n) : undefined;
        if (v !== undefined && v !== null) { resolved.push(n); pending.delete(n); }
      } catch { /* 守卫拒绝 = 未就绪，继续等 */ }
    }
    if (pending.size === 0) break;
    await new Promise(r => setTimeout(r, 200));
  }
  missing.push(...pending);
  return { resolved, missing };
}

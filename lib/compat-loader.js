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
// deps: { hostCtx, packs, caps, report, logger }
export async function mountCompatTarget(spec, { hostCtx, packs, caps, report, logger }) {
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
      const err = new Error('无协议包认领该插件（协议未知或包缺失）');
      report?.quarantine?.({ plugin: plugin.manifest?.name || label, pack: null, error: err, caps });
      return unavailable('dshx.compat.negotiate', err.message, { target: label });
    }
  }

  try {
    const result = await pick.pack.mapping.wrapActivate(plugin, hostCtx, {
      caps, report, logger, config: spec.config ?? {},
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

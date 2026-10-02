// 协议总线：载入协议包 → 宿主探测 → 对目标插件协商认领。
// 核心不认识任何具体协议；新协议 = 新增一个包（内置目录或 ~/.dsh/dshx/packs/）。

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateDescriptor, PACK_FORMAT } from '../pack-sdk.js';

const BUILTIN_PACKS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'packs');

// 载入协议包。userPacksDir 默认 $DSH_HOME/dshx/packs；社区包默认停用，
// 须在 $DSH_HOME/dshx/config.json 的 enabledUserPacks 数组里显式开启（信任边界）。
export async function loadPacks({ caps = {}, env = process.env, extraDirs = [], enabledUserPacks = null, report = null } = {}) {
  const packs = [];
  const loadDir = async (dir, isUser) => {
    if (!existsSync(dir)) return;
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const dirP = join(dir, e.name);
      const descFile = join(dirP, 'descriptor.json');
      if (!existsSync(descFile)) continue;
      let descriptor = null;
      try { descriptor = JSON.parse(readFileSync(descFile, 'utf8')); } catch (err) {
        report?.event?.('pack-load-failed', { pack: e.name, reason: `descriptor 解析失败: ${err.message}` });
        continue;
      }
      const v = validateDescriptor(descriptor);
      if (!v.ok) {
        report?.event?.('pack-load-failed', { pack: e.name, reason: v.errors.join('; ') });
        continue;
      }
      if (isUser && !userPackEnabled(descriptor.id, env, enabledUserPacks)) {
        report?.event?.('pack-skipped', { pack: descriptor.id, reason: '社区包未显式启用（信任边界）' });
        continue;
      }
      // 宿主能力位门槛：要求的任一能力位为 false/unknown → 包整体不可用
      const missing = (descriptor.requiresHostCaps || []).filter(c => caps[c] !== true);
      if (missing.length > 0) {
        report?.event?.('pack-skipped', { pack: descriptor.id, reason: `宿主能力位不满足: ${missing.join(', ')}` });
        continue;
      }
      try {
        const mapping = await import(pathToFileURL(join(dirP, 'mapping.js')).href);
        const mod = mapping.default ?? mapping;
        packs.push({
          id: descriptor.id,
          version: descriptor.version,
          descriptor,
          mapping: mod,
          source: isUser ? 'user' : 'builtin',
        });
      } catch (err) {
        report?.event?.('pack-load-failed', { pack: descriptor.id, reason: `mapping 加载失败: ${err.message}` });
      }
    }
  };

  await loadDir(BUILTIN_PACKS_DIR, false);
  const userPacksDir = env.DSHX_PACKS_DIR || join(env.DSH_HOME || join(process.env.USERPROFILE || '', '.dsh'), 'dshx', 'packs');
  await loadDir(userPacksDir, true);
  for (const d of extraDirs) await loadDir(d, false);
  return packs;
}

function userPackEnabled(id, env, enabledUserPacks) {
  if (Array.isArray(enabledUserPacks)) return enabledUserPacks.includes(id);
  try {
    const cfgFile = join(env.DSH_HOME || join(process.env.USERPROFILE || '', '.dsh'), 'dshx', 'config.json');
    if (existsSync(cfgFile)) {
      const cfg = JSON.parse(readFileSync(cfgFile, 'utf8'));
      return Array.isArray(cfg.enabledUserPacks) && cfg.enabledUserPacks.includes(id);
    }
  } catch { /* 配置坏 = 不启用，安全侧 */ }
  return false;
}

// 协议协商：对目标插件逐包 canSpeak，取最高分。
// plugin: { manifest, entry (模块命名空间或 module.exports), sourcePath }
// 返回 { pack, score } 或 null（无人认领 → quarantine 路径）。
export async function negotiate(packs, plugin, { report = null } = {}) {
  let best = null;
  for (const pack of packs) {
    let score = 0;
    try { score = Number(await pack.mapping.canSpeak(plugin)) || 0; } catch (err) {
      report?.event?.('canSpeak-error', { pack: pack.id, plugin: plugin?.manifest?.name, reason: String(err?.message || err) });
      continue;
    }
    if (score > 0 && (!best || score > best.score)) best = { pack, score };
  }
  if (!best) report?.event?.('no-pack-claimed', { plugin: plugin?.manifest?.name });
  return best;
}

// 插件识别信号求值（descriptor.pluginSignals），供包内 canSpeak 复用。
export async function evalSignals(signals, plugin) {
  let hits = 0;
  for (const sig of signals || []) {
    if (await signalHit(sig, plugin)) hits++;
  }
  return hits;
}

async function signalHit(sig, plugin) {
  const manifest = plugin.manifest || {};
  switch (sig.kind) {
    case 'manifestField': {
      const val = manifestGet(manifest, sig.path);
      if (val === undefined) return false;
      return sig.value === undefined ? true : val === sig.value;
    }
    case 'entryExport':
      return plugin.entry != null && sig.value in plugin.entry;
    case 'importSpecifier':
      return typeof plugin.sourceText === 'string' && plugin.sourceText.includes(sig.value);
    case 'extensionKind':
      return manifest?.dsh?.extension != null || plugin.extensionKind === sig.value;
    default:
      return false;
  }
}

function manifestGet(obj, path) {
  let cur = obj;
  for (const p of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = cur[p];
  }
  return cur;
}

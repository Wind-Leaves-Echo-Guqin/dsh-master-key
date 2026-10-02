// 变体识别：描述库（variants/*.json）驱动 + 未知变体结构探测归类。
// 描述库是数据——社区为新壳贡献一个 JSON 即可让适配层认识它（docs/variant-format.md）。

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { readJsonFile } from './json.js';

const require = createRequire(import.meta.url);
const BUILTIN_VARIANTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'variants');

export function loadVariants(extraDirs = []) {
  const out = new Map();
  const dirs = [BUILTIN_VARIANTS_DIR, ...extraDirs];
  for (const dir of dirs) {
    let files = [];
    try { files = readdirSync(dir).filter(f => f.endsWith('.json')); } catch { continue; }
    for (const f of files) {
      try {
        const d = readJsonFile(join(dir, f)); // BOM 容忍
        if (d && typeof d.id === 'string' && Array.isArray(d.packs)) out.set(d.id, d);
      } catch { /* 坏描述不致命，跳过 */ }
    }
  }
  return [...out.values()];
}

// 环境展开：%LOCALAPPDATA% / %APPDATA% / %~（家目录）
function expandPath(p, env) {
  return p
    .replace(/%LOCALAPPDATA%/g, env.LOCALAPPDATA || '')
    .replace(/%APPDATA%/g, env.APPDATA || '')
    .replace(/%~%/g, env.USERPROFILE || env.HOME || '');
}

function signalMatch(sig, env) {
  try {
    switch (sig.kind) {
      case 'dirExists':
      case 'fileExists':
        return existsSync(expandPath(sig.path, env));
      case 'fileContains': {
        const p = expandPath(sig.path, env);
        if (!existsSync(p)) return false;
        const st = statSync(p);
        if (st.isDirectory()) return false;
        // 有界读取：只看头部 1MB 足够识别
        const fd = require('node:fs').openSync(p, 'r');
        try {
          const buf = Buffer.alloc(Math.min(st.size, 1024 * 1024));
          require('node:fs').readSync(fd, buf, 0, buf.length, 0);
          return buf.toString('utf8').includes(sig.needle);
        } finally { require('node:fs').closeSync(fd); }
      }
      case 'env': {
        const v = env[sig.name];
        if (sig.value === '*') return v !== undefined;
        return v === sig.value;
      }
      case 'execPathContains':
        // 运行时位置信号：本进程可执行文件路径包含片段（区分"机器上装了 X"与"正跑在 X 里"）
        return (env.DSH_EXEC_PATH || process.execPath).includes(sig.needle);
      case 'manifestField':
        return signalManifestField(sig, env);
      case 'moduleResolvable':
        try { require.resolve(sig.specifier, { paths: [process.cwd()] }); return true; } catch { return false; }
      case 'windowFlag':
        return false; // 服务端不可探测，留给 client 半；服务端探测恒 false
      default:
        return false;
    }
  } catch { return false; }
}

function signalManifestField(sig, env) {
  // 在常见插件位置找 package.json 匹配 manifest 字段（用于"是插件不是壳"类信号）
  const home = env.DSH_HOME || join(env.USERPROFILE || '', '.dsh');
  const roots = [join(home, 'profiles'), process.cwd()];
  const wantValue = sig.value !== undefined;
  for (const root of roots) {
    let found = scanManifests(root, 0, sig.path, wantValue, sig.value);
    if (found) return true;
  }
  return false;
}

function scanManifests(dir, depth, jsonPath, wantValue, value) {
  if (depth > 4) return false;
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return false; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const pkgFile = join(dir, e.name, 'package.json');
    if (existsSync(pkgFile)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'));
        if (manifestGet(pkg, jsonPath) !== undefined) {
          if (!wantValue) return true;
          if (manifestGet(pkg, jsonPath) === value) return true;
        }
      } catch { /* 跳过 */ }
    }
    if (scanManifests(join(dir, e.name), depth + 1, jsonPath, wantValue, value)) return true;
  }
  return false;
}

function manifestGet(obj, path) {
  const parts = path.split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = cur[p];
  }
  return cur;
}

// 识别变体：返回 { id, descriptor, matchedBy } 或 { id:'unknown', descriptor:null }
export function detectVariant(variants, env = process.env) {
  const ordered = [...variants].sort((a, b) => (b.detect?.length || 0) - (a.detect?.length || 0)); // 特异性高的先判
  for (const v of ordered) {
    const signals = v.detect || [];
    if (signals.length === 0) continue; // 泛型描述（pure-shell）只在兜底时用
    if (signals.every(s => signalMatch(s, env))) {
      return { id: v.id, descriptor: v, matchedBy: signals.map(s => s.kind) };
    }
  }
  const generic = ordered.find(v => (v.detect || []).length === 0 && v.family === 'wrapper');
  if (generic) return { id: generic.id, descriptor: generic, matchedBy: ['fallback-generic'] };
  return { id: 'unknown', descriptor: null, matchedBy: [] };
}

// 结构探测归类（描述库全不命中时）：能认出官方 cordis 面 / eac 发现面就归族，否则 unknown。
export function classifyUnknown(env = process.env) {
  const home = env.DSH_HOME || join(env.USERPROFILE || '', '.dsh');
  const families = [];
  let hasOfficialSignal = false;
  for (const p of [join(home, 'profiles'), process.cwd()]) {
    if (existsSync(join(p, 'cordis.patch.yml')) || existsSync(join(p, 'cordis.yml'))) { hasOfficialSignal = true; break; }
    try {
      if (readdirSync(p, { withFileTypes: true }).some(e => e.isDirectory() && existsSync(join(p, e.name, 'cordis.patch.yml')))) { hasOfficialSignal = true; break; }
    } catch { /* 继续 */ }
  }
  if (hasOfficialSignal) families.push('cordis-bundle');
  if (existsSync(join(home, 'extensions', 'registry.json'))) families.push('eac-sdk');
  return { id: 'unknown-classified', families, hasOfficialSignal };
}

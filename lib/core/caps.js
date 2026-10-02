// 能力位探测：一切可用性判断都基于运行时探测，禁止版本号硬映射
// （依据：dsh-master-key-vet 的教训——"dsh 版本号 → 能力"映射不稳定；见 docs/protocol-chronicle.md §5.5）。
// 能力位三态：true / false / null(unknown)。消费方必须把 unknown 当作"按不可用处理+记录原因"。

import { createRequire } from 'node:module';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

const require = createRequire(import.meta.url);

// 有界扫描上限：内核树/asar 都可能很大，探测必须便宜且可中止
const SCAN_MAX_FILES = 600;
const SCAN_MAX_TOTAL_BYTES = 48 * 1024 * 1024;
const SCAN_MAX_FILE_BYTES = 4 * 1024 * 1024;
const SCAN_MAX_DEPTH = 6;
const ASAR_CHUNK = 8 * 1024 * 1024;
const ASAR_OVERLAP = 4096;

export function dshHome(env = process.env) {
  return env.DSH_HOME || join(homedir(), '.dsh');
}

// ── 内核定位 ────────────────────────────────────────────────────────────────
// 定位 @deepseek-ai/dsh 安装根（含 node_modules/@deepseek-ai 一族与 lib/bin.js）。
// 探测顺序：显式 env → profile 解析 → cwd → 各变体已知布局。全部失败返回 null（能力位照常出 unknown）。
export function locateKernelRoot(env = process.env) {
  const candidates = [];
  if (env.DSH_KERNEL_ROOT) candidates.push(env.DSH_KERNEL_ROOT);
  for (const base of [process.cwd(), env.DSH_PROFILE_DIR || '', dshHome(env)]) {
    if (!base) continue;
    try {
      candidates.push(dirname(require.resolve('@deepseek-ai/dsh/package.json', { paths: [base] })));
    } catch { /* 锚点不可解析是常态，继续 */ }
  }
  if (env.APPDATA) candidates.push(join(env.APPDATA, 'npm', 'node_modules', '@deepseek-ai', 'dsh'));
  const local = env.LOCALAPPDATA;
  if (local) {
    candidates.push(join(local, 'Programs', 'DeepSeek Harness', 'resources', 'app.asar.unpacked'));
    candidates.push(join(local, 'Programs', 'DeepSeek Harness', 'resources'));
    candidates.push(join(local, 'Programs', 'Deepseek-Harness-EAC-v5', 'dsh-desktop'));
    candidates.push(join(local, 'Programs', 'DSHEAC-AIO', 'resources', 'app'));
  }
  for (const c of candidates) {
    if (c && looksLikeKernelRoot(c)) return safeRealpath(c);
  }
  return null;
}

function looksLikeKernelRoot(dir) {
  try {
    if (!statSync(dir).isDirectory()) return false;
    if (existsSync(join(dir, 'package.json'))) {
      const pkg = safeJson(join(dir, 'package.json'));
      if (pkg && typeof pkg.name === 'string' && pkg.name.startsWith('@deepseek-ai/dsh')) return true;
    }
    // 官方桌面端 resources/：asar 即内核载体
    return existsSync(join(dir, 'app.asar'));
  } catch { return false; }
}

function safeRealpath(p) { try { return require('node:fs').realpathSync(p); } catch { return p; } }

function safeJson(file) { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } }

// ── 有界文件信号扫描 ────────────────────────────────────────────────────────
// 在内核根（目录树或单一 asar 文件）里找代码指纹。找到第一个 needle 即返回 true。
// 返回 true/false/null（null = 无法判定，如内核根未知或扫描超限）。
export function fsSignal(kernelRoot, needles) {
  if (!kernelRoot) return null;
  try {
    const st = statSync(kernelRoot);
    if (st.isFile()) return asarContains(kernelRoot, needles);
    if (!st.isDirectory()) return null;
    let files = 0, bytes = 0;
    const walk = (dir, depth) => {
      if (depth > SCAN_MAX_DEPTH || files > SCAN_MAX_FILES || bytes > SCAN_MAX_TOTAL_BYTES) return null; // 超限→unknown
      let entries;
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return false; }
      for (const e of entries) {
        if (files > SCAN_MAX_FILES || bytes > SCAN_MAX_TOTAL_BYTES) return null;
        const full = join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name === 'node_modules' && depth > 1) continue; // 内核自带依赖树只浅扫
          const r = walk(full, depth + 1);
          if (r !== false) return r;
        } else if (e.isFile() && (e.name.endsWith('.js') || e.name.endsWith('.mjs') || e.name.endsWith('.cjs'))) {
          files++;
          let sz = 0; try { sz = statSync(full).size; } catch { continue; }
          if (sz > SCAN_MAX_FILE_BYTES) continue;
          bytes += sz;
          let text; try { text = readFileSync(full, 'utf8'); } catch { continue; }
          for (const n of needles) if (text.includes(n)) return true;
        }
      }
      return false;
    };
    const r = walk(kernelRoot, 0);
    return r === null ? null : r;
  } catch { return null; }
}

// asar 是未压缩拼接文件：分块扫描带尾部重叠，避免整读大文件
function asarContains(file, needles) {
  try {
    const st = statSync(file);
    if (st.size > 512 * 1024 * 1024) return null; // 异常超大，不扫
    const fd = require('node:fs').openSync(file, 'r');
    try {
      let tail = Buffer.alloc(0);
      let offset = 0;
      const buf = Buffer.allocUnsafe(ASAR_CHUNK);
      while (offset < st.size) {
        const len = Math.min(ASAR_CHUNK, st.size - offset);
        readFill(fd, buf, len, offset);
        const chunk = Buffer.concat([tail, buf.subarray(0, len)]);
        const text = chunk.toString('latin1'); // 指纹是 ASCII，latin1 保证字节↔字符 1:1
        for (const n of needles) if (text.includes(n)) return true;
        // tail 必须拷贝：buf 是复用缓冲，subarray 视图会被下一轮 readFill 覆盖
        tail = Buffer.from(buf.subarray(Math.max(0, len - ASAR_OVERLAP), len));
        offset += len;
      }
      return false;
    } finally { require('node:fs').closeSync(fd); }
  } catch { return null; }
}

function readFill(fd, buf, len, offset) {
  let read = 0;
  while (read < len) {
    const r = require('node:fs').readSync(fd, buf, read, len - read, offset + read);
    if (r <= 0) break;
    read += r;
  }
}

// ── 宿主协议版本（仅报告用，不作可用性判断） ────────────────────────────────
export function detectHostProtocol(kernelRoot, env = process.env) {
  if (kernelRoot) {
    const manifest = findUpward(kernelRoot, 'bundle-manifest.json') || findUpward(kernelRoot, 'release-manifest.json');
    const m = manifest && safeJson(manifest);
    if (m && m.release && Number.isFinite(m.release.hostProtocolVersion)) return m.release.hostProtocolVersion;
  }
  // 官方桌面端 nightly：app-update.yml / asar 指纹
  if (kernelRoot && kernelRoot.endsWith('resources')) {
    return fsSignal(kernelRoot, ['"hostProtocolVersion":4']) === true ? 4 : null;
  }
  return null;
}

function findUpward(start, name) {
  let dir = start;
  for (let i = 0; i < 4; i++) {
    const p = join(dir, name);
    if (existsSync(p)) return p;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

// 机会式服务读取：cordis 对 ctx 属性访问有 inject 白名单守卫（未声明的属性连读都
// 会抛 "cannot get property X without inject"），ctx.get() 是官方的机会式读取面。
export function peekService(ctx, name) {
  try {
    const v = ctx?.get?.(name);
    return v === undefined || v === null ? null : v;
  } catch { return null; }
}

// ── 主探测 ─────────────────────────────────────────────────────────────────
export async function probeCaps(ctx, env = process.env) {
  const caps = {};
  const set = (k, v) => { caps[k] = v; };

  set('cordis.ctx', !!(ctx && typeof ctx.on === 'function' && typeof ctx.get === 'function'));
  set('dsh.logger', !!peekService(ctx, 'logger') || !!ctx?.logger);
  set('dsh.tools', typeof peekService(ctx, 'tools')?.register === 'function');
  set('dsh.llm', typeof peekService(ctx, 'llm')?.registerAdapter === 'function');
  set('dsh.webserver', typeof peekService(ctx, 'webServer')?.register === 'function');
  set('dsh.agents', !!peekService(ctx, 'agents'));
  set('dsh.settings', typeof peekService(ctx, 'settings')?.register === 'function');

  // defineTool DSL 是否可解析（工具注册的正规路径；不可解析时走手工 ToolDefinition）
  set('dsh.tools.defineToolDsl', moduleSignal('@deepseek-ai/dsh-tools', m => typeof m?.defineTool === 'function', env));

  const kernelRoot = locateKernelRoot(env);
  set('kernel.root', kernelRoot);
  set('kernel.version', kernelRoot ? kernelVersionOf(kernelRoot) : null);

  set('session.v4.strictSources', fsSignal(kernelRoot, ['assertV4MessageSources', 'producer-owned source kind']));
  set('host.protocolVersion', detectHostProtocol(kernelRoot, env));
  set('compat.peerGate', fsSignal(kernelRoot, ['incompatible-version', 'list_version_exemptions']));
  set('client.slotsPackage', kernelRoot
    ? existsSync(join(kernelRoot, 'node_modules', '@deepseek-ai', 'dsh-client-ui-slots')) ||
      fsSignal(kernelRoot, ['dsh-client-ui-slots']) === true
    : null);

  const home = dshHome(env);
  set('eac.extensionsDiscovery', existsSync(join(home, 'extensions', 'registry.json')));
  set('eac.extensionSdk', fsSignal(locateEacDesktop(env), ['provideContext', 'registerTool']) === true);

  set('appboot.evaluatePluginCompatibility', await asyncModuleSignal('@deepseek-ai/dsh-app-boot', m => typeof m?.evaluatePluginCompatibility === 'function', env));

  return caps;
}

function locateEacDesktop(env) {
  const local = env.LOCALAPPDATA;
  if (!local) return null;
  const candidates = [
    join(local, 'Programs', 'Deepseek-Harness-EAC-v5', 'dsh-desktop'),
    join(local, 'Programs', 'Deepseek-Harness-EAC'),
  ];
  return candidates.find(c => existsSync(c)) || null;
}

function kernelVersionOf(root) {
  const pkg = safeJson(join(root, 'package.json'));
  return pkg?.version ?? null;
}

function moduleSignal(spec, predicate, env) {
  try {
    const m = require(resolveFor(spec, env));
    return predicate(m) === true;
  } catch { return null; }
}

async function asyncModuleSignal(spec, predicate, env) {
  try {
    const m = await import(resolveFor(spec, env));
    return predicate(m) === true;
  } catch { return null; }
}

// 从适配器自身与 profile 两个锚点尝试解析内核子包（link 安装解析不到宿主树的经典坑）
function resolveFor(spec, env) {
  const paths = [import.meta.url];
  if (env.DSH_PROFILE_DIR) paths.push(join(env.DSH_PROFILE_DIR, 'package.json'));
  paths.push(join(process.cwd(), 'package.json'));
  return require.resolve(spec, { paths });
}

// EAC Extension Host SDK V1 面模拟：把 isolated-SDK 插件的 activate(ctx) 跑在
// cordis 内核上。API 形状对照 EAC dsh-desktop/lib/extension-host/sdk/index.js
//（见 docs/protocol-chronicle.md §3.4）：
//   ctx = { id, dataDir, log(level,msg), registerTool(name, meta|handler, handler?),
//           on(event, cb) 只读, provideContext(fn), settings{get,set/all},
//           权限门 deny-by-default：net.fetch / fs / shell.exec / env.get }
// 工具经 Core Bridge 语义注册为 `eac_<pluginId>_<name>`；工具名限 [A-Za-z0-9_.-]{1,64}。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

const TOOL_NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const LOG_MAX = 2000;
const CTX_TIMEOUT_MS = 500; // EAC 宿主侧 provideContext 500ms 超时即丢弃

export function createSdkHost({ hostCtx, pluginId, extensionDir, manifest, dshx = null, report = null, logger = null }) {
  const permissions = manifest?.dsh?.extension?.permissions || {};
  const dataDir = join(extensionDir, 'data');
  const toolDisposers = [];
  const provideFns = [];
  let provideSeq = 0;
  const eventDisposers = [];

  const log = (level, msg) => {
    const text = String(msg ?? '').slice(0, LOG_MAX);
    try { (hostCtx.logger?.[level] ?? hostCtx.logger?.info)?.(`[eac:${pluginId}] ${text}`); } catch { /* 日志永不致命 */ }
  };

  // 工具注册：SDK 方言 → ToolDefinition（eac_<id>_<name> 命名，output schema 走
  // 内核接受的 JSON-schema 全形）
  const registerTool = (name, metaOrHandler, handler2) => {
    if (typeof name !== 'string' || !TOOL_NAME_RE.test(name)) {
      throw new Error(`invalid tool name: ${JSON.stringify(name)}`);
    }
    const meta = typeof metaOrHandler === 'function' ? {} : (metaOrHandler || {});
    const handler = typeof metaOrHandler === 'function' ? metaOrHandler : handler2;
    if (typeof handler !== 'function') throw new Error(`tool "${name}" requires a handler`);
    const fullName = `eac_${pluginId}_${name}`;
    const parameters = {};
    for (const [k, v] of Object.entries(meta?.parameters || {})) {
      parameters[k] = { ...(v || {}) };
      if (v && v.required === false) delete parameters[k].required;
    }
    try {
      const dispose = hostCtx.tools.register({
        name: fullName,
        description: meta?.description || '',
        parameters,
        execute: async (args) => ({ text: JSON.stringify((await handler(args)) ?? null) }),
        output: {
          schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } }, required: ['text'] },
          render: (_args, value) => [{ type: 'text', text: value?.text ?? String(value) }],
        },
      });
      toolDisposers.push(typeof dispose === 'function' ? dispose : null);
      return true;
    } catch (err) {
      report?.fallback?.('dsh.tools', `SDK 工具 ${fullName} 注册被内核拒绝: ${err?.message || err}`, pluginId);
      return false;
    }
  };

  // provideContext：SDK 贡献 → dshx 注入桥（producer = dsh-master-key，order 递增对齐 EAC 500+i）
  const provideContext = (fn) => {
    if (typeof fn !== 'function') throw new Error('provideContext requires a function');
    const order = 500 + provideSeq++;
    const wrapped = async () => {
      // EAC 宿主语义：500ms 超时即丢弃
      return await Promise.race([
        Promise.resolve(fn()).then(v => (v == null ? null : String(v))),
        new Promise(resolve => setTimeout(() => resolve(null), CTX_TIMEOUT_MS)),
      ]);
    };
    provideFns.push(wrapped);
    if (dshx?.context?.provide) {
      dshx.context.provide(wrapped, { order, form: 'snapshot' });
      return true;
    }
    return false;
  };

  // 只读事件订阅（Supervisor 广播 → 内核 durable 事件）
  const on = (event, cb) => {
    if (typeof event !== 'string' || typeof cb !== 'function') throw new Error('on(event, cb) requires strings and functions');
    try {
      const dispose = hostCtx.on?.(event, (payload) => {
        try { cb(payload?.payload ?? payload); } catch (e) { log('warn', `event handler error: ${e?.message || e}`); }
      });
      if (typeof dispose === 'function') eventDisposers.push(dispose);
      return true;
    } catch (err) {
      report?.fallback?.('eac-sdk.on', `事件 ${event} 订阅失败: ${err?.message || err}`, pluginId);
      return false;
    }
  };

  // settings：data/settings.json 原子语义（简化：整文件读写）
  const settings = makeSettings(dataDir);

  // 权限门：deny-by-default——未声明的权限面直接缺席（对齐 EAC "字段不存在"语义）
  const gated = {};
  if (permissions.net === true || typeof permissions.net === 'object') {
    const allow = permissions.net === true ? ['*'] : (permissions.net?.allow ?? []);
    gated.net = {
      fetch: async (url, init) => {
        const host = String(url).replace(/^https?:\/\//, '').split('/')[0];
        if (!allow.includes('*') && !allow.some(d => host === d || host.endsWith(`.${d}`))) {
          throw new Error(`net.fetch denied: ${host} not in allowlist`);
        }
        return fetch(url, init);
      },
    };
  }
  if (permissions.fs === true || typeof permissions.fs === 'object') {
    const roots = [dataDir, ...((permissions.fs?.withinRoots ?? []))].map(p => p.replace(/\\/g, '/').toLowerCase());
    const within = (p) => {
      const n = String(p).replace(/\\/g, '/').toLowerCase();
      return roots.some(r => n === r || n.startsWith(r.endsWith('/') ? r : r + '/'));
    };
    gated.fs = {
      readFile: async (p) => { if (!within(p)) throw new Error(`fs denied: ${p} outside roots`); return (await import('node:fs/promises')).readFile(p, 'utf8'); },
      writeFile: async (p, data) => {
        if (!within(p)) throw new Error(`fs denied: ${p} outside roots`);
        const fsp = await import('node:fs/promises');
        await fsp.mkdir(dirname(p), { recursive: true });
        await fsp.writeFile(p, data, 'utf8');
        return true;
      },
      exists: (p) => { if (!within(p)) return false; return existsSync(p); },
    };
  }
  if (permissions.shell === true) {
    gated.shell = {
      exec: async (cmd, timeoutMs = 30_000) => {
        const { execFile } = await import('node:child_process');
        const { promisify } = await import('node:util');
        const run = promisify(execFile);
        // SDK 语义：shell.exec(cmd)——Windows 下经 cmd /c 执行，带超时
        const { stdout } = await run('cmd.exe', ['/c', String(cmd)], { timeout: timeoutMs, windowsHide: true });
        return stdout;
      },
    };
  }
  if (permissions.env === true) {
    gated.env = { get: (k) => process.env[k] };
  }

  const ctx = {
    id: pluginId,
    dataDir,
    log,
    registerTool: registerTool,
    provideContext,
    on,
    settings,
    ...gated,
  };
  return ctx;
}

function makeSettings(dataDir) {
  const file = join(dataDir, 'settings.json');
  const read = () => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return {}; } };
  return {
    get(k, d) { const v = read()[k]; return v === undefined ? d : v; },
    set(k, v) {
      try {
        if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
        const data = read(); data[k] = v;
        writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
        return true;
      } catch { return false; }
    },
    all() { return read(); },
  };
}

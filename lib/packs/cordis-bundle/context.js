// cordis-bundle 的 shim 上下文：给 legacy 插件一个"协议归一"的 ctx 代理。
// 每个 shim 对应 docs/protocol-chronicle.md §4 的一条实证破坏点：
//   1. source-kind   —— 0.2.0 V4 拒收 {kind:'plugin'}；agents 调用与注入桥统一改写 producer-owned kind
//   2. logger        —— EAC SDK 风格 ctx.log(level,msg) 路由到 cordis ctx.logger（cordis 面无 ctx.log）
//   3. settings-scope —— 补 .load() 兼容垫（EAC v5 移除 SettingsScopeController.load()）+ registrations Map
//   4. route-dedup   —— webServer 注册前预检 private 表，重复路由跳过+报告而非抛错拖垮树
//   5. llm-signature —— registerAdapter 参数形态宽容（string/对象形）
//   7. tools SDK 风格 —— registerTool(name, meta, handler) 转换为 ToolDefinition（EAC SDK 方言）

import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);

export function createCompatContext(hostCtx, { caps = {}, report = null, logger = null, pluginName = 'legacy-plugin', strictSources = false } = {}) {
  let userMessageFactory = null;
  let factoryResolved = false;

  async function getUserMessageFactory() {
    if (factoryResolved) return userMessageFactory;
    factoryResolved = true;
    userMessageFactory = await resolveCreateUserMessage();
    if (!userMessageFactory) report?.fallback?.('dsh.llm.createUserMessage', 'dsh-llm 不可解析，注入消息退化为手写结构（producer-owned kind 仍保证）');
    return userMessageFactory;
  }

  const shimCtx = new Proxy(hostCtx, {
    get(t, p) {
      if (p === 'log') return makeEacStyleLog(t, logger, report); // shim 2（不依赖服务对象）
      const svc = Reflect.get(t, p); // 注意：先取服务对象本身，再交给对应 shim
      switch (p) {
        case 'settings':   return svc ? shimSettings(svc, logger, report) : svc;     // shim 3
        case 'webServer':  return svc ? shimWebServer(svc, logger, report) : svc;     // shim 4
        case 'llm':        return svc ? shimLlm(svc, logger, report) : svc;           // shim 5
        case 'agents':     return svc ? shimAgents(svc, { pluginName, strictSources, logger, report }) : svc; // shim 1
        case 'tools':      return svc ? shimTools(svc, { logger, report }) : svc;     // shim 7
        default:           return svc;
      }
    },
  });

  return { ctx: shimCtx, getUserMessageFactory, pluginName };
}

// ── shim 1：注入桥 + 消息 source 归一 ───────────────────────────────────────
// 内核 v4：assertV4MessageSources 拒收 {kind:'plugin'}（"format v4 message requires a
// producer-owned source kind"）。producer-owned kind 在 0.1.x 同样合法（MessageSourceMap
// 可扩展），因此无条件归一是跨代安全的。

export function normalizeMessageSource(msg, producerName) {
  if (!msg || typeof msg !== 'object') return { msg, changed: false };
  const src = msg.source;
  if (src && src.kind === 'plugin') {
    const kind = typeof src.plugin === 'string' && src.plugin ? src.plugin : producerName;
    const source = { ...src, kind };
    delete source.plugin;
    const fixed = { ...msg, source };
    try { Object.freeze(fixed); } catch { /* 冻结失败不影响正确性 */ }
    return { msg: fixed, changed: true };
  }
  return { msg, changed: false };
}

function normalizeDeep(v, producerName, depth = 0) {
  if (depth > 2 || v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(x => normalizeDeep(x, producerName, depth + 1));
  if (v.source && v.source.kind === 'plugin') return normalizeMessageSource(v, producerName).msg;
  return v;
}

// AgentHandle 包装：inject/followup/steer/send 消息参数过 source 归一；handle.agent 递归一层
function wrapHandle(handle, producerName, strictSources, logger, report) {
  if (!handle || typeof handle !== 'object') return handle;
  return new Proxy(handle, {
    get(h, p) {
      const v = Reflect.get(h, p);
      if (p === 'agent') return wrapHandle(v, producerName, strictSources, logger, report);
      if (typeof v === 'function' && ['inject', 'followup', 'steer', 'send'].includes(p)) {
        return function (...args) {
          const fixed = args.map(a => normalizeDeep(a, producerName));
          return v.apply(h, fixed);
        };
      }
      return typeof v === 'function' ? v.bind(h) : v;
    },
  });
}

function shimAgents(agents, { pluginName, strictSources, logger, report }) {
  if (!agents || typeof agents !== 'object') return agents;
  return new Proxy(agents, {
    get(t, p) {
      const v = Reflect.get(t, p);
      if (typeof v !== 'function') return v;
      return function (...args) {
        const fixed = args.map(a => normalizeDeep(a, pluginName));
        let r;
        try { r = v.apply(t, fixed); } catch (err) { report?.fallback?.('dsh.agents', `调用被内核拒绝: ${err?.message || err}`, p); throw err; }
        if (r && typeof r.then === 'function') return r.then(x => wrapHandle(x, pluginName, strictSources, logger, report));
        if (r && typeof r === 'object') return wrapHandle(r, pluginName, strictSources, logger, report);
        return r;
      };
    },
  });
}

// 注入消息构造（镜像记忆生态 buildInjectionMessage：经 0.2.0-rc.2 实机验证的形态）。
// factory 不可解析时退化为手写结构——producer-owned kind 仍然保证。
export function buildInjectionMessage(factory, text, producerName, form = 'snapshot') {
  if (typeof factory === 'function') {
    return factory({
      content: [{ type: 'text', text }],
      source: { kind: producerName, form, sections: [{ name: producerName, text }] },
    });
  }
  const msg = {
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: producerName, form, sections: [{ name: producerName, text }] },
  };
  try { Object.freeze(msg); } catch { /* ignore */ }
  return msg;
}

// 注入桥：dshx.context.provide 的贡献者 → agent/pre-step 追加消息（dsh-time-context 模式，
// 经 0.2.0-rc.2 实机验证的 waterfall 语义：next() 取 decision，返回 {kind:'enter', messages}）。
export function attachContextBridge(hostCtx, contributors, { logger = null, report = null, producerName = 'dsh-compat-core', createUserMessage = null } = {}) {
  if (!hostCtx || typeof hostCtx.on !== 'function' || !Array.isArray(contributors) || contributors.length === 0) return false;
  try {
    hostCtx.on('agent/pre-step', async ({ agent, signal } = {}, next) => {
      const decision = await next();
      if (!decision || decision.kind === 'reject' || signal?.aborted) return decision;
      try {
        const texts = [];
        for (const c of contributors) {
          try {
            const out = await c.fn({ agent });
            const text = typeof out === 'string' ? out : out?.text;
            if (text) texts.push({ text: String(text), order: c.opts?.order ?? 500, form: c.opts?.form || 'snapshot' });
          } catch (e) {
            logger?.debug?.(`[dsh-compat] 贡献者失败（fail-open）: ${e?.message || e}`);
          }
        }
        if (!texts.length) return decision;
        texts.sort((a, b) => a.order - b.order);
        const messages = texts.map(t => buildInjectionMessage(createUserMessage, t.text, producerName, t.form));
        return { kind: 'enter', messages: [...decision.messages, ...messages] };
      } catch (e) {
        logger?.debug?.(`[dsh-compat] 注入桥异常（fail-open）: ${e?.message || e}`);
        return decision;
      }
    }, { prepend: true });
    return true;
  } catch (e) {
    report?.fallback?.('dshx.context.bridge', `agent/pre-step 订阅失败: ${e?.message || e}`);
    return false;
  }
}

// ── shim 2：logger ─────────────────────────────────────────────────────────
function makeEacStyleLog(t, logger, report) {
  // 优先宿主自带的 ctx.logger（cordis 原生路径），其次适配器 logger
  return (level, msg) => {
    const fac = t?.logger ?? logger;
    try { (fac?.[level] ?? fac?.info)?.(msg); } catch { /* 日志永不致命 */ }
  };
}

// ── shim 3：settings ───────────────────────────────────────────────────────
function shimSettings(t, logger, report) {
  if (!t || typeof t !== 'object') return t;
  try {
    if (!('registrations' in t)) {
      try { t.registrations = new Map(); } catch { /* 冻结宿主对象时放弃 */ }
    }
  } catch { /* ignore */ }
  return new Proxy(t, {
    get(tt, p) {
      if (p === 'register' && typeof tt.register === 'function') {
        return (ns, schema, opts) => {
          const scope = tt.register(ns, schema, opts);
          try { tt.registrations?.set?.(ns, scope); } catch { /* ignore */ }
          return wrapScopeCompat(scope);
        };
      }
      return typeof tt[p] === 'function' ? tt[p].bind(tt) : Reflect.get(tt, p);
    },
  });
}

export function wrapScopeCompat(scope) {
  if (!scope || typeof scope !== 'object') return scope;
  return {
    get: (...a) => scope.get(...a),
    watch: (...a) => scope.watch?.(...a),
    patch: (...a) => scope.patch?.(...a),
    replace: (...a) => scope.replace?.(...a),
    describe: (...a) => scope.describe?.(...a),
    load: (...a) => (typeof scope.load === 'function' ? scope.load(...a) : scope.get(...a)), // EAC v5 移除的 load() 兼容垫
    _raw: scope,
  };
}

// ── shim 4：route-dedup ────────────────────────────────────────────────────
function shimWebServer(t, logger, report) {
  if (!t || typeof t !== 'object') return t;
  return new Proxy(t, {
    get(tt, p) {
      if ((p === 'register' || p === 'registerUpgrade' || p === 'registerFallback') && typeof tt[p] === 'function') {
        return (payload) => {
          const kind = p === 'register' ? payload?.kind : p === 'registerUpgrade' ? 'upgrade' : 'fallback';
          const path = payload?.path;
          if (kind && path && routeTableHas(tt, kind, path)) {
            logger?.info?.(`[dsh-compat] route-dedup: ${kind} 路由 ${path} 已被占用，跳过注册`);
            report?.fallback?.(`dsh.webserver.${kind}`, `路由 ${path} 已被占用（dedup 预检跳过）`, path);
            return () => {};
          }
          return tt[p](payload);
        };
      }
      return typeof tt[p] === 'function' ? tt[p].bind(tt) : Reflect.get(tt, p);
    },
  });
}

function routeTableHas(ws, kind, path) {
  const tables = kind === 'upgrade' ? ['upgrades'] : kind === 'prefix' ? ['prefixes'] : ['exact'];
  for (const name of tables) {
    try {
      const table = ws?.[name];
      if (!table) continue;
      if (typeof table.has === 'function' && table.has(path)) return true;
      if (Array.isArray(table) && table.some(r => r?.path === path)) return true;
      if (typeof table === 'object' && table[path] !== undefined) return true;
    } catch { /* private 表不可读 = 放弃预检 */ }
  }
  return false;
}

// ── shim 5：llm 签名 ───────────────────────────────────────────────────────
function shimLlm(t, logger, report) {
  if (!t || typeof t !== 'object') return t;
  return new Proxy(t, {
    get(tt, p) {
      if (p === 'registerAdapter' && typeof tt.registerAdapter === 'function') {
        return (providersOrObj, maybeAdapter) => {
          const { providers, adapter } = normalizeAdapterArgs(providersOrObj, maybeAdapter);
          return tt.registerAdapter(providers, adapter);
        };
      }
      if (p === 'registerConfigurableProviders' && typeof tt.registerConfigurableProviders === 'function') {
        return (entries) => tt.registerConfigurableProviders(Array.isArray(entries) ? entries : [entries]);
      }
      return typeof tt[p] === 'function' ? tt[p].bind(tt) : Reflect.get(tt, p);
    },
  });
}

function normalizeAdapterArgs(providersOrObj, maybeAdapter) {
  if (providersOrObj && typeof providersOrObj === 'object' && !Array.isArray(providersOrObj) && providersOrObj.adapter) {
    let pr = providersOrObj.providers ?? [];
    return { providers: Array.isArray(pr) ? pr : [pr], adapter: providersOrObj.adapter };
  }
  return { providers: Array.isArray(providersOrObj) ? providersOrObj : [providersOrObj], adapter: maybeAdapter };
}

// ── shim 7：tools（EAC SDK registerTool 方言 → ToolDefinition） ────────────
function shimTools(t, { logger, report }) {
  if (!t || typeof t !== 'object') return t;
  return new Proxy(t, {
    get(tt, p) {
      if (p === 'register' && typeof tt.register === 'function') {
        return (...args) => {
          if (typeof args[0] !== 'string') return tt.register(...args); // DSL 原生形态直通
          const [name, metaOrHandler, handler2] = args;
          const meta = typeof metaOrHandler === 'function' ? {} : (metaOrHandler || {});
          const handler = typeof metaOrHandler === 'function' ? metaOrHandler : handler2;
          const def = sdkToolToDefinition(name, meta, handler);
          try {
            return tt.register(def);
          } catch (err) {
            report?.fallback?.('dsh.tools', `SDK 风格工具 ${name} 注册被内核拒绝（fail-open 跳过）: ${err?.message || err}`, name);
            return () => {};
          }
        };
      }
      return typeof tt[p] === 'function' ? tt[p].bind(tt) : Reflect.get(tt, p);
    },
  });
}

function sdkToolToDefinition(name, meta, handler) {
  const parameters = {};
  for (const [k, v] of Object.entries(meta?.parameters || {})) {
    parameters[k] = { ...(v || {}) };
    if (v && v.required === false) delete parameters[k].required;
  }
  return {
    name,
    description: meta?.description || '',
    parameters,
    execute: async (args) => ({ text: JSON.stringify((await handler(args)) ?? null) }),
    output: {
      schema: { text: { type: 'string', required: true } },
      render: (_args, value) => [{ type: 'text', text: value?.text ?? String(value) }],
    },
  };
}

// ── createUserMessage 解析（宿主树锚点，镜像记忆生态 importHostModule 的经验） ──
async function resolveCreateUserMessage(env = process.env) {
  const home = env.DSH_HOME || join(env.USERPROFILE || '', '.dsh');
  const roots = [
    env.DSHX_HOST_MODULES,
    env.DSH_PROFILE_DIR ? join(env.DSH_PROFILE_DIR, 'node_modules') : null,
    join(home, 'profiles', 'node_modules'),
    process.cwd(),
  ].filter(Boolean);
  for (const root of roots) {
    try {
      const req = createRequire(join(root, '_resolve_.js'));
      const entry = req.resolve('@deepseek-ai/dsh-llm');
      const mod = await import(pathToFileURL(entry).href);
      if (typeof mod?.createUserMessage === 'function') return mod.createUserMessage;
    } catch { /* 下一个锚点 */ }
  }
  return null;
}

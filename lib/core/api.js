// dshx 稳定 API v1：新插件对它写，跨变体通用；legacy 插件经协议包包装后也拿到它。
// 设计约束：本文件保持内核无知——凡涉及内核事件语义的接线（如注入桥）归协议包，这里只存贡献者与提供统一面。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ok, unavailable, isEnvelope } from './envelope.js';

export const DSHX_API_VERSION = 1;

export function createDshx({ ctx, caps, variant, packs = [], report, home, logger }) {
  const cap = name => (name in caps ? caps[name] : null);

  const contributors = []; // context.provide 贡献者：由协议包接线上内核事件
  const privateStore = makeFileStore(home ? join(home, 'dshx', 'data') : null, 'dshx.json');

  const dshx = {
    meta: Object.freeze({
      id: 'dshx',
      apiVersion: DSHX_API_VERSION,
      variant: variant?.id ?? 'unknown',
      packs: packs.map(p => ({ id: p.id, version: p.version, source: p.source })),
    }),

    capabilities: {
      has: name => cap(name) === true,
      get: name => cap(name),
      all: () => ({ ...caps }),
    },

    log: logger,

    // ── 工具注册：归一 defineTool DSL 与 EAC SDK registerTool 两种方言 ──
    tools: {
      define(spec) {
        if (!ctx?.tools?.register) {
          return unavailable('dsh.tools', '宿主无 ctx.tools.register');
        }
        const normalized = normalizeToolSpec(spec);
        try {
          const dispose = ctx.tools.register(normalized);
          return ok({ name: normalized.name ?? spec.name, dispose: typeof dispose === 'function' ? dispose : null });
        } catch (err) {
          return unavailable('dsh.tools', `注册被内核拒绝: ${err?.message || err}`, { name: spec?.name });
        }
      },
    },

    // ── 每回合上下文贡献：贡献者入队，注入接线由协议包完成 ──
    context: {
      provide(fn, opts = {}) {
        if (typeof fn !== 'function') return unavailable('dshx.context.provide', '贡献者必须是函数');
        const entry = { fn, opts: { form: opts.form || 'notice', summary: opts.summary, order: Number.isFinite(opts.order) ? opts.order : 500 } };
        contributors.push(entry);
        return ok({ registered: true, dispose: () => { const i = contributors.indexOf(entry); if (i >= 0) contributors.splice(i, 1); } });
      },
      _contributors: contributors, // 协议包接线用（下划线 = 非公开契约）
    },

    events: {
      on(name, cb) {
        if (!ctx || typeof ctx.on !== 'function') return unavailable('cordis.ctx', '宿主无 ctx.on');
        try {
          const dispose = ctx.on(name, cb);
          return ok(true, typeof dispose === 'function' ? { disposable: true } : undefined);
        } catch (err) {
          return unavailable('cordis.ctx', `事件订阅被拒绝: ${err?.message || err}`, { event: name });
        }
      },
    },

    // ── 设置：宿主 settings 面可用则走宿主（带 scope 兼容包装），否则私有文件兜底 ──
    settings: {
      ns(nsName, schema, opts = {}) {
        if (cap('dsh.settings')) {
          try {
            const scope = ctx.settings.register(nsName, schema, opts);
            return ok(wrapScope(scope));
          } catch (err) {
            return unavailable('dsh.settings', `注册命名空间被拒绝: ${err?.message || err}`, { ns: nsName });
          }
        }
        return ok(makeFileNamespace(join(home || process.cwd(), 'dshx', 'data'), nsName), { degradedTo: 'file' });
      },
      get: (k, d) => privateStore.get(k, d),
      set: (k, v) => privateStore.set(k, v),
    },

    // ── LLM：参数形态宽容（string→[string]，{providers, adapter} 对象形） ──
    llm: {
      registerAdapter(providersOrObj, maybeAdapter) {
        if (!cap('dsh.llm')) return unavailable('dsh.llm', '宿主无 ctx.llm.registerAdapter');
        const { providers, adapter } = normalizeAdapterArgs(providersOrObj, maybeAdapter);
        try { return ok(ctx.llm.registerAdapter(providers, adapter)); } catch (err) {
          return unavailable('dsh.llm', `registerAdapter 被拒绝: ${err?.message || err}`, { providers });
        }
      },
      registerConfigurableProviders(entries) {
        if (!cap('dsh.llm')) return unavailable('dsh.llm', '宿主无 ctx.llm');
        try { return ok(ctx.llm.registerConfigurableProviders(entries)); } catch (err) {
          return unavailable('dsh.llm', `registerConfigurableProviders 被拒绝: ${err?.message || err}`);
        }
      },
      registerModelDiscovery(settingsNs, discover) {
        if (!cap('dsh.llm')) return unavailable('dsh.llm', '宿主无 ctx.llm');
        try { return ok(ctx.llm.registerModelDiscovery(settingsNs, discover)); } catch (err) {
          return unavailable('dsh.llm', `registerModelDiscovery 被拒绝: ${err?.message || err}`, { settingsNs });
        }
      },
    },

    // ── 路由：内置 dedup 预检（private 表形态宽容：Map/Set/对象） ──
    routes: {
      exact(path, handler) { return registerRoute('exact', path, handler); },
      prefix(path, handler) { return registerRoute('prefix', path, handler); },
      upgrade(path, handler) { return registerRoute('upgrade', path, handler); },
    },

    // ── UI：v0.1 诚实降级（客户端半插槽需要 client.js 载体，v0.2 提供） ──
    ui: {
      slot(name) {
        report?.fallback('dshx.ui.slot', '客户端半插槽需要 client.js 载体（v0.2 提供）', name);
        return unavailable('dshx.ui.slot', '客户端半插槽需要 client.js 载体（v0.2 提供）', { slot: name });
      },
    },
  };

  function registerRoute(kind, path, handler) {
    if (!cap('dsh.webserver')) return unavailable('dsh.webserver', '宿主无 ctx.webServer');
    if (routeExists(kind, path)) {
      report?.fallback(`dsh.webserver.${kind}`, `路由 ${path} 已被占用，跳过注册（dedup 预检）`, path);
      return ok({ skipped: true, reason: 'duplicate' });
    }
    try {
      const payload = kind === 'upgrade'
        ? { kind: 'upgrade', path, handler }
        : { kind, path, handler };
      const dispose = ctx.webServer.register(payload);
      return ok({ registered: true, dispose: typeof dispose === 'function' ? dispose : null });
    } catch (err) {
      return unavailable(`dsh.webserver.${kind}`, `注册被拒绝: ${err?.message || err}`, { path });
    }
  }

  function routeExists(kind, path) {
    const ws = ctx.webServer;
    const tables = kind === 'upgrade' ? ['upgrades'] : kind === 'prefix' ? ['prefixes'] : ['exact'];
    for (const t of tables) {
      try {
        const table = ws?.[t];
        if (!table) continue;
        if (typeof table.has === 'function' && table.has(path)) return true;
        if (Array.isArray(table) && table.some(r => r?.path === path)) return true;
        if (typeof table === 'object' && table[path] !== undefined) return true;
      } catch { /* private 表不可读 = 放弃预检，交内核报错 */ }
    }
    return false;
  }

  return dshx;
}

// ── helpers ─────────────────────────────────────────────────────────────────

function normalizeToolSpec(spec) {
  const parameters = {};
  for (const [k, v] of Object.entries(spec?.parameters || {})) {
    parameters[k] = { ...(v || {}) };
    if (v && v.required === false) delete parameters[k].required; // DSL 语义：可选参数必须省略 required
  }
  return {
    name: spec.name,
    description: spec.description || '',
    parameters,
    execute: spec.execute,
    // output.schema 用内核接受的 JSON-schema 全形（subset: type/oneOf/properties/
    // required/additionalProperties/items/enum/const + annotations）
    output: spec.output || {
      schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } }, required: ['text'] },
      render: (args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value ?? null) }],
    },
  };
}

function normalizeAdapterArgs(providersOrObj, maybeAdapter) {
  if (providersOrObj && typeof providersOrObj === 'object' && !Array.isArray(providersOrObj) && providersOrObj.adapter) {
    return { providers: toArray(providersOrObj.providers ?? providersOrObj.providers_ ?? []), adapter: providersOrObj.adapter };
  }
  return { providers: toArray(providersOrObj), adapter: maybeAdapter };
}

function toArray(v) { return Array.isArray(v) ? v : v == null ? [] : [v]; }

// scope 兼容包装：补 .load()（EAC v5 移除 SettingsScopeController.load() 的对位），
// 保证 get/watch 可用；不动宿主对象。
function wrapScope(scope) {
  if (!scope || typeof scope !== 'object') return scope;
  const wrapped = {
    get: (...a) => scope.get(...a),
    watch: (...a) => scope.watch?.(...a),
    patch: (...a) => scope.patch?.(...a),
    replace: (...a) => scope.replace?.(...a),
    describe: (...a) => scope.describe?.(...a),
    load: (...a) => (typeof scope.load === 'function' ? scope.load(...a) : scope.get(...a)), // 兼容垫
    _raw: scope,
  };
  return wrapped;
}

function makeFileNamespace(dir, ns) {
  const store = makeFileStore(dir, `${ns}.json`);
  return {
    get: (k, d) => store.get(k, d),
    set: (k, v) => store.set(k, v),
    watch: () => () => {},
  };
}

function makeFileStore(dir, fileName) {
  const file = dir && join(dir, fileName);
  const read = () => {
    if (!file || !existsSync(file)) return {};
    try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return {}; }
  };
  return {
    get(k, d) { const v = read()[k]; return v === undefined ? d : v; },
    set(k, v) {
      if (!file) return false;
      try {
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        const data = read(); data[k] = v;
        writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
        return true;
      } catch { return false; }
    },
  };
}

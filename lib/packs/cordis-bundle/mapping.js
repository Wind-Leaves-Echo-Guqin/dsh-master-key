// cordis-bundle 协议包：官方 cordis 静态面（bundle patch / ctx 服务 / client inject）的兼容实现。
// 所有 shim 的依据见 docs/protocol-chronicle.md §4 实证破坏点表。

import { evalSignals } from '../../core/bus.js';
import { createCompatContext, attachContextBridge } from './context.js';
import { unavailable } from '../../core/envelope.js';

export default {
  async probeHost(ctx) {
    if (!ctx || typeof ctx.on !== 'function') return { ok: false, reason: '无 cordis context' };
    return { ok: true, caps: {} };
  },

  // 认领度：官方 cordis 形态特征加权（manifest bundle patch 最强信号）
  async canSpeak(plugin) {
    const hits = await evalSignals([
      { kind: 'manifestField', path: 'dsh.bundle.patch', weight: 2 },
      { kind: 'entryExport', value: 'apply', weight: 1 },
      { kind: 'entryExport', value: 'activate', weight: 1 },
      { kind: 'importSpecifier', value: '@deepseek-ai/', weight: 1 },
    ], plugin);
    return hits >= 2 ? Math.min(hits, 3) : 0;
  },

  // 包装激活：给 legacy 插件一个 shim 过的 context，并接上 dshx 注入贡献者。
  async wrapActivate(plugin, hostCtx, opts = {}) {
    const { caps = {}, report = null, logger = null, config = {}, dshx = null } = opts;
    const compat = createCompatContext(hostCtx, {
      caps, report, logger,
      pluginName: plugin.manifest?.name || 'legacy-plugin',
      strictSources: caps['session.v4.strictSources'] === true, // 探测到 V4 校验才强制改写
      dshx,
    });

    // dshx.context.provide 的贡献者在此接线上内核（agent/pre-step，dsh-time-context 模式）。
    // 注意时机：此时兼容目标还没跑（贡献者数组此刻多半为空），必须传数组引用——
    // 桥在事件触发时才读贡献者。createUserMessage 工厂按需解析（宿主树锚点）。
    if (Array.isArray(dshx?.context?._contributors)) {
      attachContextBridge(hostCtx, dshx.context._contributors, {
        logger, report,
        producerName: 'dsh-compat-core',
        getUserMessageFactory: compat.getUserMessageFactory,
      });
    }

    if (typeof plugin.entry.apply === 'function') {
      return { activated: true, mode: 'apply', result: await plugin.entry.apply(compat.ctx, config) };
    }
    // EAC SDK 风格 activate(ctx)：单参，兼容面走同一 shim 上下文
    return { activated: true, mode: 'activate', result: await plugin.entry.activate(compat.ctx) };
  },

  degrade(capability, reason) {
    return unavailable(`cordis-bundle.${capability}`, reason);
  },
};

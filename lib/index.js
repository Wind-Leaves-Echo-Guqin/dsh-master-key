// dsh-compat 适配器入口：声明 dsh.bundle.patch 的 cordis 插件（唯一绑内核点）。
// apply(ctx, config)：
//   探测（能力位+变体）→ 载入协议包 → 暴露 dshx 稳定 API → 启动协议包 → 挂载兼容目标 → 报告落盘。
// fail-open：自身初始化失败返回不可用信封，不抛错（boot 断言会因抛错连坐整棵插件树）。

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dshHome, probeCaps } from './core/caps.js';
import { loadVariants, detectVariant, classifyUnknown } from './core/variant.js';
import { loadPacks } from './core/bus.js';
import { createDshx, DSHX_API_VERSION } from './core/api.js';
import { createReport } from './core/report.js';
import { makeLogger } from './core/logger.js';
import { mountCompatTarget } from './compat-loader.js';
import { ok, unavailable } from './core/envelope.js';

const ADAPTER_VERSION = '0.1.0';

export async function apply(ctx, config = {}) {
  const env = process.env;
  const report = createReport({ home: dshHome(env), logger: ctx?.logger });

  try {
    const caps = await probeCaps(ctx, env);
    const variants = loadVariants(config.variantDirs);
    let variant = detectVariant(variants, env);
    if (variant.id === 'unknown') {
      const classified = classifyUnknown(env);
      report.event('variant-unknown', { classified });
    }

    const packs = await loadPacks({ caps, env, extraDirs: config.packDirs, report });
    const logger = makeLogger(ctx, report);
    const dshx = createDshx({ ctx, caps, variant, packs, report, home: dshHome(env), logger });

    exposeDshx(ctx, dshx, report);

    report.setMatrix({
      adapter: { version: ADAPTER_VERSION, apiVersion: DSHX_API_VERSION },
      variant: { id: variant.id, family: variant.descriptor?.family ?? null, tested: variant.descriptor?.tested ?? 'unknown' },
      kernel: { version: caps['kernel.version'], root: caps['kernel.root'], hostProtocol: caps['host.protocolVersion'] },
      caps,
      packs: packs.map(p => ({ id: p.id, version: p.version, source: p.source })),
      targets: (config.targets || []).map(t => t.name || t.path || '<anonymous>'),
    });
    logger.info(`dsh-compat ${ADAPTER_VERSION} 激活：variant=${variant.id} kernel=${caps['kernel.version'] ?? '?'} packs=[${packs.map(p => p.id).join(',') || '无'}] caps=${Object.entries(caps).filter(([, v]) => v === true).length} 项可用`);

    // 协议包自启（如 eac-sdk 的 extensions 发现面）
    for (const p of packs) {
      if (typeof p.mapping.start === 'function') {
        try { await p.mapping.start({ ctx, caps, dshx, report, variant, logger, config }); } catch (err) {
          report.event('pack-start-failed', { pack: p.id, reason: String(err?.message || err) });
        }
      }
    }

    // 挂载兼容目标：config.targets → env DSHX_TARGETS → $DSH_HOME/dshx/config.json
    const targets = resolveTargets(config, env);
    const results = [];
    for (const t of targets) {
      results.push(await mountCompatTarget(t, { hostCtx: ctx, packs, caps, report, logger, dshx }));
    }

    report.flush();
    return ok({ dshx, caps, variant: variant.id, packs: packs.map(p => p.id), targets: results });
  } catch (err) {
    report.quarantine({ plugin: 'dsh-compat', pack: null, error: err, caps: {} });
    report.flush();
    return unavailable('dshx.bootstrap', `适配器初始化失败（已隔离，不影响插件树）: ${err?.message || err}`);
  }
}

function exposeDshx(ctx, dshx, report) {
  try { if (typeof ctx.provide === 'function') ctx.provide('dshx', dshx); } catch { /* provide 不可用不致命 */ }
  try {
    if (!('dshx' in ctx)) {
      Object.defineProperty(ctx, 'dshx', { value: dshx, configurable: true, enumerable: false });
    }
  } catch { /* ctx 冻结时不强求 */ }
}

// 目标来源优先级：apply config.targets → env DSHX_TARGETS(JSON) → $DSH_HOME/dshx/config.json targets
function resolveTargets(config, env) {
  if (Array.isArray(config.targets) && config.targets.length > 0) return config.targets;
  if (env.DSHX_TARGETS) {
    try { const t = JSON.parse(env.DSHX_TARGETS); if (Array.isArray(t)) return t; } catch { /* 坏 env 忽略 */ }
  }
  const cfgFile = join(dshHome(env), 'dshx', 'config.json');
  if (existsSync(cfgFile)) {
    try {
      const cfg = JSON.parse(readFileSync(cfgFile, 'utf8'));
      if (Array.isArray(cfg.targets)) return cfg.targets;
    } catch { /* 坏配置忽略 */ }
  }
  return [];
}

export { mountCompatTarget, loadPacks, probeCaps, detectVariant, loadVariants, createDshx, createReport };

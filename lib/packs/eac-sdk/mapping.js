// eac-sdk 协议包：isolated-SDK 插件的模拟宿主 + extensions/registry 发现面。
// 发现面语义对照 EAC：$DSH_HOME/extensions/<id>/package/ + registry.json（kind=isolated）。

import { existsSync, readdirSync, readFileSync, cpSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { evalSignals } from '../../core/bus.js';
import { createSdkHost } from './host.js';

const require = createRequire(import.meta.url);

export default {
  async probeHost(ctx) {
    if (!ctx || typeof ctx.on !== 'function') return { ok: false, reason: '无 cordis context' };
    return { ok: true, caps: {} };
  },

  async canSpeak(plugin) {
    const hits = await evalSignals([
      { kind: 'manifestField', path: 'dsh.extension', weight: 3 },
      { kind: 'entryExport', value: 'activate', weight: 1 },
    ], plugin);
    return hits >= 3 ? hits : 0; // 只有声明 dsh.extension 的才算 SDK 插件
  },

  async wrapActivate(plugin, hostCtx, opts = {}) {
    const { report = null, logger = null, config = {}, dshx = null, caps = {} } = opts;
    const manifest = plugin.manifest || {};
    const pluginId = manifest.name || 'sdk-plugin';
    // extensionDir：优先 EAC 布局（<home>/extensions/<id>/），否则落在插件目录旁
    const extensionDir = config.extensionDir || join(dirname(plugin.sourcePath), 'extension-data');
    const host = createSdkHost({
      hostCtx, pluginId, extensionDir, manifest, dshx, report, logger,
    });
    const result = await plugin.entry.activate(host);
    report?.event?.('eac-sdk-activated', { plugin: pluginId });
    return { activated: true, mode: 'eac-sdk', result };
  },

  // 发现面：扫描 $DSH_HOME/extensions/ + registry.json，把 enabled 的 isolated 插件
  // 经总线挂载（在官方端复活 EAC 插件）。
  async start({ ctx, caps, dshx, report, logger, config, packs }) {
    const home = config?.home || process.env.DSH_HOME;
    if (!home || caps['eac.extensionsDiscovery'] !== true) {
      report?.event?.('eac-sdk-discovery-skip', { reason: '无 extensions 发现面（registry.json 不存在）' });
      return { discovered: 0 };
    }
    const extRoot = join(home, 'extensions');
    let registry = null;
    try { registry = JSON.parse(readFileSync(join(extRoot, 'registry.json'), 'utf8')); } catch { registry = null; }
    const enabledIds = new Set(
      Object.values(registry?.plugins || {})
        .filter(p => p.enabled === true && p.kind === 'isolated')
        .map(p => p.id),
    );
    let discovered = 0;
    let activated = 0;
    for (const id of enabledIds) {
      const pkgFile = join(extRoot, id, 'package', 'package.json');
      if (!existsSync(pkgFile)) { report?.event?.('eac-sdk-extension-missing', { plugin: id }); continue; }
      discovered++;
      const { mountCompatTarget } = await import('../../compat-loader.js');
      const r = await mountCompatTarget(
        { name: id, path: join(extRoot, id, 'package', 'index.js'), protocol: 'eac-sdk', config: { extensionDir: join(extRoot, id) } },
        { hostCtx: ctx, packs, caps, report, logger: logger, dshx },
      );
      if (r?.ok) activated++;
    }
    report?.event?.('eac-sdk-discovery', { discovered, activated });
    return { discovered, activated };
  },
};

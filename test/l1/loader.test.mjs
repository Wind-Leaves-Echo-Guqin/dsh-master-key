import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mountCompatTarget } from '../../lib/compat-loader.js';
import { isUnavailable } from '../../lib/core/envelope.js';
import { createReport } from '../../lib/core/report.js';

// 夹具：CJS legacy 插件（用 EAC 风格 ctx.log —— cordis 面不存在的方法，由 toy 包的 ctx 代理归一）
function writeLegacyPlugin(dir) {
  const p = join(dir, 'legacy-logger-plugin');
  mkdirSync(p, { recursive: true });
  writeFileSync(join(p, 'package.json'), JSON.stringify({
    name: 'legacy-logger-plugin', version: '1.0.0', main: 'index.cjs',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }));
  writeFileSync(join(p, 'index.cjs'), `
'use strict';
module.exports.apply = function apply(ctx) {
  ctx.log('warn', 'legacy-warn-through-proxy');      // EAC SDK 风格：cordis 面会炸的写法
  if (ctx.tools && ctx.tools.register) {
    ctx.tools.register({ name: 'legacy_tool', execute: async () => ({ text: 'legacy-ok' }) });
  }
  return 'activated';
};
`);
  return p;
}

function writeToyPack(dir, { id = 'toy-pack', signalName = 'legacy-logger-plugin' } = {}) {
  const packDir = join(dir, id);
  mkdirSync(packDir, { recursive: true });
  writeFileSync(join(packDir, 'descriptor.json'), JSON.stringify({
    packFormat: 1, id, version: '0.0.1',
    requiresHostCaps: [], pluginSignals: [{ kind: 'manifestField', path: 'name', value: signalName }],
  }));
  writeFileSync(join(packDir, 'mapping.js'), `
export default {
  async probeHost() { return { ok: true }; },
  canSpeak(plugin) { return plugin.manifest?.name === ${JSON.stringify(signalName)} ? 1 : 0; },
  async wrapActivate(plugin, hostCtx, opts) {
    const wrapped = new Proxy(hostCtx, {
      get(t, p) {
        if (p === 'log') return (level, msg) => (t.logger?.[level] ?? t.logger?.info)?.(msg);
        return Reflect.get(t, p);
      },
    });
    const r = await plugin.entry.apply(wrapped, opts?.config);
    return { legacyReturn: r };
  },
  degrade(capability, reason) { return { ok: false, unavailable: true, capability, reason }; },
};
`);
  return packDir;
}

async function loadPacksFrom(dir) {
  const { loadPacks } = await import('../../lib/core/bus.js');
  return loadPacks({ extraDirs: [dir], env: { DSH_HOME: dir } });
}

test('mountCompatTarget：CJS legacy 插件经 toy 包包装激活，ctx.log 归一到 logger', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dshcompat-loader-'));
  try {
    const pluginPath = writeLegacyPlugin(dir);
    writeToyPack(dir);
    const packs = await loadPacksFrom(dir);
    const report = createReport({});
    const logCalls = [];
    const hostCtx = {
      on: () => () => {}, get: () => undefined,
      logger: { info: () => {}, warn: (m) => logCalls.push(m), error: () => {}, debug: () => {} },
      tools: { register: () => () => {} },
    };
    const r = await mountCompatTarget({ path: pluginPath }, { hostCtx, packs, caps: {}, report, logger: console });
    assert.equal(r.ok, true, `应为 ok: ${JSON.stringify(r)}`);
    assert.equal(r.detail.pack, 'toy-pack');
    assert.equal(r.value.legacyReturn, 'activated');
    assert.deepEqual(logCalls, ['legacy-warn-through-proxy']); // ctx.log('warn') → logger.warn
    assert.ok(report.events.some(e => e.kind === 'compat-activated'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('mountCompatTarget：目标插件抛错 → quarantine 信封，不外抛', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dshcompat-loader2-'));
  try {
    const p = join(dir, 'exploding-plugin');
    mkdirSync(p, { recursive: true });
    writeFileSync(join(p, 'package.json'), JSON.stringify({ name: 'exploding-plugin', main: 'index.cjs' }));
    writeFileSync(join(p, 'index.cjs'), "module.exports.apply = () => { throw new Error('legacy boom'); };");
    writeToyPack(dir, { id: 'toy-exploding', signalName: 'exploding-plugin' });
    const packs = await loadPacksFrom(dir);
    const report = createReport({});
    const r = await mountCompatTarget({ path: join(p, 'index.cjs') }, {
      hostCtx: { on: () => () => {}, logger: { info() {}, warn() {}, error() {}, debug() {} } },
      packs, caps: {}, report, logger: console,
    });
    assert.equal(isUnavailable(r), true);
    assert.equal(r.capability, 'dshx.compat.activate');
    const q = report.events.find(e => e.kind === 'quarantine');
    assert.ok(q, '应记录 quarantine');
    assert.ok(q.error.message.includes('legacy boom'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('mountCompatTarget：无人认领 → quarantine + 信封（禁止静默）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dshcompat-loader3-'));
  try {
    const p = join(dir, 'mystery-plugin');
    mkdirSync(p, { recursive: true });
    writeFileSync(join(p, 'package.json'), JSON.stringify({ name: 'mystery-plugin', main: 'index.cjs' }));
    writeFileSync(join(p, 'index.cjs'), 'module.exports.apply = () => "x";');
    writeToyPack(dir); // 只认领 legacy-logger-plugin，mystery-plugin 无人认领
    const packs = await loadPacksFrom(dir);
    const report = createReport({});
    const r = await mountCompatTarget({ path: join(p, 'index.cjs') }, {
      hostCtx: { logger: { info() {}, warn() {}, error() {}, debug() {} } },
      packs, caps: {}, report, logger: console,
    });
    assert.equal(isUnavailable(r), true);
    assert.equal(r.capability, 'dshx.compat.negotiate');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPacks, negotiate, evalSignals } from '../../lib/core/bus.js';
import { createReport } from '../../lib/core/report.js';

// toy pack：同时是"第三方协议包可扩展性"的验收原型
function writeToyPack(dir, { id = 'toy-pack', signalName = 'legacy-logger-plugin' } = {}) {
  const packDir = join(dir, id);
  mkdirSync(packDir, { recursive: true });
  writeFileSync(join(packDir, 'descriptor.json'), JSON.stringify({
    packFormat: 1, id, version: '0.0.1', summary: 'toy',
    requiresHostCaps: [], pluginSignals: [{ kind: 'manifestField', path: 'name', value: signalName }],
  }));
  writeFileSync(join(packDir, 'mapping.js'), `
export default {
  async probeHost() { return { ok: true, caps: {} }; },
  canSpeak(plugin) { return plugin.manifest?.name === ${JSON.stringify(signalName)} ? 1 : 0; },
  async wrapActivate(plugin, hostCtx, opts) {
    const wrapped = new Proxy(hostCtx, {
      get(t, p) {
        if (p === 'log') return (level, msg) => (t.logger?.[level] ?? t.logger?.info)?.(msg);
        return Reflect.get(t, p);
      },
    });
    const r = await plugin.entry.apply(wrapped, opts?.config);
    return { wrapped: true, result: r };
  },
  degrade(capability, reason) { return { ok: false, unavailable: true, capability, reason }; },
};
`);
  return packDir;
}

function writeBadPack(dir) {
  const packDir = join(dir, 'bad-pack');
  mkdirSync(packDir, { recursive: true });
  writeFileSync(join(packDir, 'descriptor.json'), JSON.stringify({ packFormat: 99, id: 'bad-pack' }));
  writeFileSync(join(packDir, 'mapping.js'), 'export default {};');
  return packDir;
}

test('loadPacks：toy 包载入；非法 packFormat 被拒并报告', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dshcompat-bus-'));
  try {
    writeToyPack(dir);
    writeBadPack(dir);
    const report = createReport({});
    const packs = await loadPacks({ extraDirs: [dir], report, env: { DSH_HOME: dir } });
    assert.deepEqual(packs.map(p => p.id), ['toy-pack']);
    const kinds = report.events.map(e => e.kind);
    assert.ok(kinds.includes('pack-load-failed'), '应报告非法包');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('loadPacks：requiresHostCaps 不满足 → 跳过', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dshcompat-bus2-'));
  try {
    const packDir = writeToyPack(dir);
    const { readFileSync, writeFileSync: wf } = await import('node:fs');
    const d = JSON.parse(readFileSync(join(packDir, 'descriptor.json'), 'utf8'));
    d.requiresHostCaps = ['dsh.tools'];
    wf(join(packDir, 'descriptor.json'), JSON.stringify(d));
    const withoutTools = await loadPacks({ caps: {}, extraDirs: [dir], env: { DSH_HOME: dir } });
    assert.deepEqual(withoutTools.map(p => p.id), []);
    const withTools = await loadPacks({ caps: { 'dsh.tools': true }, extraDirs: [dir], env: { DSH_HOME: dir } });
    assert.deepEqual(withTools.map(p => p.id), ['toy-pack']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('negotiate：最高认领分胜出；无人认领 → null + 报告', async () => {
  const plugin = { manifest: { name: 'legacy-logger-plugin' }, entry: {}, sourceText: '' };
  const other = { manifest: { name: 'unknown-thing' }, entry: {}, sourceText: '' };
  const pack = {
    id: 'toy', version: '0.0.1', descriptor: {},
    mapping: { canSpeak: async p => (p.manifest.name === 'legacy-logger-plugin' ? 2 : 0) },
  };
  const report = createReport({});
  assert.equal((await negotiate([pack], plugin)).pack.id, 'toy');
  assert.equal(await negotiate([pack], other, { report }), null);
  assert.ok(report.events.some(e => e.kind === 'no-pack-claimed'));
});

test('evalSignals：manifestField / entryExport / importSpecifier', async () => {
  const plugin = { manifest: { name: 'x', dsh: { bundle: { patch: './cordis.patch.yml' } } }, entry: { apply: () => {} }, sourceText: "import { createUserMessage } from '@deepseek-ai/dsh-llm';" };
  assert.equal(await evalSignals([{ kind: 'manifestField', path: 'dsh.bundle.patch' }], plugin), 1);
  assert.equal(await evalSignals([{ kind: 'entryExport', value: 'apply' }], plugin), 1);
  assert.equal(await evalSignals([{ kind: 'importSpecifier', value: '@deepseek-ai/dsh-llm' }], plugin), 1);
  assert.equal(await evalSignals([{ kind: 'manifestField', path: 'nope.deep' }], plugin), 0);
});

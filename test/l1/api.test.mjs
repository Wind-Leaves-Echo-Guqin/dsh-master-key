import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDshx } from '../../lib/core/api.js';
import { unavailable, isUnavailable } from '../../lib/core/envelope.js';

function mockCtx(over = {}) {
  const registered = [];
  const routes = [];
  return {
    registered, routes,
    on: () => () => {},
    get: () => undefined,
    provide: (name, v) => over._provided = { [name]: v },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    tools: { register: def => { registered.push(def); return () => {}; } },
    llm: { registerAdapter: (providers, adapter) => ({ providers, adapter }) },
    webServer: {
      register: r => { routes.push(r); return () => {}; },
      exact: new Map([['/taken', () => {}]]),
      prefixes: new Map(),
    },
    agents: {},
    settings: { register: () => ({ get: () => 'from-host' }) },
    ...over,
  };
}

test('dshx.tools.define：可选参数省略 required；注册走宿主', () => {
  const ctx = mockCtx();
  const dshx = createDshx({ ctx, caps: { 'dsh.tools': true, 'dsh.tools.defineToolDsl': false }, variant: { id: 'test' }, report: null, logger: { info() {}, warn() {}, error() {}, debug() {} } });
  const r = dshx.tools.define({ name: 't1', parameters: { a: { type: 'string', required: true }, b: { type: 'string', required: false } }, execute: async () => ({ text: 'ok' }) });
  assert.equal(r.ok, true);
  const def = ctx.registered[0];
  assert.equal(def.parameters.a.required, true);
  assert.ok(!('required' in def.parameters.b), '可选参数必须省略 required（defineTool DSL 语义）');
  assert.deepEqual(def.output.render(null, { text: 'hi' }), [{ type: 'text', text: '{"text":"hi"}' }]);
});

test('dshx.tools.define：宿主无 tools → 显式信封', () => {
  const dshx = createDshx({ ctx: mockCtx({ tools: undefined }), caps: {}, variant: { id: 't' }, report: null, logger: { info() {}, warn() {}, error() {}, debug() {} } });
  const r = dshx.tools.define({ name: 't' });
  assert.equal(isUnavailable(r), true);
  assert.equal(r.capability, 'dsh.tools');
});

test('dshx.routes：dedup 预检命中 → skipped 且不进宿主', () => {
  const ctx = mockCtx();
  const dshx = createDshx({ ctx, caps: { 'dsh.webserver': true }, variant: { id: 't' }, report: null, logger: { info() {}, warn() {}, error() {}, debug() {} } });
  const r1 = dshx.routes.exact('/taken', () => {});
  assert.equal(r1.value.skipped, true);
  assert.equal(ctx.routes.length, 0);
  const r2 = dshx.routes.exact('/free', () => {});
  assert.equal(r2.value.registered, true);
  assert.equal(ctx.routes.length, 1);
});

test('dshx.llm.registerAdapter：字符串/对象参数形态归一', () => {
  const ctx = mockCtx();
  const dshx = createDshx({ ctx, caps: { 'dsh.llm': true }, variant: { id: 't' }, report: null, logger: { info() {}, warn() {}, error() {}, debug() {} } });
  const adapter = { stream: async function* () {} };
  const a = dshx.llm.registerAdapter('p1', adapter);
  assert.deepEqual(a.value.providers, ['p1']);
  const b = dshx.llm.registerAdapter({ providers: 'p2', adapter });
  assert.deepEqual(b.value.providers, ['p2']);
  assert.equal(b.value.adapter, adapter);
});

test('dshx.settings：宿主无 settings → 文件兜底（带 degradedTo 标记）', () => {
  const home = mkdtempSync(join(tmpdir(), 'dshcompat-api-'));
  try {
    const dshx = createDshx({ ctx: mockCtx({ settings: undefined }), caps: {}, variant: { id: 't' }, report: null, home, logger: { info() {}, warn() {}, error() {}, debug() {} } });
    const r = dshx.settings.ns('test.ns', {});
    assert.equal(r.ok, true);
    assert.equal(r.detail.degradedTo, 'file');
    assert.equal(existsSync(join(home, 'dshx', 'data', 'test.ns.json')), false); // 惰性落盘
    r.value.set('k', 'v');
    assert.equal(r.value.get('k'), 'v');
    assert.equal(existsSync(join(home, 'dshx', 'data', 'test.ns.json')), true);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('dshx.settings：私有 store 落盘原子可读', () => {
  const home = mkdtempSync(join(tmpdir(), 'dshcompat-api2-'));
  try {
    const dshx = createDshx({ ctx: mockCtx(), caps: { 'dsh.settings': true }, variant: { id: 't' }, report: null, home, logger: { info() {}, warn() {}, error() {}, debug() {} } });
    dshx.settings.set('echoCount', 3);
    assert.equal(dshx.settings.get('echoCount', 0), 3);
    assert.equal(dshx.settings.get('missing', 'dflt'), 'dflt');
    const raw = JSON.parse(readFileSync(join(home, 'dshx', 'data', 'dshx.json'), 'utf8'));
    assert.equal(raw.echoCount, 3);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('dshx.context.provide：贡献者入队与 dispose', () => {
  const dshx = createDshx({ ctx: mockCtx(), caps: {}, variant: { id: 't' }, report: null, logger: { info() {}, warn() {}, error() {}, debug() {} } });
  const r = dshx.context.provide(() => 'ctx-text', { form: 'snapshot' });
  assert.equal(r.ok, true);
  assert.equal(dshx.context._contributors.length, 1);
  assert.equal(dshx.context._contributors[0].opts.form, 'snapshot');
  r.value.dispose();
  assert.equal(dshx.context._contributors.length, 0);
});

test('dshx.ui.slot：v0.1 诚实降级', () => {
  const dshx = createDshx({ ctx: mockCtx(), caps: {}, variant: { id: 't' }, report: null, logger: { info() {}, warn() {}, error() {}, debug() {} } });
  const r = dshx.ui.slot('sidebar');
  assert.equal(isUnavailable(r), true);
  assert.ok(r.reason.includes('v0.2'));
});

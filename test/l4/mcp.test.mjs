// L4：out-of-process 协议包——用真实 spawn 的 MCP stdio server 验证
// 握手 → 工具枚举 → 注册进 ctx.tools → tools/call 往返。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPacks, negotiate } from '../../lib/core/bus.js';
import { mountCompatTarget } from '../../lib/compat-loader.js';
import { createReport } from '../../lib/core/report.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, '..', 'fixtures', 'mcp-echo-server.mjs');

function mockHostCtx() {
  const registered = [];
  return {
    registered,
    on: () => () => {},
    get: () => undefined,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    tools: { register: (def) => { registered.push(def); return () => {}; } },
  };
}

async function builtinPacks() {
  return loadPacks({ caps: { 'cordis.ctx': true }, env: { DSH_HOME: 'C:/nonexistent-dshx-test' } });
}

test('L4：canSpeak 认领 dsh.mcp 声明的插件；cordis 形态不认领', async () => {
  const packs = await builtinPacks();
  const pack = packs.find(p => p.id === 'out-of-process');
  assert.ok(pack, 'out-of-process 包应随内置载入');
  const mcpPlugin = { manifest: { name: 'x', dsh: { mcp: { servers: { a: { command: 'node' } } } } }, entry: {} };
  const cordisPlugin = { manifest: { name: 'y', dsh: { bundle: { patch: './p.yml' } } }, entry: { apply: () => {} } };
  assert.equal(await pack.mapping.canSpeak(mcpPlugin), 3);
  assert.equal(await pack.mapping.canSpeak(cordisPlugin), 0);
  const pick = await negotiate(packs, mcpPlugin);
  assert.equal(pick.pack.id, 'out-of-process');
});

test('L4：MCP 握手 + 工具注册 + tools/call 往返（真实子进程）', async () => {
  const dir = join(HERE, '..', 'tmp');
  const pluginDir = join(dir, 'mcp-sample-plugin');
  const { mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  mkdirSync(pluginDir, { recursive: true });
  try {
    writeFileSync(join(pluginDir, 'package.json'), JSON.stringify({
      name: 'mcp-sample-plugin', version: '0.1.0', main: 'index.js',
      dsh: { mcp: { servers: { demo: { command: process.execPath, args: [SERVER] } } } },
    }));
    writeFileSync(join(pluginDir, 'index.js'), "export function apply() {}");
    const packs = await builtinPacks();
    const report = createReport({});
    const hostCtx = mockHostCtx();
    const r = await mountCompatTarget({ path: join(pluginDir, 'index.js') }, { hostCtx, packs, caps: {}, report, logger: console });
    assert.equal(r.ok, true, `mount 应成功: ${JSON.stringify(r).slice(0, 300)}`);
    assert.equal(r.value.mode, 'mcp');
    assert.deepEqual(hostCtx.registered.map(d => d.name), ['mcp_demo_echo']);
    const def = hostCtx.registered[0];
    assert.equal(def.parameters.msg.required, true);
    const out = await def.execute({ msg: '你好' });
    assert.ok(JSON.stringify(out).includes('mcp-echo:你好'));
    assert.ok(report.events.some(e => e.kind === 'mcp-server-ready'));
    assert.ok(report.events.some(e => e.kind === 'mcp-tool-registered'));
    r.value._dispose(); // 释放子进程，不卡测试事件循环
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('L4：MCP server 握手失败 → fail-open 跳过并报告', async () => {
  const dir = join(HERE, '..', 'tmp2');
  const pluginDir = join(dir, 'mcp-broken-plugin');
  const { mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  mkdirSync(pluginDir, { recursive: true });
  try {
    writeFileSync(join(pluginDir, 'package.json'), JSON.stringify({
      name: 'mcp-broken-plugin', version: '0.1.0', main: 'index.js',
      dsh: { mcp: { servers: { dead: { command: process.execPath, args: ['-e', 'process.exit(1)'] } } } },
    }));
    writeFileSync(join(pluginDir, 'index.js'), "export function apply() {}");
    const packs = await builtinPacks();
    const report = createReport({});
    const hostCtx = mockHostCtx();
    const r = await mountCompatTarget({ path: join(pluginDir, 'index.js') }, { hostCtx, packs, caps: {}, report, logger: console });
    assert.equal(r.ok, true, '握手失败 fail-open 不拖垮挂载');
    assert.deepEqual(hostCtx.registered, []);
    assert.ok(report.events.some(e => e.kind === 'fallback' && String(e.reason || '').includes('dead')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// L4：EAC Extension Host SDK V1 面模拟——用真实的 sample-sdk-plugin（本机
// ~/.dsh/extensions/ 活体，只读挂载）在模拟宿主上复活。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { createSdkHost } from '../../lib/packs/eac-sdk/host.js';
import { createDshx } from '../../lib/core/api.js';
import { createReport } from '../../lib/core/report.js';

const SAMPLE_ENTRY = 'C:/Users/qy160/.dsh/extensions/sample-sdk-plugin/package/index.js';
const SAMPLE_MANIFEST = 'C:/Users/qy160/.dsh/extensions/sample-sdk-plugin/package/package.json';

const require = createRequire(import.meta.url);

function mockHostCtx() {
  const registered = [];
  const listeners = {};
  return {
    registered, listeners,
    tools: { register: (def) => { registered.push(def); return () => {}; } },
    on: (name, cb) => { (listeners[name] ??= []).push(cb); return () => {}; },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  };
}

test('L4：真实 sample-sdk-plugin 在模拟宿主上复活（工具/设置/贡献/事件）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dshcompat-l4-'));
  try {
    const entry = require(SAMPLE_ENTRY); // CJS，exports.activate
    const manifest = JSON.parse(readFileSync(SAMPLE_MANIFEST, 'utf8'));
    assert.equal(typeof entry.activate, 'function');

    const hostCtx = mockHostCtx();
    const report = createReport({});
    const logger = { info() {}, warn() {}, error() {}, debug() {} };
    const dshx = createDshx({
      ctx: { on: (n, cb) => hostCtx.on(n, cb), get: () => undefined },
      caps: {}, variant: { id: 'test' }, packs: [], report, home: dir, logger,
    });
    const sdkCtx = createSdkHost({
      hostCtx, pluginId: 'sample-sdk-plugin', extensionDir: join(dir, 'ext'), manifest, dshx, report, logger,
    });

    const r = entry.activate(sdkCtx);
    assert.equal(r, undefined, 'sample activate 正常返回');

    // 工具注册：eac_<id>_<name>
    const names = hostCtx.registered.map(d => d.name).sort();
    assert.deepEqual(names, ['eac_sample-sdk-plugin_echo', 'eac_sample-sdk-plugin_status']);

    // echo 工具执行 + settings 持久化（调用计数）
    const echo = hostCtx.registered.find(d => d.name.endsWith('_echo'));
    const out = await echo.execute({ msg: '你好' });
    assert.ok(JSON.stringify(out).includes('你好'));
    assert.equal(sdkCtx.settings.get('echoCount', 0), 1);

    // 贡献者进入注入桥
    assert.equal(dshx.context._contributors.length, 1);

    // 事件订阅
    assert.ok(hostCtx.listeners['turn-end']?.length === 1);

    // settings 落盘
    assert.equal(existsSync(join(dir, 'ext', 'data', 'settings.json')), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('L4：deny-by-default 权限门（未声明 = 字段缺席）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dshcompat-l4b-'));
  try {
    const hostCtx = mockHostCtx();
    const sdkCtx = createSdkHost({
      hostCtx, pluginId: 'p', extensionDir: join(dir, 'ext'),
      manifest: { dsh: { extension: { permissions: {} } } },
    });
    assert.equal(sdkCtx.net, undefined, 'net 未声明 → 缺席');
    assert.equal(sdkCtx.fs, undefined);
    assert.equal(sdkCtx.shell, undefined);
    assert.equal(sdkCtx.env, undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('L4：权限声明后的白名单语义（fs withinRoots）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dshcompat-l4c-'));
  try {
    const hostCtx = mockHostCtx();
    const sdkCtx = createSdkHost({
      hostCtx, pluginId: 'p', extensionDir: join(dir, 'ext'),
      manifest: { dsh: { extension: { permissions: { fs: { withinRoots: [join(dir, 'allow')] } } } } },
    });
    await sdkCtx.fs.writeFile(join(dir, 'allow', 'a.txt'), 'x');
    assert.equal(sdkCtx.fs.exists(join(dir, 'allow', 'a.txt')), true);
    await assert.rejects(() => sdkCtx.fs.writeFile(join(dir, 'deny', 'a.txt'), 'x'), /outside roots/);
    await assert.rejects(() => sdkCtx.fs.readFile('C:/Windows/win.ini'), /outside roots/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('L4：工具名非法即抛（SDK 校验语义）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dshcompat-l4d-'));
  try {
    const sdkCtx = createSdkHost({
      hostCtx: mockHostCtx(), pluginId: 'p', extensionDir: join(dir, 'ext'), manifest: {},
    });
    assert.throws(() => sdkCtx.registerTool('bad name!', () => ({})), /invalid tool name/);
    assert.throws(() => sdkCtx.registerTool('x'.repeat(65), () => ({})), /invalid tool name/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

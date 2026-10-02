// L3-mcp：把声明 dsh.mcp.servers 的夹具插件经适配器挂进隔离探针，验证
// out-of-process 协议包在真内核上完成 MCP 握手并注册工具。用法：
//   node scripts/run-mcp.mjs [内核版本，缺省 0.2.0-rc.2]

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareProbe, bootProbe, homeDir, kernelRoot } from '../test/l3/lib.mjs';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const version = process.argv[2] || '0.2.0-rc.2';

if (!existsSync(join(kernelRoot(version), 'lib', 'bin.js'))) { console.error(`内核 ${version} 未安装`); process.exit(2); }

console.log(`准备探针（内核 ${version}）…`);
const prep = prepareProbe(version);
if (!prep.ok) { console.error(`准备失败：${prep.step}`); process.exit(1); }

// MCP 夹具作为兼容目标（config.json 来源；server 的相对路径以仓库根为 cwd 解析）
mkdirSync(join(prep.home, 'dshx'), { recursive: true });
writeFileSync(join(prep.home, 'dshx', 'config.json'), JSON.stringify({
  targets: [{ path: join(REPO, 'test', 'fixtures', 'mcp-sample-plugin', 'index.js').replace(/\\/g, '/') }],
}, null, 2), 'utf8');

console.log('启动…');
const boot = await bootProbe(version, { mockPatch: prep.mockPatch, job: 'mcp probe job' });
console.log(`boot exit=${boot.code}`);

const incidentsFile = join(homeDir(version), 'dshx', 'incidents.jsonl');
const events = existsSync(incidentsFile)
  ? readFileSync(incidentsFile, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
  : [];

const ready = events.find(e => e.kind === 'mcp-server-ready');
const toolReg = events.some(e => e.kind === 'mcp-tool-registered' && e.tool === 'mcp_demo_echo');
const activated = events.some(e => e.kind === 'compat-activated' && String(e.plugin || '').includes('mcp-sample-plugin'));

const checks = [
  ['plugin-activated', activated],
  ['mcp-server-ready', !!ready, JSON.stringify(ready || {})],
  ['tool-registered', toolReg],
];

let failed = 0;
console.log('\n=== mcp 探针 ===');
for (const [name, pass, detail] of checks) {
  if (!pass) failed++;
  console.log(`${pass ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}
process.exit(failed > 0 ? 1 : 0);

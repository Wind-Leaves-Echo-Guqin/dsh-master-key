// L3-eac：把真实 sample-sdk-plugin 装进隔离探针 home 的 extensions/ 发现面，
// 验证 eac-sdk 协议包在官方内核上复活 EAC isolated 插件。用法：
//   node scripts/run-eac-sdk.mjs [内核版本，缺省 0.2.0-rc.2]

import { existsSync, mkdirSync, writeFileSync, cpSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { prepareProbe, bootProbe, homeDir, kernelRoot } from '../test/l3/lib.mjs';

const version = process.argv[2] || '0.2.0-rc.2';
const LIVE_SAMPLE = 'C:/Users/qy160/.dsh/extensions/sample-sdk-plugin';

if (!existsSync(join(kernelRoot(version), 'lib', 'bin.js'))) { console.error(`内核 ${version} 未安装`); process.exit(2); }
if (!existsSync(LIVE_SAMPLE)) { console.error('本机未找到 sample-sdk-plugin 活体'); process.exit(2); }

console.log(`准备探针（内核 ${version}）…`);
const prep = prepareProbe(version);
if (!prep.ok) { console.error(`准备失败：${prep.step}`); process.exit(1); }

// 装配 EAC 发现面：extensions/<id>/package + registry.json（kind=isolated, enabled）
const extId = 'sample-sdk-plugin';
const extDir = join(homeDir(version), 'extensions', extId);
mkdirSync(extDir, { recursive: true });
cpSync(join(LIVE_SAMPLE, 'package'), join(extDir, 'package'), { recursive: true });
mkdirSync(join(extDir, 'data'), { recursive: true });
writeFileSync(join(homeDir(version), 'extensions', 'registry.json'), JSON.stringify({
  schemaVersion: 1,
  plugins: {
    [extId]: {
      id: extId, version: '1.0.0', source: 'market', risk: 'isolated-sdk',
      kind: 'isolated', packageSha256: '', permissions: {}, rollbackVersions: [],
      installedAt: new Date().toISOString(), state: 'installed', enabled: true, crashStreak: 0,
    },
  },
}, null, 2), 'utf8');

console.log('启动…');
const boot = await bootProbe(version, { mockPatch: prep.mockPatch, job: 'eac sdk probe job' });
console.log(`boot exit=${boot.code}`);

const incidentsFile = join(homeDir(version), 'dshx', 'incidents.jsonl');
const events = existsSync(incidentsFile)
  ? readFileSync(incidentsFile, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
  : [];

const discovery = events.filter(e => e.kind === 'eac-sdk-discovery').at(-1);
const activated = events.some(e => e.kind === 'eac-sdk-activated' && e.plugin === extId);
const settingsFile = join(extDir, 'data', 'settings.json');
const settingsOk = existsSync(settingsFile) && JSON.parse(readFileSync(settingsFile, 'utf8')).startedAt;

const checks = [
  ['discovery-ran', !!discovery, JSON.stringify(discovery || {})],
  ['discovered-1', discovery?.discovered === 1],
  ['activated-1', discovery?.activated === 1],
  ['extension-activated', activated],
  ['settings-written', !!settingsOk],
];

let failed = 0;
console.log('\n=== eac-sdk 探针 ===');
for (const [name, pass, detail] of checks) {
  if (!pass) failed++;
  console.log(`${pass ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}
process.exit(failed > 0 ? 1 : 0);

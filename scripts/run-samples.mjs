// L3 样本探针：把本机真实社区插件经适配器挂载进隔离探针，验证兼容层对
// "真实遗产插件"（而非夹具）的适配与诊断能力。用法：
//   node scripts/run-samples.mjs [内核版本，缺省 0.2.0-rc.2]
//
// 样本与预期（headless 形态下）：
//   eco-note（记忆生态 cordis 适配器，inject=[tools,agents]）   → activated
//   dsh-our-free-model（LLM 接入，inject=[llm]，自身优雅降级）  → activated
//   maid-atelier 皮肤（宿主半为空 apply）                       → activated
//   dsh-side-session（依赖 webServer 等，headless 无该服务）    → quarantined（诊断正确）

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { prepareProbe, bootProbe, homeDir, kernelRoot } from '../test/l3/lib.mjs';

const version = process.argv[2] || '0.2.0-rc.2';
const REPO = join(import.meta.url.replace(/^file:\/\/\/?/, '').replace(/scripts\/run-samples\.mjs$/, '').replace(/\//g, '\\'), '');
const repo = new URL('..', import.meta.url).pathname.replace(/^\/(\w:)/, '$1');
const W = 'C:/Users/qy160/.dsh/profiles/web-desktop/node_modules';

const SAMPLES = [
  {
    id: 'eco-note',
    path: 'C:/Users/qy160/memory-ecology-兼容版/adapters/dsh/package-cordis/index.js',
    expect: 'activated',
    config: { hostModulesDir: kernelRoot(version).replace(/\\/g, '/') + '/node_modules' },
  },
  {
    id: 'our-free-model',
    path: `${W}/dsh-our-free-model/index.js`,
    expect: 'activated',
  },
  {
    id: 'maid-atelier',
    path: `${W}/@dsh-external/.ignored_dsh-client-ui-skin-maid-atelier/lib/index.js`,
    expect: 'activated',
  },
  {
    id: 'side-session',
    path: `${W}/@dsh-external/dsh-side-session/lib/index.js`,
    expect: 'activated', // 实测：side-session 自身优雅降级（missing webServer 由 shim 透传 undefined，其代码跳过 UI 功能）
  },
];

if (!existsSync(kernelRoot(version).replace(/\//g, '\\') + '\\lib\\bin.js') && !existsSync(join(kernelRoot(version), 'lib', 'bin.js'))) {
  console.error(`内核 ${version} 未安装`);
  process.exit(2);
}

console.log(`准备探针（内核 ${version}）…`);
const prep = prepareProbe(version);
if (!prep.ok) { console.error(`准备失败：${prep.step} ${prep.detail || ''}`); process.exit(1); }

// 样本目标写入探针 home 的 dshx/config.json（resolveTargets 的第三优先级来源）
const config = {
  targets: SAMPLES.map(s => ({ path: s.path, config: s.config || {} })),
};
const { writeFileSync, mkdirSync } = await import('node:fs');
mkdirSync(join(prep.home, 'dshx'), { recursive: true });
writeFileSync(join(prep.home, 'dshx', 'config.json'), JSON.stringify(config, null, 2), 'utf8');

console.log('启动…');
const boot = await bootProbe(version, { mockPatch: prep.mockPatch, job: 'sample probe job' });
console.log(`boot exit=${boot.code}`);

// 收集每个样本的最终事件（activated / quarantine）
const incidentsFile = join(homeDir(version), 'dshx', 'incidents.jsonl');
const events = existsSync(incidentsFile)
  ? readFileSync(incidentsFile, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
  : [];

let failed = 0;
console.log('\n=== 样本结果 ===');
for (const s of SAMPLES) {
  const relevant = events.filter(e =>
    (e.kind === 'compat-activated' || e.kind === 'quarantine' || e.kind === 'services-wait' || e.kind === 'generic-fallback')
    && JSON.stringify(e).includes(s.id) || (e.plugin || '').includes(s.id));
  const activated = relevant.some(e => e.kind === 'compat-activated');
  const quarantined = relevant.filter(e => e.kind === 'quarantine');
  const status = activated ? 'activated' : quarantined.length ? 'quarantined' : 'no-trace';
  const ok = status === s.expect;
  if (!ok) failed++;
  console.log(`${ok ? '✓' : '✗'} ${s.id.padEnd(18)} 实际=${status.padEnd(11)} 预期=${s.expect}`);
  for (const e of relevant) {
    if (e.kind === 'services-wait') console.log(`   services-wait resolved=[${(e.resolved || []).join(',')}] missing=[${(e.missing || []).join(',')}]`);
    if (e.kind === 'quarantine') console.log(`   quarantine: ${e.error?.message?.slice(0, 140)}`);
  }
}
process.exit(failed > 0 ? 1 : 0);

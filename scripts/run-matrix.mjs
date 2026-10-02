// L3 矩阵驱动：对每代已安装内核跑一次完整探针，输出汇总表。用法：
//   node scripts/run-matrix.mjs [版本...]   # 缺省 = 全部已安装版本
// 退出码：任一 FAIL → 1。

import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installedVersions, ALL_VERSIONS, prepareProbe, bootProbe, assertProbe } from '../test/l3/lib.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const requested = process.argv.slice(2);
const versions = requested.length > 0 ? requested : installedVersions();

if (versions.length === 0) {
  console.error('没有已安装的内核（test/kernels/k-<version>）。先运行安装。');
  process.exit(2);
}

let failed = 0;
const rows = [];
for (const v of versions) {
  const isCustom = /[\\/]/.test(v); // 绝对路径 = 任意安装的内核（如 EAC 私有内核）
  if (!isCustom && !ALL_VERSIONS.includes(v)) { console.error(`未知版本 ${v}`); process.exit(2); }
  if (!installedVersions().includes(v) && !isCustom) { rows.push({ v, status: 'SKIP(未安装)' }); continue; }
  process.stdout.write(`[${v}] 准备…`);
  const prep = prepareProbe(v);
  if (!prep.ok) {
    rows.push({ v, status: `FAIL(准备.${prep.step})` });
    failed++;
    console.log(` 失败：${prep.step} ${prep.detail || ''}`);
    continue;
  }
  process.stdout.write(' 启动…');
  const boot = await bootProbe(v, { mockPatch: prep.mockPatch, fixturePath: join(REPO, 'test', 'fixtures', 'probe-fixture', 'index.cjs') });
  const result = assertProbe(v, boot);
  rows.push({ v, status: result.pass ? 'PASS' : 'FAIL', ...result });
  if (!result.pass) failed++;
  console.log(result.pass ? ' 通过' : ` 失败（${result.total - result.passed}/${result.total} 项不过）`);
  for (const c of result.checks) {
    if (!c.pass) console.log(`    ✗ ${c.name} — ${c.detail}`);
  }
}

console.log('\n=== L3 矩阵汇总 ===');
for (const r of rows) console.log(`${r.v.padEnd(14)} ${r.status}`);
process.exit(failed > 0 ? 1 : 0);

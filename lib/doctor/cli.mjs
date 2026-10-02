// doctor：装前体检。对一个插件目录跑静态兼容性检查，输出 dsh-doctor/v1 风格信封
//（pass | warn | fail | skip，对齐 RFC #1846 社区契约）。
//
// 用法：node lib/doctor/cli.mjs <插件目录> [--kernel <版本>]
// 检查项（对应 cordis-bundle 的三条 doctor 级 shim）：
//   1. manifest 结构（dsh.bundle.patch / 入口可解析）
//   2. client inject 缺包识别（slots 等）
//   3. peerDependencies 与内核的兼容判定（advisory；0.2.0+ 的强制以内核为准）
//   4. plugin-guard 静态规则扫描（TROJAN_* 镜像）

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { detectClientInjectIssues, checkPeerGate, scanGuardPatterns } from '../packs/cordis-bundle/doctor.js';

// ── 库接口 ─────────────────────────────────────────────────────────────────
export function checkPlugin(pluginDir, { kernelVersion = null, caps = {} } = {}) {
  const checks = [];
  const pkgFile = join(pluginDir, 'package.json');
  if (!existsSync(pkgFile)) {
    return { envelope: 'fail', plugin: pluginDir, checks: [{ id: 'manifest', status: 'fail', detail: 'package.json 不存在' }] };
  }
  let manifest;
  try { manifest = JSON.parse(readFileSync(pkgFile, 'utf8')); } catch (e) {
    return { envelope: 'fail', plugin: manifest?.name || pluginDir, checks: [{ id: 'manifest', status: 'fail', detail: `package.json 解析失败: ${e.message}` }] };
  }

  // 1. manifest 结构
  const hasBundlePatch = !!manifest?.dsh?.bundle?.patch;
  const entryFile = resolveEntry(pluginDir, manifest);
  checks.push({
    id: 'manifest.bundle.patch',
    status: hasBundlePatch ? 'pass' : 'warn',
    detail: hasBundlePatch ? `patch=${manifest.dsh.bundle.patch}` : '无 dsh.bundle.patch——经适配器挂载可运行，但不会被官方组合树独立激活',
  });
  checks.push({
    id: 'entry',
    status: entryFile ? 'pass' : 'fail',
    detail: entryFile || 'main 入口不存在',
  });

  // 2. client inject
  for (const issue of detectClientInjectIssues(manifest, caps)) {
    checks.push({ id: `client.${issue.code}`, status: issue.level === 'warn' ? 'warn' : 'skip', detail: issue.message });
  }

  // 3. peer-gate
  if (kernelVersion) {
    for (const p of checkPeerGate(manifest, kernelVersion)) {
      checks.push({
        id: `peer.${p.name}`,
        status: p.compatible ? 'pass' : 'warn',
        detail: `声明 ${p.range}，运行内核 ${p.runtimeVersion}${p.compatible ? '' : '（区间外；0.2.0+ 会被内核强制拒绝，可考虑 compatibility.json 豁免）'}`,
      });
    }
  } else {
    checks.push({ id: 'peer', status: 'skip', detail: '未指定内核版本，跳过 peer 判定' });
  }

  // 4. guard 扫描（入口 + src 常见位置，有界）
  const sources = collectSources(pluginDir, entryFile);
  const guardHits = [];
  for (const src of sources) {
    for (const hit of scanGuardPatterns(src.text)) {
      guardHits.push({ file: src.file, rule: hit.rule, excerpt: hit.excerpt.slice(0, 100) });
    }
  }
  checks.push({
    id: 'guard.scan',
    status: guardHits.length ? 'warn' : 'pass',
    detail: guardHits.length
      ? guardHits.map(h => `${h.file}:${h.rule}`).join('; ') + '（镜像 EAC plugin-guard 规则；可能误报，安装到 EAC 系壳前先自查）'
      : '未命中已知守卫规则',
  });

  const hasFail = checks.some(c => c.status === 'fail');
  const hasWarn = checks.some(c => c.status === 'warn');
  return {
    envelope: hasFail ? 'fail' : hasWarn ? 'warn' : 'pass',
    plugin: manifest.name || pluginDir,
    kernelVersion,
    checks,
    checkedAt: new Date().toISOString(),
  };
}

function resolveEntry(pluginDir, manifest) {
  const main = manifest?.main || 'index.js';
  for (const cand of [main, `${main}.js`, 'index.js', 'lib/index.js']) {
    const p = join(pluginDir, cand);
    try { if (statSync(p).isFile()) return p; } catch { /* 继续 */ }
  }
  return null;
}

const SOURCE_LIMIT = 24;
function collectSources(pluginDir, entryFile) {
  const out = [];
  const seen = new Set();
  const push = (f) => {
    if (seen.has(f) || out.length >= SOURCE_LIMIT) return;
    try { if (statSync(f).isFile() && statSync(f).size < 1024 * 1024) { seen.add(f); out.push({ file: f, text: readFileSync(f, 'utf8') }); } } catch { /* 跳过 */ }
  };
  push(entryFile);
  for (const sub of ['src', 'lib']) {
    const d = join(pluginDir, sub);
    try {
      for (const f of readdirSync(d)) if (f.endsWith('.js')) push(join(d, f));
    } catch { /* 无该目录 */ }
  }
  return out;
}

// ── CLI ────────────────────────────────────────────────────────────────────
if (process.argv[1] && process.argv[1].endsWith('cli.mjs')) {
  const args = process.argv.slice(2);
  const dir = args[0];
  const kernelIdx = args.indexOf('--kernel');
  const kernelVersion = kernelIdx >= 0 ? args[kernelIdx + 1] : null;
  if (!dir) {
    console.error('用法：node lib/doctor/cli.mjs <插件目录> [--kernel <版本>]');
    process.exit(2);
  }
  const result = checkPlugin(dir, { kernelVersion });
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.envelope === 'fail' ? 1 : 0);
}

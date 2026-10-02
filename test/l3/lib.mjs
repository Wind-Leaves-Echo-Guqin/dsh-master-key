// L3 矩阵探针库：对一代内核做"隔离 DSH_HOME + headless one-shot + mock LLM"的端到端验证。
// 安全红线：只用 test/probes/<v> 下的隔离 DSH_HOME，绝不触碰 live ~/.dsh 与在跑实例。

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const KERNELS = join(REPO, 'test', 'kernels');
const PROBES = join(REPO, 'test', 'probes');

export const ALL_VERSIONS = ['0.1.0-rc.7', '0.1.1-rc.2', '0.1.2-rc.1', '0.1.5-rc.1', '0.1.7-rc.2', '0.2.0-rc.2'];

export function kernelRoot(v) {
  // 绝对路径支持：直接探测任意安装的内核（如 EAC 私有内核 0.1.2-alpha.1）
  if (/[\\/]/.test(v) && existsSync(join(v, 'lib', 'bin.js'))) return v;
  return join(KERNELS, `k-${v}`, 'node_modules', '@deepseek-ai', 'dsh');
}
export function labelFor(v) { return `v-${v.replace(/[^a-z0-9._-]/gi, '_')}`; }
export function homeDir(v) { return join(PROBES, labelFor(v), 'home'); }
export function kernelInstalled(v) { return existsSync(join(kernelRoot(v), 'lib', 'bin.js')); }
export function installedVersions() { return ALL_VERSIONS.filter(kernelInstalled); }

function binJs(v) { return join(kernelRoot(v), 'lib', 'bin.js'); }

function toWin(p) { return p.replace(/\//g, '\\'); }

// ── 上游依赖漂移修补（活案例，记入 protocol-chronicle.md）─────────────────
// 内核 0.1.1-rc.2 的 dsh-app-boot 期望 hmr.registerConfig（1.0.16 提供），
// 但 ^1.0.16 语义让今天安装会拉到 1.0.19（已移除该方法）→ 带 patch 层启动必炸。
// 判定驱动（非版本号驱动）：app-boot 源码引用 registerConfig 而已装 hmr 缺失时钉回 1.0.16。
function pinHmrIfNeeded(v) {
  const root = kernelRoot(v);
  const nm = join(root, '..', '..'); // k-<v>/node_modules
  const scopeDir = dirname(root);    // k-<v>/node_modules/@deepseek-ai
  try {
    // app-boot 通常与 dsh 同级；版本冲突时会被 npm 嵌套进 dsh 自己的 node_modules
    const appBootCandidates = [join(scopeDir, 'dsh-app-boot', 'lib', 'index.js'), join(root, 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js')];
    const appBootFile = appBootCandidates.find(f => existsSync(f));
    if (!appBootFile) return { ok: true, reason: 'app-boot 未找到，跳过钉版判定（该内核可能不依赖 registerConfig）' };
    const appBootSrc = readFileSync(appBootFile, 'utf8');
    if (!appBootSrc.includes('registerConfig')) return { ok: true, reason: 'app-boot 不需要 registerConfig' };
    const hmrTypes = join(nm, '@deepseek-ai', 'cordis-plugin-hmr', 'lib', 'types', 'index.d.ts');
    if (existsSync(hmrTypes) && readFileSync(hmrTypes, 'utf8').includes('registerConfig')) {
      return { ok: true, reason: '已装 hmr 自带 registerConfig' };
    }
    const npmCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    const r = runNode([npmCli, 'install', '@deepseek-ai/cordis-plugin-hmr@1.0.16', '--prefix', join(KERNELS, `k-${v}`), '--no-audit', '--no-fund', '--loglevel=error'], {}, { timeoutMs: 120_000 });
    const okAfter = existsSync(hmrTypes) && readFileSync(hmrTypes, 'utf8').includes('registerConfig');
    return { ok: okAfter, reason: okAfter ? '已钉回 1.0.16' : `钉版失败 exit=${r.code} ${r.stderr.slice(-200)}` };
  } catch (e) {
    return { ok: false, reason: String(e?.message || e) };
  }
}

function runNode(args, env, { timeoutMs = 240_000 } = {}) {
  const exe = process.execPath;
  // --expose-internals：内核 loader 的 internal 面（hmr 依赖）只在 Node 带
  // --expose-internals 启动时可用；官方桌面端 sidecar 即以该 flag 拉内核。
  const fullArgs = ['--expose-internals', ...args];
  try {
    const stdout = execFileSync(exe, fullArgs, {
      env: { ...process.env, ...env },
      encoding: 'utf8',
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    return { code: 0, stdout, stderr: '' };
  } catch (e) {
    return { code: e.status ?? 1, stdout: e.stdout ?? '', stderr: (e.stderr ?? '') + '\n' + String(e?.message || e) };
  }
}

// junction：repo → profile node_modules/dsh-master-key（super-injector 同款机制，绕过 pnpm）
function ensureJunction(link, target) {
  if (existsSync(link)) return true;
  mkdirSync(dirname(link), { recursive: true });
  try {
    execFileSync('cmd.exe', ['/c', 'mklink', '/J', toWin(link), toWin(target)], { windowsHide: true, stdio: 'ignore' });
    return existsSync(link);
  } catch { return false; }
}

// ── 准备：隔离 home + 自动初始化 headless profile + 注入 patch/依赖 ─────────
export function prepareProbe(v, { fixturePath = join(REPO, 'test', 'fixtures', 'probe-fixture', 'index.cjs') } = {}) {
  const home = homeDir(v);
  rmSync(home, { recursive: true, force: true });
  mkdirSync(home, { recursive: true });
  const env = { DSH_HOME: home };

  // 0) 上游依赖漂移修补（必要时钉 cordis-plugin-hmr）
  const pin = pinHmrIfNeeded(v);
  if (!pin.ok) {
    return { ok: false, step: 'pin-hmr', detail: pin.reason };
  }

  // 1) 让内核自动初始化 headless profile（dump-config 足够触发）
  const init = runNode([binJs(v), '--profile', 'headless', '--dump-config'], env);
  const profileDir = join(home, 'profiles', 'headless');
  if (init.code !== 0 || !existsSync(join(profileDir, 'package.json'))) {
    return { ok: false, step: 'init', detail: (init.stderr || init.stdout).slice(-2000) };
  }

  // 2) junction 适配器进 profile node_modules
  const linked = ensureJunction(join(profileDir, 'node_modules', 'dsh-master-key'), REPO);
  if (!linked) return { ok: false, step: 'junction', detail: 'mklink 失败' };

  // 3) 适配器以 bundle 身份挂进 profile（用户 patch 层保持空 []——非空会触发
  //    patch watch，headless 的 hmr 服务没有 registerConfig，boot 必炸）。
  //    bundle patch 层不触发用户层 watch。
  const pkgFile = join(profileDir, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'));
  pkg.dsh = pkg.dsh || {};
  pkg.dsh.profile = pkg.dsh.profile || {};
  // 插到 dsh-base 之后、dsh-headless 之前：headless 的 one-shot runner 在自己的
  // apply 里就跑任务，适配器必须先于它激活（mock LLM 才来得及注册）。
  const bundles = pkg.dsh.profile.bundles || [];
  if (!bundles.includes('dsh-master-key')) bundles.splice(Math.min(1, bundles.length), 0, 'dsh-master-key');
  pkg.dsh.profile.bundles = bundles;
  writeFileSync(pkgFile, JSON.stringify(pkg, null, 2), 'utf8');

  // 4) 测试专用覆盖层（--patch）：
  //    - hmr 显式启用并带完整配置（Hmr.Config 的 base 为必填，profile-boot 的
  //      自动创建只传 {root:[]} → 构造失败被 _init 静默吞掉 → 服务永不出现 →
  //      patch watch fail-loud 炸 boot；这是 npm 裸装内核 + headless 的组合 bug）
  //    - agent-default-model → mock provider
  //    只存在于探针 home，绝不写进适配器正式 manifest。
  const mockPatch = join(PROBES, labelFor(v), 'mock-patch.yml');
  mkdirSync(PROBES, { recursive: true });
  writeFileSync(mockPatch, [
    '# dsh-master-key L3 测试覆盖层（仅探针 home 生效）',
    '- id: hmr',
    '  name: \'@deepseek-ai/cordis-plugin-hmr\'',
    '  disabled: false',
    '  config:',
    '    base: .',
    '    root:',
    '      - .',
    '- id: agent-default-model',
    '  config:',
    '    provider: dshx-mock',
    '    model: mock-1',
    '',
  ].join('\n'), 'utf8');

  return { ok: true, home, profileDir, mockPatch };
}

// ── 启动：headless one-shot ────────────────────────────────────────────────
export async function bootProbe(v, { job = 'probe job', timeoutMs = 240_000, fixturePath = null, mockPatch = null } = {}) {
  const home = homeDir(v);
  const env = {
    DSH_HOME: home,
    DSH_KERNEL_ROOT: kernelRoot(v),
    DSH_PROFILE_DIR: join(home, 'profiles', 'headless'),
    DSHX_MOCK_LLM: '1',
    DSH_COMPAT_FORCE_VARIANT: 'official-cli',
    DSH_EXEC_PATH: binJs(v),
  };
  if (fixturePath) env.DSHX_TARGETS = JSON.stringify([{ path: fixturePath.replace(/\\/g, '/') }]);
  const args = [binJs(v), '--profile', 'headless'];
  if (mockPatch) args.push('--patch', mockPatch);
  args.push(job);
  const r = runNode(args, env, { timeoutMs });
  mkdirSync(join(PROBES, labelFor(v)), { recursive: true });
  writeFileSync(join(PROBES, labelFor(v), `boot.log`), `exit=${r.code}\n=== STDOUT ===\n${r.stdout}\n=== STDERR ===\n${r.stderr}`, 'utf8');
  return r;
}

// ── 断言 ───────────────────────────────────────────────────────────────────
export function assertProbe(v, boot) {
  const home = homeDir(v);
  const checks = [];
  const check = (name, pass, detail = '') => checks.push({ name, pass, detail: String(detail).slice(0, 400) });

  check('boot-exit-0', boot.code === 0, `exit=${boot.code} ${boot.stderr.slice(-300)}`);
  const out = boot.stdout + '\n' + boot.stderr;
  check('mock-final', /MOCK_FINAL/.test(out), out.slice(-300));
  check('inject-visible', /INJECT_VISIBLE/.test(out), out.slice(-300));

  try {
    const fx = JSON.parse(readFileSync(join(home, 'dshx', 'probe-fixture.json'), 'utf8'));
    check('fixture-mounted', true);
    check('fixture-tools', fx.hasTools === true, JSON.stringify(fx));
    check('fixture-tool-registered', fx.toolRegistered === true, fx.toolError || '');
    check('fixture-llm', fx.hasLlm === true);
    check('fixture-dshx', fx.hasDshx === true);
    check('fixture-provide', fx.provideOk === true, fx.provideReason || '');
  } catch (e) {
    check('fixture-mounted', false, String(e?.message || e));
  }

  try {
    const mx = JSON.parse(readFileSync(join(home, 'dshx', 'matrix.json'), 'utf8'));
    check('matrix-written', true);
    check('matrix-adapter', mx.adapter?.version === '0.2.0');
    check('matrix-pack-cordis-bundle', Array.isArray(mx.packs) && mx.packs.some(p => p.id === 'cordis-bundle'));
  } catch (e) {
    check('matrix-written', false, String(e?.message || e));
  }

  const passed = checks.filter(c => c.pass).length;
  return { pass: passed === checks.length, checks, passed, total: checks.length };
}

// doctor 级 shim（装前体检用，非运行时）：
//   6. slots 归一   —— client inject 引用缺失包识别（0.1.1 无独立 dsh-client-ui-slots）
//   8. peer-gate    —— peerDependencies 与运行内核的预检（0.2.0 安装/启动强制的镜像，advisory）
//   9. guard 扫描   —— EAC plugin-guard 静态规则的镜像（适配层自身与被包插件都扫）

// ── 6. client inject 体检 ──────────────────────────────────────────────────
export function detectClientInjectIssues(manifest, caps = {}) {
  const issues = [];
  const inject = manifest?.dsh?.client?.inject || [];
  if (inject.includes('@deepseek-ai/dsh-client-ui-slots') && caps['client.slotsPackage'] === false) {
    issues.push({
      level: 'warn', code: 'SLOTS_PACKAGE_MISSING',
      message: '插件声明注入 @deepseek-ai/dsh-client-ui-slots，但当前内核没有该独立包（0.1.1 系 slot 契约内嵌）；client 半可能无法激活',
    });
  }
  if (inject.length > 0 && caps['client.slotsPackage'] === null) {
    issues.push({ level: 'info', code: 'CLIENT_SURFACE_UNKNOWN', message: '无法探测内核 client 包面，client 兼容性未知（将按 fail-soft 处理）' });
  }
  return issues;
}

// ── 8. peer-gate（pragmatic semver：^ ~ >= > <= < 精确 + 区间对 + ||；prerelease 按段比较） ──
export function checkPeerGate(manifest, runtimeVersion) {
  const peers = manifest?.peerDependencies || {};
  const out = [];
  for (const [name, range] of Object.entries(peers)) {
    if (!(name === 'cordis' || name.startsWith('@deepseek-ai/'))) continue;
    const compatible = rangeEmpty(range) ? true : satRange(runtimeVersion, range);
    out.push({ name, range, runtimeVersion, compatible });
  }
  return out;
}

function rangeEmpty(range) { return range === '*' || range === '' || range == null; }

export function satRange(version, range) {
  const v = parseVersion(version);
  if (!v) return false;
  return String(range).split('||').some(orPart => {
    const comps = orPart.trim().split(/[\s,]+/).filter(Boolean);
    return comps.every(c => satComparator(v, c));
  });
}

function satComparator(v, comp) {
  let m = /^(~|\^|>=|<=|>|<|=)?\s*(.+)$/.exec(comp.trim());
  if (!m) return true;
  const op = m[1] || '=';
  const r = parseVersion(m[2]);
  if (!r) return true; // 无法解析的比较子不拦（advisory 性质）
  const cmp = compareVersions(v, r);
  switch (op) {
    // ^ / ~ 的上界：0.x 系（如 ^0.1.5-rc.1）排除 0.2.0——对照 dsh-tauri 兼容矩阵意图
    //（它为 0.2 单列区间对）；显式比较子（>=/< 等）按含 prerelease 的排序判定，
    // 使 ">=0.1.5-rc.1" 覆盖 0.1.7-rc.2（社区声明的惯用意图）。
    case '~': return cmp >= 0 && v.major === r.major && v.minor === r.minor;
    case '^': return cmp >= 0 && v.major === r.major && (r.major > 0 || v.minor === r.minor);
    case '>=': return cmp >= 0;
    case '<=': return cmp <= 0;
    case '>': return cmp > 0;
    case '<': return cmp < 0;
    default: return cmp === 0;
  }
}

export function parseVersion(s) {
  if (typeof s !== 'string') return null;
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(s.trim());
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ? m[4].split('.') : null };
}

function compareVersions(a, b) {
  for (const k of ['major', 'minor', 'patch']) {
    if (a[k] !== b[k]) return a[k] - b[k];
  }
  // 有 prerelease 的 < 无 prerelease；prerelease 按段比（数字段数值比，字母段字典序）
  if (!a.pre && !b.pre) return 0;
  if (!a.pre) return 1;
  if (!b.pre) return -1;
  const len = Math.max(a.pre.length, b.pre.length);
  for (let i = 0; i < len; i++) {
    const x = a.pre[i], y = b.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
    if (xn && yn) { const d = +x - +y; if (d) return d; }
    else if (xn !== yn) return xn ? -1 : 1;
    else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

// ── 9. guard 扫描（镜像 EAC plugin-guard 规则名与语义） ────────────────────
const GUARD_RULES = [
  { id: 'TROJAN_REMOTE_EXEC', re: /child_process[^;]{0,200}(exec\(|execSync\(|spawn\()|require\(['"]child_process['"]\)/ },
  { id: 'TROJAN_DOWNLOAD_EXEC', re: /(https?:\/\/)[^\s'"]{0,200}(child_process|exec\(|eval\()/ },
  { id: 'TROJAN_BASE64_EVAL', re: /(atob\(|Buffer\.from\([^)]*['"]base64['"]\)[^;]{0,80})(eval\(|new Function\()/ },
  { id: 'TROJAN_PERSISTENCE', re: /(schtasks\s+\/create|reg\s+add\s+.*\\Run|Register-ScheduledTask|Startups?\\)/i },
  { id: 'TROJAN_EXFIL_ENV', re: /(?:process\.env|os\.env)[\s\S]{0,120}(?:https?:\/\/|fetch\s*\(|XMLHttpRequest|net\.connect|dgram)/i },
];

export function scanGuardPatterns(sourceText) {
  if (typeof sourceText !== 'string' || sourceText.length === 0) return [];
  const hits = [];
  for (const rule of GUARD_RULES) {
    const m = rule.re.exec(sourceText);
    if (m) hits.push({ rule: rule.id, excerpt: sourceText.slice(Math.max(0, m.index - 30), m.index + 80) });
  }
  return hits;
}

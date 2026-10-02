// 报告：矩阵自述 + quarantine/兜底事件流。
// 原则：全链路无静默降级——一切不可用与兜底都落 here，可查可审计。

import { appendFileSync, mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export function createReport({ home, logger = null } = {}) {
  const events = [];
  let matrix = null;
  let incidentsFile = null;
  try {
    if (home) {
      const { mkdirSync, existsSync: ex } = require('node:fs');
      const dir = join(home, 'dshx');
      if (!ex(dir)) mkdirSync(dir, { recursive: true });
      incidentsFile = join(dir, 'incidents.jsonl');
    }
  } catch { incidentsFile = null; }

  const report = {
    setMatrix(m) { matrix = m; return m; },
    event(kind, detail) {
      const rec = { ts: new Date().toISOString(), kind, ...detail };
      events.push(rec);
      // 实时落盘（幂等追加）：adapter 生命周期短于宿主进程时，flush 前的事件也能留存
      if (incidentsFile) {
        try { appendFileSync(incidentsFile, JSON.stringify(rec) + '\n', 'utf8'); } catch { /* 落盘失败不致命 */ }
      }
      try { logger?.info?.(`[dsh-compat] ${kind}: ${JSON.stringify(detail).slice(0, 200)}`); } catch { /* 日志面不可用不致命 */ }
      return rec;
    },
    // 插件激活失败隔离：错误签名入库，等 playbook 扩展（禁止静默，也禁止外抛拖垮插件树）
    quarantine({ plugin, pack, error, caps }) {
      return report.event('quarantine', {
        plugin, pack,
        error: { name: error?.name, message: String(error?.message || error).slice(0, 500), stack: String(error?.stack || '').slice(0, 1200) },
        capsSummary: caps ? Object.fromEntries(Object.entries(caps).filter(([, v]) => v !== null && v !== undefined)) : null,
      });
    },
    fallback(capability, reason, plugin = null) {
      return report.event('fallback', { capability, reason, plugin });
    },
    // matrix 持久化：$DSH_HOME/dshx/matrix.json（事件已实时追加进 incidents.jsonl）
    flush() {
      if (!home) return { written: false, reason: 'no-home' };
      try {
        const dir = join(home, 'dshx');
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'matrix.json'), JSON.stringify({ reportedAt: new Date().toISOString(), ...(matrix || {}) }, null, 2), 'utf8');
        return { written: true, events: events.length };
      } catch (e) {
        return { written: false, reason: String(e?.message || e) };
      }
    },
    events,
    get matrix() { return matrix; },
  };
  return report;
}

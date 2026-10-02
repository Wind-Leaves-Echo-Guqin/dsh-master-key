// 报告：矩阵自述 + quarantine/兜底事件流。
// 原则：全链路无静默降级——一切不可用与兜底都落 here，可查可审计。

import { appendFileSync, mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function createReport({ home, logger = null } = {}) {
  const events = [];
  let matrix = null;

  const report = {
    setMatrix(m) { matrix = m; return m; },
    event(kind, detail) {
      const rec = { ts: new Date().toISOString(), kind, ...detail };
      events.push(rec);
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
    // 事件持久化：$DSH_HOME/dshx/incidents.jsonl（隔离 DSH_HOME 下即测试目录，绝不触碰 live）
    flush() {
      if (!home) return { written: false, reason: 'no-home' };
      try {
        const dir = join(home, 'dshx');
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        appendFileSync(join(dir, 'incidents.jsonl'), events.map(e => JSON.stringify(e)).join('\n') + (events.length ? '\n' : ''), 'utf8');
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

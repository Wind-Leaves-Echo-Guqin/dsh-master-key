import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReport } from '../../lib/core/report.js';

test('quarantine：记录错误签名且不外抛', () => {
  const report = createReport({});
  const rec = report.quarantine({ plugin: 'legacy-x', pack: 'cordis-bundle', error: new TypeError('boom at deep'), caps: { 'dsh.tools': true } });
  assert.equal(rec.kind, 'quarantine');
  assert.equal(rec.plugin, 'legacy-x');
  assert.equal(rec.error.name, 'TypeError');
  assert.ok(rec.error.message.includes('boom'));
  assert.equal(rec.capsSummary['dsh.tools'], true);
});

test('flush：事件与矩阵落盘 incidents.jsonl / matrix.json（隔离 home）', () => {
  const home = mkdtempSync(join(tmpdir(), 'dshcompat-report-'));
  try {
    const report = createReport({ home });
    report.setMatrix({ variant: 'test', caps: {} });
    report.fallback('dsh.tools', 'missing');
    const r = report.flush();
    assert.equal(r.written, true);
    assert.equal(r.events, 1);
    const lines = readFileSync(join(home, 'dshx', 'incidents.jsonl'), 'utf8').trim().split('\n');
    assert.equal(JSON.parse(lines[0]).kind, 'fallback');
    const matrix = JSON.parse(readFileSync(join(home, 'dshx', 'matrix.json'), 'utf8'));
    assert.equal(matrix.variant, 'test');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('flush：无 home 时明确返回不写入（不猜路径）', () => {
  const report = createReport({});
  report.fallback('c', 'r');
  const r = report.flush();
  assert.equal(r.written, false);
  assert.equal(r.reason, 'no-home');
});

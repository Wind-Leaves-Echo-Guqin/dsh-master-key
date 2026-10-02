import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ok, unavailable, isEnvelope, isUnavailable, unwrap } from '../../lib/core/envelope.js';

test('信封：unavailable 语义对齐 EAC v6 能力桩', () => {
  const e = unavailable('dsh.tools', '宿主无 ctx.tools.register');
  assert.equal(e.ok, false);
  assert.equal(e.unavailable, true);
  assert.equal(e.capability, 'dsh.tools');
  assert.equal(e.reason, '宿主无 ctx.tools.register');
  assert.equal(isUnavailable(e), true);
  assert.equal(isEnvelope(e), true);
});

test('信封：ok 携带值与可选 detail', () => {
  const e = ok(42, { source: 'test' });
  assert.equal(e.ok, true);
  assert.equal(e.value, 42);
  assert.equal(e.detail.source, 'test');
  assert.equal(isUnavailable(e), false);
});

test('信封：unwrap 解包与兜底', () => {
  assert.equal(unwrap(ok('x'), 'd'), 'x');
  assert.equal(unwrap(unavailable('c', 'r'), 'd'), 'd');
  assert.equal(unwrap('raw', 'd'), 'raw'); // 老式裸值宽容
});

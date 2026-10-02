import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadVariants, detectVariant, classifyUnknown } from '../../lib/core/variant.js';

test('loadVariants：内置描述库 ≥10 个且字段合法', () => {
  const variants = loadVariants();
  assert.ok(variants.length >= 10, `内置变体应 ≥10，实际 ${variants.length}`);
  const ids = variants.map(v => v.id);
  for (const expect of ['official-cli', 'official-desktop', 'eac-v5', 'eac-v6', 'dsheac-aio', 'dsh-tauri']) {
    assert.ok(ids.includes(expect), `缺 ${expect}`);
  }
  for (const v of variants) {
    assert.ok(Array.isArray(v.packs), `${v.id}.packs 应为数组`);
    assert.ok(['none', 'low', 'medium', 'high'].includes(v.adaptation), `${v.id}.adaptation 非法`);
  }
});

test('detectVariant：env 信号命中（测试描述库）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dshcompat-variant-'));
  try {
    writeFileSync(join(dir, 'test-variant.json'), JSON.stringify({
      id: 'test-variant', family: 'official', packs: ['cordis-bundle'],
      detect: [{ kind: 'env', name: 'DSHCOMPAT_TEST_MARK', value: 'yes' }],
    }));
    const variants = loadVariants([dir]);
    const hit = detectVariant(variants, { DSHCOMPAT_TEST_MARK: 'yes' });
    assert.equal(hit.id, 'test-variant');
    const miss = detectVariant(variants, {});
    assert.notEqual(miss.id, 'test-variant');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('detectVariant：无信号泛型描述只在兜底时使用', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dshcompat-variant2-'));
  try {
    writeFileSync(join(dir, 'specific.json'), JSON.stringify({
      id: 'specific', family: 'official', packs: [], detect: [{ kind: 'env', name: 'X1', value: '1' }],
    }));
    writeFileSync(join(dir, 'generic.json'), JSON.stringify({
      id: 'generic', family: 'wrapper', packs: [], detect: [],
    }));
    const variants = loadVariants([dir]);
    assert.equal(detectVariant(variants, { X1: '1' }).id, 'specific');
    const onlyMine = variants.filter(v => v.id === 'specific' || v.id === 'generic');
    assert.equal(detectVariant(onlyMine, {}).id, 'generic');
    assert.equal(detectVariant(onlyMine.filter(v => v.id !== 'generic'), {}).id, 'unknown');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('classifyUnknown：结构探测认出官方 cordis 面', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dshcompat-unknown-'));
  try {
    mkdirSync(join(dir, 'profiles', 'some-profile'), { recursive: true });
    writeFileSync(join(dir, 'profiles', 'some-profile', 'cordis.patch.yml'), '- id: x\n');
    const r = classifyUnknown({ DSH_HOME: dir });
    assert.equal(r.hasOfficialSignal, true);
    assert.deepEqual(r.families, ['cordis-bundle']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

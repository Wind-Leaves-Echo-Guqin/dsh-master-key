import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripBom, readJsonFile } from '../../lib/core/json.js';

test('stripBom：去掉 UTF-8 BOM 头（PowerShell Out-File utf8 产物）', () => {
  assert.equal(stripBom('\uFEFF{"a":1}'), '{"a":1}');
  assert.equal(stripBom('{"a":1}'), '{"a":1}');
});

test('readJsonFile：BOM 文件可解析；坏文件返回 null 不抛', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dshcompat-json-'));
  try {
    const bomFile = join(dir, 'bom.json');
    writeFileSync(bomFile, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"targets":[{"path":"x"}]}')], 'utf8'));
    const j = readJsonFile(bomFile);
    assert.deepEqual(j, { targets: [{ path: 'x' }] });

    writeFileSync(join(dir, 'bad.json'), '{oops');
    assert.equal(readJsonFile(join(dir, 'bad.json')), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

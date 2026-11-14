import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const root = join(import.meta.dirname, '..');

test('oxlint loads the anti-slop plugin and reports its rules', async () => {
  // The config ignores test/fixtures/**, so lint a copy from outside the repo.
  const dir = await mkdtemp(join(tmpdir(), 'anti-slop-'));
  try {
    const file = join(dir, 'filter-map.ts');
    await copyFile(join(root, 'test/fixtures/anti-slop/filter-map.ts'), file);
    // Run oxlint's JS entry with node: on Windows node_modules/.bin/oxlint is a shell shim spawnSync cannot start.
    const r = spawnSync(process.execPath, [join(root, 'node_modules/oxlint/bin/oxlint'), '-c', join(root, '.oxlintrc.json'), '-f', 'json', file], {
      cwd: root,
      encoding: 'utf8',
    });
    const codes = JSON.parse(r.stdout).diagnostics.map((d: { code: string }) => d.code);
    assert.deepEqual(codes, ['anti-slop(no-array-filter-map)']);
    assert.equal(r.status, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

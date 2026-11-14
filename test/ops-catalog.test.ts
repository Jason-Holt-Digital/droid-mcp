import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { globSync } from 'node:fs';
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

type Operation = { id: string; source: string; name: string; summary: string; params: object; destructive: boolean };
const root = join(import.meta.dirname, '..');
const catalogFile = join(root, 'src/generated/catalog.json');
const operations: Operation[] = JSON.parse(await readFile(catalogFile, 'utf8')).operations;
const byId = new Map(operations.map((o) => [o.id, o]));
const codegenCheck = (cwd: string) => spawnSync(process.execPath, ['scripts/codegen.ts', '--check'], { cwd, encoding: 'utf8' });

test('operation catalog has unique ids, and each operation has a source, name and params object', () => {
  assert.equal(byId.size, operations.length);
  for (const o of operations) {
    assert.ok(o.source === 'daemon' || o.source === 'rest', o.id);
    assert.ok(o.name, o.id);
    assert.equal(typeof o.params, 'object', o.id);
    assert.ok(o.params !== null && !Array.isArray(o.params), o.id);
  }
});

test('operation catalog lists over 100 DaemonClient methods and every operation in the OpenAPI snapshot', async () => {
  const [dts] = globSync(join(root, 'node_modules/@factory/droid-sdk/dist/index-*.d.ts'));
  const text = await readFile(dts, 'utf8');
  const start = text.indexOf('declare class DaemonClient {');
  const client = text.slice(start, text.indexOf('\n}\n', start));
  const daemon = operations.filter((o) => o.source === 'daemon');
  assert.ok(daemon.length > 100, `${daemon.length} daemon operations`);
  for (const o of daemon) assert.ok(client.includes(`\n    ${o.name}(`), `${o.name} is a DaemonClient method`);
  const doc = JSON.parse(await readFile(join(root, 'catalog/factory-openapi.json'), 'utf8'));
  const http = ['get', 'put', 'post', 'delete', 'patch', 'options', 'head', 'trace'];
  const expected = Object.entries(doc.paths).flatMap(([path, item]) =>
    Object.keys(item as object)
      .filter((m) => http.includes(m))
      .map((m) => `${m.toUpperCase()} ${path}`),
  );
  const rest = operations.flatMap((o) => (o.source === 'rest' ? [o.name] : []));
  assert.deepEqual(rest.toSorted(), expected.toSorted());
});

test('destructive marks REST DELETE and names with a destructive word', () => {
  const expected = {
    'rest.deleteSession': true,
    'rest.revokeServiceAccountApiKey': true,
    'rest.cancelEnvironmentBuild': true,
    'rest.listSessions': false,
    'rest.createComputer': false,
    'daemon.kill_worker_session': true,
    'daemon.uninstall_plugin': true,
    'daemon.archive_session': true,
    'daemon.list_models': false,
    'daemon.initialize_session': false,
  };
  for (const [id, destructive] of Object.entries(expected)) assert.equal(byId.get(id)?.destructive, destructive, id);
});

test('codegen --check passes on a clean tree and fails when the catalog is stale', async () => {
  const clean = codegenCheck(root);
  assert.equal(clean.status, 0, clean.stderr);
  const dir = await mkdtemp(join(tmpdir(), 'droid-mcp-codegen-'));
  try {
    for (const path of ['package.json', 'scripts/codegen.ts', 'catalog/factory-openapi.json', 'src/generated/catalog.json']) {
      await cp(join(root, path), join(dir, path), { recursive: true });
    }
    await symlink(join(root, 'node_modules'), join(dir, 'node_modules'));
    const copy = join(dir, 'src/generated/catalog.json');
    const original = await readFile(copy, 'utf8');
    await writeFile(copy, original.replace('"destructive": false', '"destructive": true'));
    const edited = codegenCheck(dir);
    assert.equal(edited.status, 1);
    assert.match(edited.stderr, /src\/generated\/catalog\.json is stale.*Run: npm run codegen/);
    await writeFile(copy, original.replace(/"sdkVersion": "[^"]*"/, '"sdkVersion": "0.0.0"'));
    const old = codegenCheck(dir);
    assert.equal(old.status, 1);
    assert.match(old.stderr, /built for @factory\/droid-sdk 0\.0\.0, installed is /);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

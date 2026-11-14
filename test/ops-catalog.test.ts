import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { globSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

type Operation = { id: string; source: string; name: string; summary: string; params: object; readOnly: boolean; destructive: boolean; secret: boolean };
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

test('destructive is REST DELETE or a hand-checked id, never a word in the operationId', () => {
  const expected = {
    'rest.deleteSession': true,
    'rest.revokeServiceAccountApiKey': true,
    'rest.cancelEnvironmentBuild': true,
    'rest.PostOpenACiWorkflowPrCreateEditDelete': false,
    'rest.listSessions': false,
    'rest.createComputer': false,
    'daemon.kill_worker_session': true,
    'daemon.uninstall_plugin': true,
    'daemon.archive_session': true,
    'daemon.write_terminal_data': true,
    'daemon.automation_memory_edit': true,
    'daemon.update_mcp_config': true,
    'daemon.config_items': true,
    'rest.answerSessionElicitation': false,
    'daemon.list_models': false,
    'daemon.initialize_session': false,
  };
  for (const [id, destructive] of Object.entries(expected)) assert.equal(byId.get(id)?.destructive, destructive, id);
  for (const o of operations.filter((x) => x.source === 'rest')) {
    if (o.name.startsWith('DELETE ')) assert.equal(o.destructive, true, o.id);
  }
});

test('readOnly is exactly REST GET, plus listed daemon methods; nothing is both read-only and destructive', () => {
  for (const o of operations.filter((x) => x.source === 'rest')) assert.equal(o.readOnly, o.name.startsWith('GET '), o.id);
  assert.equal(byId.get('daemon.list_models')?.readOnly, true);
  assert.equal(byId.get('daemon.get_workspace_file_content')?.readOnly, false, 'arbitrary file contents are not read-only for the cap');
  assert.deepEqual(
    operations.flatMap((o) => (o.readOnly && o.destructive ? [o.id] : [])),
    [],
  );
});

test('operations that return keys or tokens are marked secret and are never read-only', () => {
  const secret = operations.flatMap((o) => (o.secret ? [o.id] : []));
  assert.ok(secret.includes('daemon.get_proxy_token'));
  assert.ok(secret.includes('rest.createServiceAccountApiKey'));
  for (const id of secret) assert.equal(byId.get(id)?.readOnly, false, id);
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

// A copy of the inputs codegen reads, with node_modules linked package by package so one can be swapped out.
async function sandbox(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'droid-mcp-codegen-'));
  for (const path of ['package.json', 'scripts/codegen.ts', 'catalog/factory-openapi.json', 'src/generated/catalog.json']) {
    await cp(join(root, path), join(dir, path), { recursive: true });
  }
  await mkdir(join(dir, 'node_modules/@factory'), { recursive: true });
  await symlink(join(root, 'node_modules/@factory/droid-sdk'), join(dir, 'node_modules/@factory/droid-sdk'));
  await symlink(join(root, 'node_modules/typescript'), join(dir, 'node_modules/typescript'));
  return dir;
}

test('codegen --refresh writes the fetched OpenAPI file, then builds the catalog from it', async () => {
  const dir = await sandbox();
  try {
    const spec = {
      openapi: '3.1.0',
      info: { version: '9.9.9' },
      paths: {
        '/api/v0/things/{id}': {
          get: { operationId: 'getThing', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }] },
          delete: { operationId: 'dropThing' },
        },
      },
    };
    const mock = join(dir, 'mock-fetch.mjs');
    await writeFile(
      mock,
      `globalThis.fetch = async (url) => { if (url !== 'https://docs.factory.com/openapi.json') throw new Error('unexpected ' + url); return new Response(${JSON.stringify(JSON.stringify(spec))}); };\n`,
    );
    const r = spawnSync(process.execPath, ['--import', mock, 'scripts/codegen.ts', '--refresh'], { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(await readFile(join(dir, 'catalog/factory-openapi.json'), 'utf8')), spec);
    const built = JSON.parse(await readFile(join(dir, 'src/generated/catalog.json'), 'utf8'));
    assert.equal(built.openapiVersion, '9.9.9');
    const rest = built.operations.filter((o: Operation) => o.source === 'rest');
    assert.deepEqual(
      rest.map((o: Operation) => [o.id, o.readOnly, o.destructive]),
      [
        ['rest.dropThing', false, true],
        ['rest.getThing', true, false],
      ],
    );

    await writeFile(mock, 'globalThis.fetch = async () => new Response("nope", { status: 503 });\n');
    const down = spawnSync(process.execPath, ['--import', mock, 'scripts/codegen.ts', '--refresh'], { cwd: dir, encoding: 'utf8' });
    assert.equal(down.status, 1);
    assert.match(down.stderr, /GET https:\/\/docs\.factory\.com\/openapi\.json: 503/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('codegen refuses a TypeScript version it was not written for, with a clear message', async () => {
  const dir = await sandbox();
  try {
    await rm(join(dir, 'node_modules/typescript'));
    await mkdir(join(dir, 'node_modules/typescript'));
    await writeFile(join(dir, 'node_modules/typescript/package.json'), '{"name":"typescript","version":"7.1.0"}');
    const r = codegenCheck(dir);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /written for typescript 7\.0\.2, installed is 7\.1\.0/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('codegen fails on an operation with a destructive action in its params that no list classifies', async () => {
  const dir = await sandbox();
  try {
    const file = join(dir, 'scripts/codegen.ts');
    const source = await readFile(file, 'utf8');
    await writeFile(file, source.replace("  'automation_memory_edit',\n", ''));
    const r = codegenCheck(dir);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /daemon\.automation_memory_edit takes a destructive-sounding action in its params but is in no list/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('daemon methods whose first argument is not an object are left out', () => {
  assert.equal(byId.get('daemon.wait_for_config_pull'), undefined);
});

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { globSync } from 'node:fs';
import { appendFile, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { filterRecords, findSession, groupCatalog, readTranscript, readTranscriptTail, repoRoot, scanSessions } from '../src/catalog.ts';
import { FIXTURES, IDS, fixtureRecords } from './helpers.ts';

const ids = (rs: Array<{ id: string }>) => rs.map((r) => r.id);

test('scanSessions reads headers, tags, workstream roles, subagent parents and archive flags', async () => {
  const records = await scanSessions(FIXTURES);
  assert.equal(records.length, Object.keys(IDS).length - 1);
  const byId = new Map(records.map((r) => [r.id, r]));
  assert.deepEqual(byId.get(IDS.liveOrchestrator)?.workstream, { id: IDS.liveOrchestrator, role: 'orchestrator' });
  assert.equal(byId.get(IDS.liveOrchestrator)?.title, 'Finish the service and release it');
  assert.deepEqual(byId.get(IDS.liveAgentNewer)?.workstream, { id: IDS.liveOrchestrator, role: 'agent' });
  assert.equal(byId.get(IDS.liveAgentNewer)?.parentId, undefined, 'a workstream agent is not a subagent');
  assert.deepEqual(byId.get(IDS.orphanAgentA)?.workstream, { id: IDS.missingOrchestrator, role: 'agent' });
  assert.equal(byId.get(IDS.subagent)?.parentId, '900cb9e9-c0e2-5b47-983c-21e67cf0b317');
  assert.equal(byId.get(IDS.archivedScratch)?.archived, true);
  assert.equal(byId.get(IDS.liveStandalone)?.archived, false);
  assert.deepEqual(byId.get(IDS.liveStandalone)?.tags, ['droid-mcp', 'sdk']);
});

test('findSession locates one session by id and rejects path-like ids', async () => {
  assert.equal((await findSession(FIXTURES, IDS.subagent))?.title, 'Worker: inspect a screenshot');
  assert.equal(await findSession(FIXTURES, '1bd2caee-2a3d-5f4b-955e-85e5a0b99023'), undefined);
  assert.equal(await findSession(FIXTURES, '../-home-dev/97a62cfa-b4ce-547c-8c4a-f155826afb71'), undefined);
});

test('default view hides archived sessions and subagents', async () => {
  const visible = filterRecords(await fixtureRecords(), {});
  assert.deepEqual(new Set(ids(visible)), new Set([IDS.liveOrchestrator, IDS.liveAgentNewer, IDS.liveAgentOlder, IDS.liveStandalone]));
  const catalog = groupCatalog(visible);
  assert.equal(catalog.workstreams.length, 1);
  assert.deepEqual(catalog.standalone, [{ repo: '/home/dev/repos/droid-mcp-scratch', sessions: catalog.standalone[0].sessions }]);
});

test('workstreams: orchestrator first, agents under their missionId newest first, missing orchestrator kept', async () => {
  const catalog = groupCatalog(filterRecords(await fixtureRecords(), { includeArchived: true }));
  assert.deepEqual(
    catalog.workstreams.map((w) => w.id),
    [IDS.archivedOrchestrator, IDS.liveOrchestrator, IDS.missingOrchestrator],
    'workstreams with a local orchestrator come first, then by latest activity',
  );
  const live = catalog.workstreams[1];
  assert.equal(live.orchestrator?.id, IDS.liveOrchestrator);
  assert.equal(live.title, 'Finish the service and release it');
  assert.deepEqual(ids(live.agents), [IDS.liveAgentNewer, IDS.liveAgentOlder]);
  const orphan = catalog.workstreams[2];
  assert.equal(orphan.orchestrator, undefined);
  assert.equal(orphan.title, undefined);
  assert.deepEqual(ids(orphan.agents), [IDS.orphanAgentB, IDS.orphanAgentA]);
  const allStandalone = catalog.standalone.flatMap((g) => ids(g.sessions));
  assert.ok(!allStandalone.includes(IDS.subagent));
  assert.ok(!allStandalone.includes(IDS.missionSubagent));
});

test('standalone sessions group by repo, groups and sessions newest first', async () => {
  const records = filterRecords(await fixtureRecords(), { includeArchived: true, includeSubagents: true });
  const catalog = groupCatalog(records, { repoOf: (cwd) => cwd.split('/').slice(0, 5).join('/') });
  assert.deepEqual(
    catalog.standalone.map((g) => [g.repo, ids(g.sessions)]),
    [
      ['/home/dev/repos/droid-mcp-scratch', [IDS.liveStandalone]],
      ['/home/dev/repos/monorepo', [IDS.archivedService]],
      ['/home/dev/repos/shop', [IDS.missionSubagent]],
      ['/home/dev/repos/personal', [IDS.subagent, IDS.subagentParent]],
      ['/home/dev/.scratch/2026-10-23-task-148bec3e', [IDS.archivedScratch]],
    ],
  );
});

test('repoRoot walks up to the directory holding .git, else returns cwd', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'droid-mcp-repo-'));
  try {
    await mkdir(join(dir, 'repo', '.git'), { recursive: true });
    await mkdir(join(dir, 'repo', 'pkg', 'src'), { recursive: true });
    await mkdir(join(dir, 'plain'));
    assert.equal(repoRoot(join(dir, 'repo', 'pkg', 'src')), join(dir, 'repo'));
    assert.equal(repoRoot(join(dir, 'plain')), join(dir, 'plain'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('filterRecords matches title, id prefix, cwd and whole workstreams by orchestrator title', async () => {
  const records = await fixtureRecords();
  const all = { includeArchived: true, includeSubagents: true };
  assert.deepEqual(ids(filterRecords(records, { ...all, query: 'payment' })), [IDS.archivedAgentPayment]);
  assert.deepEqual(ids(filterRecords(records, { ...all, query: 'aa763cb7' })), [IDS.liveStandalone]);
  assert.deepEqual(
    new Set(ids(filterRecords(records, { ...all, query: 'Triage the shop' }))),
    new Set([IDS.archivedOrchestrator, IDS.archivedAgentPayment, IDS.archivedAgentResearch]),
  );
  assert.deepEqual(new Set(ids(filterRecords(records, { ...all, cwd: '/home/dev/repos/personal/' }))), new Set([IDS.subagent, IDS.subagentParent]));
  assert.deepEqual(ids(filterRecords(records, { ...all, cwd: '/home/dev/repos/mono' })), [], 'cwd is a path prefix, not a string prefix');
  assert.deepEqual(ids(filterRecords(records, { query: 'payment' })), [], 'archived still hidden while searching');
});

test('readTranscript returns user and assistant text with byte cursors that resume after each entry', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'droid-mcp-transcript-'));
  try {
    const header = await readFile(join(FIXTURES, '-home-dev-repos-droid-mcp-scratch', `${IDS.liveStandalone}.jsonl`), 'utf8');
    const msg = (role: string, content: unknown[]) => JSON.stringify({ type: 'message', id: 'm', timestamp: 't', message: { role, content } });
    const lines = [
      header.trim(),
      msg('user', [{ type: 'text', text: 'Reply OK' }]),
      msg('assistant', [
        { type: 'tool_use', id: 't1', name: 'Read', input: {} },
        { type: 'text', text: 'Checking.' },
      ]),
      msg('user', [{ type: 'tool_result', tool_use_id: 't1', content: 'x' }]),
      JSON.stringify({ type: 'todo_state', todos: [] }),
      msg('assistant', [{ type: 'text', text: 'OK' }]),
      '',
    ];
    const file = join(dir, 's.jsonl');
    await writeFile(file, lines.join('\n'));
    const all = await readTranscript(file);
    assert.deepEqual(
      all.entries.map((e) => [e.role, e.text]),
      [
        ['user', 'Reply OK'],
        ['assistant', 'Checking.'],
        ['assistant', 'OK'],
      ],
    );
    assert.equal(all.end, Buffer.byteLength(lines.join('\n')), 'end covers every complete line');
    const afterFirst = await readTranscript(file, all.entries[0].seq);
    assert.deepEqual(
      afterFirst.entries.map((e) => e.text),
      ['Checking.', 'OK'],
      'reading from a seq skips that entry',
    );
    await appendFile(file, `${msg('assistant', [{ type: 'text', text: 'More' }])}\n${msg('user', [{ type: 'text', text: 'partial' }])}`);
    const appended = await readTranscript(file, all.end);
    assert.deepEqual(
      appended.entries.map((e) => e.text),
      ['More'],
      'an unterminated last line is not read yet',
    );
    const tail = await readTranscriptTail(file, () => true);
    assert.deepEqual(
      tail.map((e) => e.text),
      ['Reply OK', 'Checking.', 'OK', 'More'],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

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

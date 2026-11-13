import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createRest } from '../src/rest.ts';
import { KeyStore, Runs, type OwnRun, type RunEvent } from '../src/runs.ts';
import { clampWait, DEFAULT_WAIT_MS, LIMIT_BYTES, MAX_WAIT_MS, pageBytes, registerTools, type Ctx } from '../src/tools.ts';
import { catalog, FIXTURES, IDS, SECRET } from './helpers.ts';

let dir: string;
let project: string;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'droid-mcp-tools-'));
  project = join(dir, 'repos', 'proj');
  await mkdir(project, { recursive: true });
});
after(() => rm(dir, { recursive: true, force: true }));

const noSessions = {
  get: () => undefined,
  start: () => Promise.reject(new Error('tests must never start a droid session')),
  resume: () => Promise.reject(new Error('tests must never resume a droid session')),
} as unknown as Runs;

async function connect(ctx: Partial<Ctx>) {
  const server = new McpServer({ name: 'droid-mcp', version: 'test' });
  registerTools(server, {
    sessionsRoot: FIXTURES,
    roots: [join(dir, 'repos')],
    runs: noSessions,
    keys: new KeyStore(join(dir, 'state.json')),
    env: {},
    catalog: async () => catalog(),
    ...ctx,
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  return {
    async call(name: string, args: Record<string, unknown>) {
      const res = await client.callTool({ name, arguments: args });
      const text = (res.content as Array<{ type: string; text: string }>)[0].text;
      return { isError: Boolean(res.isError), text, json: res.isError ? undefined : JSON.parse(text) };
    },
    close: () => client.close(),
  };
}

test('wait timeout is capped at 50 s and defaults to 25 s', () => {
  assert.equal(clampWait(undefined), DEFAULT_WAIT_MS);
  assert.equal(clampWait(10 * 60 * 1000), MAX_WAIT_MS);
  assert.equal(clampWait(-5), 0);
  assert.equal(clampWait(1200), 1200);
});

test('Runs.wait returns at the timeout with nothing new, and early when an event arrives', async () => {
  const runs = new Runs({ repoOf: (cwd) => cwd });
  const run = { state: 'running', events: [] as RunEvent[], waiters: new Set<() => void>() } as unknown as OwnRun;
  let t = Date.now();
  assert.deepEqual((await runs.wait(run, 0, 40)).events, []);
  assert.ok(Date.now() - t >= 35);

  t = Date.now();
  const pending = runs.wait(run, 0, 5000);
  const emit = (e: RunEvent) => {
    run.events.push(e);
    for (const w of [...run.waiters]) w();
  };
  setTimeout(() => emit({ seq: 1, at: Date.now(), kind: 'tool', text: 'Read a.txt' }), 10);
  setTimeout(() => emit({ seq: 2, at: Date.now(), kind: 'assistant', text: 'hi' }), 40);
  assert.deepEqual((await pending).events.map((e) => e.seq), [1, 2], 'a tool event alone does not end the wait');
  assert.ok(Date.now() - t < 1000);
  assert.equal(run.waiters.size, 0);

  assert.deepEqual((await runs.wait(run, 0, 5000)).events.map((e) => e.seq), [1, 2], 'already-available events return at once');

  run.events.splice(0, 1);
  assert.equal((await runs.wait(run, 0, 0)).gap, true, 'evicted events are reported as a gap');
});

test('pageBytes pages by byte offset without splitting UTF-8 characters', () => {
  const text = 'ab€😀c'.repeat(50);
  for (const max of [1, 3, 5, 64]) {
    let offset: number | undefined = 0;
    let out = '';
    let pages = 0;
    while (offset !== undefined) {
      const page = pageBytes(text, offset, max);
      assert.ok(!page.text.includes('\uFFFD'));
      assert.ok(Buffer.byteLength(page.text) <= Math.max(max, 4));
      out += page.text;
      offset = page.nextOffset;
      pages++;
    }
    assert.equal(out, text);
    assert.ok(pages > 1);
  }
  const mid = pageBytes('€x', 1, 10);
  assert.equal(mid.text, 'x', 'an offset inside a character moves to the next character');
  assert.deepEqual(pageBytes('', 0, 10), { text: '', offset: 0, nextOffset: undefined, totalBytes: 0 });
});

test('droid_find groups the catalog, hides archived and subagents, and stays under 8 KB', async () => {
  const c = await connect({});
  try {
    const res = await c.call('droid_find', {});
    assert.equal(res.isError, false);
    assert.ok(Buffer.byteLength(res.text) <= LIMIT_BYTES);
    assert.equal(res.json.total, 4);
    const [ws] = res.json.workstreams;
    assert.equal(ws.id, IDS.liveOrchestrator);
    assert.equal(ws.orchestrator.role, 'orchestrator');
    assert.deepEqual(ws.agents.map((a: { id: string }) => a.id).sort(), [IDS.liveAgentNewer, IDS.liveAgentOlder].sort());
    assert.deepEqual(res.json.sessions[0].sessions.map((s: { id: string }) => s.id), [IDS.liveStandalone]);

    const all = await c.call('droid_find', { includeArchived: true, includeSubagents: true, scope: 'workstreams', limit: 2 });
    assert.equal(all.json.total, 8);
    assert.equal(all.json.nextCursor, '2');
    assert.equal(all.json.sessions.length, 0);
    const next = await c.call('droid_find', { includeArchived: true, includeSubagents: true, scope: 'workstreams', limit: 2, cursor: '6' });
    assert.equal(next.json.nextCursor, undefined);
    assert.equal(next.json.workstreams[0].missingOrchestrator, true);

    const payment = await c.call('droid_find', { query: 'payment', includeArchived: true });
    assert.equal(payment.json.workstreams[0].title, 'Triage the shop', 'title comes from the orchestrator even when it is filtered out');
    assert.equal(payment.json.workstreams[0].orchestrator, undefined);
    assert.equal(payment.json.workstreams[0].missingOrchestrator, undefined);
  } finally {
    await c.close();
  }
});

test('droid_send refuses workstream and unknown sessions without an API key', async () => {
  const c = await connect({});
  try {
    const ws = await c.call('droid_send', { session: IDS.liveAgentNewer, prompt: 'hi', idempotencyKey: 'k1' });
    assert.equal(ws.isError, true);
    assert.match(ws.text, /workstream sessions need FACTORY_API_KEY; never loaded locally/);
    const unknown = await c.call('droid_send', { session: '1bd2caee-2a3d-5f4b-955e-85e5a0b99023', prompt: 'hi', idempotencyKey: 'k2' });
    assert.match(unknown.text, /not on this machine/);
    const bad = await c.call('droid_send', { session: '../etc', prompt: 'hi', idempotencyKey: 'k3' });
    assert.match(bad.text, /invalid session id/);
  } finally {
    await c.close();
  }
});

test('droid_start checks the cwd allow-list and autonomy cap before starting anything', async () => {
  const c = await connect({ env: { DROID_MCP_MAX_AUTONOMY: 'medium' } });
  try {
    const outside = await c.call('droid_start', { cwd: dir, prompt: 'hi', idempotencyKey: 's1' });
    assert.equal(outside.isError, true);
    assert.match(outside.text, /outside the allowed roots/);
    const escape = await c.call('droid_start', { cwd: join(project, '..', '..', '..'), prompt: 'hi', idempotencyKey: 's2' });
    assert.match(escape.text, /outside the allowed roots/);
    const high = await c.call('droid_start', { cwd: project, prompt: 'hi', autonomy: 'high', idempotencyKey: 's3' });
    assert.match(high.text, /exceeds the cap/);
  } finally {
    await c.close();
  }
});

test('droid_models lists the injected catalog, filters it and never shows secrets', async () => {
  const c = await connect({});
  try {
    const all = await c.call('droid_models', {});
    assert.equal(all.json.defaultModel, 'gpt-6.1-sol');
    assert.ok(all.json.builtin.length > 50);
    assert.equal(all.json.custom[0].baseUrlHost, 'localhost:8080');
    assert.ok(all.json.aliases.includes('anthropic-latest-premium'));
    assert.ok(all.json.wildcards.includes('claude-opus-*'));
    assert.match(all.json.usage, /customModels/);
    for (const bad of ['apiKey', 'headers', SECRET]) assert.ok(!all.text.includes(bad), bad);

    const proxy = await c.call('droid_models', { filter: 'MY-PROXY' });
    assert.deepEqual(proxy.json.builtin, []);
    assert.deepEqual(proxy.json.custom.map((m: { id: string }) => m.id), ['custom:my-proxy:opus-5-5']);
    const byProvider = await c.call('droid_models', { filter: 'anthropic', include: ['custom'] });
    assert.equal(byProvider.json.custom.length, 1);
    assert.equal(byProvider.json.builtin, undefined);
    assert.equal(byProvider.json.aliases, undefined);
    const opus = await c.call('droid_models', { filter: 'opus 5.5', include: ['builtin'] });
    assert.deepEqual(opus.json.builtin.map((m: { id: string }) => m.id), ['claude-opus-5-5', 'claude-opus-5-5-fast']);
  } finally {
    await c.close();
  }
});

test('droid_start refuses unknown models and invalid settings before starting anything, and the key can be retried', async () => {
  const started: Array<{ settings: { model: string; reasoningEffort: string }; autonomy: string }> = [];
  const runs = {
    get: () => undefined,
    start: async (opts: (typeof started)[number]) => {
      started.push(opts);
      return { id: 'new-session', state: 'running' };
    },
  } as unknown as Runs;
  const c = await connect({ runs });
  try {
    const typo = await c.call('droid_start', { cwd: project, prompt: 'hi', model: 'claude-opus-5-6', idempotencyKey: 'm1' });
    assert.equal(typo.isError, true);
    assert.match(typo.text, /unknown model 'claude-opus-5-6'; close matches: .*claude-opus-5-5/);
    const effort = await c.call('droid_start', { cwd: project, prompt: 'hi', model: 'claude-opus-5-5', reasoningEffort: 'off', idempotencyKey: 'm2' });
    assert.match(effort.text, /not supported by claude-opus-5-5/);
    const mission = await c.call('droid_start', { cwd: project, prompt: 'hi', mission: true, idempotencyKey: 'm3' });
    assert.match(mission.text, /mission mode requires autonomy "high"/);
    const flag = await c.call('droid_start', { cwd: project, prompt: 'hi', worktree: '--skip-permissions-unsafe', idempotencyKey: 'm4' });
    assert.equal(flag.isError, true);
    assert.equal(started.length, 0);

    const ok = await c.call('droid_start', {
      cwd: project,
      prompt: 'hi',
      model: 'custom:my-proxy:opus-5-5',
      reasoningEffort: 'high',
      idempotencyKey: 'm1',
    });
    assert.equal(ok.json.sessionId, 'new-session');
    const [opts] = started;
    assert.equal(opts.settings.model, 'custom:my-proxy:opus-5-5');
    assert.equal(opts.settings.reasoningEffort, 'high');
    assert.equal(opts.autonomy, 'off');
  } finally {
    await c.close();
  }
});

test('Runs.send applies settings, autonomy and merged tags before the prompt', async () => {
  const calls: string[] = [];
  const updates: unknown[] = [];
  const session = {
    settings: { tags: [{ name: 'droid-mcp' }, { name: 'pr', metadata: { url: 'u' } }] },
    updateSettings: async (u: unknown) => {
      calls.push('update');
      updates.push(u);
    },
    stream: async function* () {
      calls.push('stream');
    },
  };
  const run = {
    id: 's',
    repo: 'r',
    session,
    state: 'idle',
    events: [],
    nextSeq: 1,
    pending: new Map(),
    lock: Promise.resolve(),
    waiters: new Set(),
  } as unknown as OwnRun;
  const runs = new Runs({ repoOf: (cwd) => cwd });
  await runs.send(run, 'hi', 'queue', { settings: { model: 'claude-opus-5-5', removeTools: ['Execute'], tags: ['pr', 'x'] }, autonomy: 'low' });
  await run.turn;
  assert.deepEqual(calls, ['update', 'stream']);
  assert.deepEqual(updates, [
    {
      modelId: 'claude-opus-5-5',
      disabledToolIds: ['Execute'],
      autonomyLevel: 'low',
      tags: [{ name: 'droid-mcp' }, { name: 'pr', metadata: { url: 'u' } }, { name: 'x' }],
    },
  ]);
  await runs.send(run, 'again', 'queue');
  await run.turn;
  assert.equal(updates.length, 1, 'a send without settings does not touch them');
});

test('droid_send over REST updates the session first and reports what it could not apply', async () => {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const text = await req.text();
    calls.push({ method: req.method, path: new URL(req.url).pathname, body: text ? JSON.parse(text) : undefined });
    return Response.json(req.method === 'PATCH' ? { sessionId: IDS.liveAgentNewer } : { messageId: 'm1', status: 'running' });
  }) as typeof globalThis.fetch;
  const c = await connect({ rest: createRest({ apiKey: 'k', fetch }) });
  try {
    const res = await c.call('droid_send', {
      session: IDS.liveAgentNewer,
      prompt: 'go',
      idempotencyKey: 'rest-settings',
      model: 'claude-opus-5-5',
      reasoningEffort: 'high',
      autonomy: 'medium',
      tags: ['x'],
      worktree: true,
    });
    assert.deepEqual(res.json, {
      via: 'rest',
      sessionId: IDS.liveAgentNewer,
      messageId: 'm1',
      status: 'running',
      applied: ['model', 'reasoningEffort', 'autonomyLevel'],
      ignored: ['tags', 'worktree'],
    });
    assert.deepEqual(
      calls.map((x) => `${x.method} ${x.path}`),
      [`PATCH /api/v0/sessions/${IDS.liveAgentNewer}`, `POST /api/v0/sessions/${IDS.liveAgentNewer}/messages`],
    );
    assert.deepEqual(calls[0].body, { sessionSettings: { model: 'claude-opus-5-5', reasoningEffort: 'high', autonomyLevel: 'medium' } });
  } finally {
    await c.close();
  }
});

test('droid_send over REST is idempotent across restarts', async () => {
  let posts = 0;
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    if (req.method === 'POST') posts++;
    return Response.json({ messageId: `m${posts}`, status: 'running' });
  }) as typeof globalThis.fetch;
  const rest = createRest({ apiKey: 'k', fetch });
  const keysPath = join(dir, 'idem.json');
  const args = { session: IDS.liveAgentNewer, prompt: 'continue', idempotencyKey: 'retry-me' };

  const first = await connect({ rest, keys: new KeyStore(keysPath) });
  try {
    const a = await first.call('droid_send', args);
    const b = await first.call('droid_send', args);
    assert.deepEqual(a.json, { via: 'rest', sessionId: IDS.liveAgentNewer, messageId: 'm1', status: 'running' });
    assert.deepEqual(b.json, a.json);
  } finally {
    await first.close();
  }
  const second = await connect({ rest, keys: new KeyStore(keysPath) });
  try {
    assert.equal((await second.call('droid_send', args)).json.messageId, 'm1');
    assert.equal(posts, 1);
  } finally {
    await second.close();
  }
});

test('droid_result and droid_wait read local sessions without loading them', async () => {
  const c = await connect({});
  try {
    const result = await c.call('droid_result', { session: IDS.liveStandalone });
    assert.deepEqual(result.json, { sessionId: IDS.liveStandalone, content: '', offset: 0, totalBytes: 0 });
    const wait = await c.call('droid_wait', { session: IDS.liveStandalone });
    assert.equal(wait.json.state, 'local');
    assert.deepEqual(wait.json.events, []);
  } finally {
    await c.close();
  }
});

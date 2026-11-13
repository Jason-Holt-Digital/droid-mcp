import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Computers } from '../src/computers.ts';
import { EventLog } from '../src/events.ts';
import { createRest } from '../src/rest.ts';
import { KeyStore, Runs, type OwnRun, type RunEvent } from '../src/runs.ts';
import { clampWait, DEFAULT_WAIT_MS, LIMIT_BYTES, MAX_WAIT_MS, pageBytes, registerTools, type Ctx } from '../src/tools.ts';
import { catalog, fakeApi, FIXTURES, IDS, SECRET } from './helpers.ts';

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
    computers: new Computers({ rest: ctx.rest, file: join(dir, 'no-computer.json'), hostname: 'test-host' }),
    events: new EventLog(),
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

const NOW = 1_800_000_000_000;
const FLEET = {
  self: { id: 'comp-self', name: 'this-box', providerType: 'byom', status: 'active', providerStatus: null, lastSeenAt: NOW - 20_000, createdAt: 1 },
  laptop: { id: 'comp-laptop', name: 'laptop', providerType: 'byom', status: 'active', providerStatus: null, lastSeenAt: NOW - 90_000, createdAt: 1 },
  desk: { id: 'comp-desk', name: 'old-desk', providerType: 'byom', status: 'active', providerStatus: null, lastSeenAt: NOW - 10 * 3600_000, createdAt: 1 },
  cloudA: { id: 'comp-cloud-a', name: 'cloud-a', providerType: 'e2b', status: 'active', providerStatus: 'running', lastSeenAt: NOW - 30_000, createdAt: 1 },
  cloudB: { id: 'comp-cloud-b', name: 'cloud-b', providerType: 'e2b', status: 'active', providerStatus: 'paused', lastSeenAt: NOW - 3600_000, createdAt: 1 },
  slow: { id: 'comp-slow', name: 'slow-box', providerType: 'byom', status: 'active', providerStatus: null, lastSeenAt: NOW - 10_000, createdAt: 1 },
};
const REMOTE = {
  laptopStandalone: '3f0c8a52-1d4e-5b6f-9a7c-2e8d1f0b4c61',
  laptopAgent: '6b2d9e14-7a3c-5f80-b1d2-4c9e8f7a6b53',
  cloudStandalone: '9e7a1c35-2b4d-5e6f-8a9b-0c1d2e3f4a75',
};
const remoteSession = (sessionId: string, title: string, updatedAt: number, tags: unknown[] = []) => ({
  sessionId,
  title,
  status: 'idle',
  createdAt: updatedAt - 1,
  updatedAt,
  messageCount: 3,
  tags,
});

async function fleet(opts: { clock?: { now: number }; ctx?: Partial<Ctx> } = {}) {
  const clock = opts.clock ?? { now: NOW };
  const computerFile = join(dir, 'computer.json');
  await writeFile(computerFile, JSON.stringify({ computerId: FLEET.self.id, registeredAt: 1 }));
  const api = fakeApi((c) => {
    if (c.method === 'GET' && c.path === '/api/v0/computers') {
      const age = clock.now - NOW;
      return { computers: Object.values(FLEET).map((x) => ({ ...x, lastSeenAt: x.lastSeenAt - (x.providerType === 'byom' ? age : 0) })) };
    }
    if (c.method === 'GET' && c.path === '/api/v0/sessions') {
      const id = c.query.get('computerId');
      if (id === FLEET.laptop.id) {
        return {
          sessions: [
            remoteSession(REMOTE.laptopStandalone, 'Fix the laptop build', 50_000),
            remoteSession(IDS.liveStandalone, 'Same session seen over REST', 60_000),
            remoteSession(REMOTE.laptopAgent, 'Agent on the laptop', Date.now() + 3600_000, [
              { name: 'mission-v2', metadata: { kind: 'agent', missionId: IDS.liveOrchestrator } },
            ]),
          ],
          pagination: { hasMore: false, nextCursor: null },
        };
      }
      if (id === FLEET.cloudA.id) {
        return { sessions: [remoteSession(REMOTE.cloudStandalone, 'Cloud job', 30_000)], pagination: { hasMore: true, nextCursor: 'c2' } };
      }
      if (id === FLEET.slow.id) {
        return new Promise((_, reject) => c.signal.addEventListener('abort', () => reject(c.signal.reason)));
      }
      return undefined;
    }
    if (c.method === 'GET' && c.path.endsWith('/children')) return { sessions: [] };
    if (c.method === 'GET' && c.path.endsWith('/elicitations')) return { elicitations: [] };
    if (c.method === 'GET' && c.path.startsWith('/api/v0/sessions/')) {
      return { sessionId: 'x', status: 'idle', messageCount: 0, createdAt: 1, updatedAt: 2 };
    }
    if (c.method === 'POST' && c.path.endsWith('/messages')) return { messageId: 'm1', status: 'running' };
    return undefined;
  });
  const rest = createRest({ apiKey: 'k', fetch: api.fetch });
  const computers = new Computers({ rest, file: computerFile, now: () => clock.now, hostname: 'test-host' });
  const c = await connect({ rest, computers, fanoutTimeoutMs: 200, ...opts.ctx });
  return { c, api, clock };
}

type Found = { id: string; computer: string; title: string };

test('droid_find merges this machine with online computers, dedupes, labels computers and reports the rest', async () => {
  const { c, api } = await fleet();
  try {
    const t = Date.now();
    const res = await c.call('droid_find', { limit: 200 });
    assert.equal(res.isError, false, res.text);
    assert.ok(Date.now() - t < 3000, 'a hanging computer is cut off by its timeout');
    const listed = api.calls.filter((x) => x.path === '/api/v0/sessions').map((x) => x.query.get('computerId'));
    assert.deepEqual(listed.sort(), [FLEET.cloudA.id, FLEET.laptop.id, FLEET.slow.id].sort(), 'only other online computers are listed');
    assert.ok(api.calls.every((x) => x.query.get('limit') === null || x.query.get('limit') === '100'));

    assert.deepEqual(res.json.computers.searched.sort(), ['cloud-a', 'laptop', 'this-box']);
    assert.deepEqual(
      res.json.computers.skipped.map((s: { name: string; state: string }) => [s.name, s.state]).sort(),
      [['cloud-b', 'paused'], ['old-desk', 'offline']],
    );
    assert.match(res.json.computers.skipped.find((s: { name: string }) => s.name === 'old-desk').lastSeen, /^20\d\d-\d\d-\d\dT/);
    assert.deepEqual(res.json.computers.failed.map((f: { name: string }) => f.name), ['slow-box']);
    assert.match(res.json.computers.failed[0].error, /timed out/);
    assert.deepEqual(res.json.computers.truncated, ['cloud-a']);

    const sessions: Found[] = res.json.sessions.flatMap((g: { sessions: Found[] }) => g.sessions);
    const byId = new Map(sessions.map((s) => [s.id, s]));
    assert.equal(byId.get(IDS.liveStandalone)?.computer, 'this-box', 'the local record wins a duplicate');
    assert.equal(sessions.filter((s) => s.id === IDS.liveStandalone).length, 1);
    assert.equal(byId.get(REMOTE.laptopStandalone)?.computer, 'laptop');
    assert.equal(byId.get(REMOTE.cloudStandalone)?.computer, 'cloud-a');
    const laptopGroup = res.json.sessions.find((g: { computer?: string }) => g.computer === 'laptop');
    assert.deepEqual(laptopGroup.sessions.map((s: Found) => s.id), [REMOTE.laptopStandalone], 'remote standalone sessions group by computer');
    assert.equal(laptopGroup.repo, undefined);

    const ws = res.json.workstreams.find((w: { id: string }) => w.id === IDS.liveOrchestrator);
    assert.equal(ws.orchestrator.computer, 'this-box');
    const agents = ws.agents.map((a: Found) => [a.id, a.computer]);
    assert.deepEqual(agents[0], [REMOTE.laptopAgent, 'laptop'], 'a workstream spans computers, agents newest first');
    assert.deepEqual(
      agents.slice(1).sort(),
      [[IDS.liveAgentNewer, 'this-box'], [IDS.liveAgentOlder, 'this-box']].sort(),
    );
    assert.equal(res.json.workstreams[0].id, IDS.liveOrchestrator, 'workstreams with an orchestrator still come first');

    const one = await c.call('droid_find', { computer: 'Laptop' });
    assert.deepEqual(one.json.computers.searched, ['laptop']);
    assert.ok(one.json.sessions.every((g: { computer?: string }) => g.computer === 'laptop'));

    const content = await c.call('droid_find', { query: 'nothing-matches-this', content: true });
    assert.equal(content.json.contentSearch, 'this machine only');
    assert.deepEqual(content.json.computers.searched, ['this-box']);
  } finally {
    await c.close();
  }
});

test('an unfiltered droid_find forgets a remembered remote computer for a session found locally', async () => {
  const sessionComputers = new Map([[IDS.liveStandalone, FLEET.laptop.id]]);
  const { c } = await fleet({ ctx: { sessionComputers } });
  try {
    const res = await c.call('droid_find', { limit: 200 });
    assert.equal(res.isError, false, res.text);
    assert.equal(sessionComputers.has(IDS.liveStandalone), false);
    assert.equal(sessionComputers.get(REMOTE.laptopStandalone), FLEET.laptop.id);
  } finally {
    await c.close();
  }
});

test('a session tool naming an offline computer refuses before calling the session API', async () => {
  const { c, api } = await fleet();
  try {
    for (const [name, args] of [
      ['droid_wait', { session: REMOTE.laptopStandalone, computer: 'old-desk' }],
      ['droid_send', { session: REMOTE.laptopStandalone, computer: 'comp-desk', prompt: 'hi', idempotencyKey: 'off1' }],
      ['droid_result', { session: REMOTE.laptopStandalone, computer: 'old-desk' }],
      ['droid_cancel', { session: REMOTE.laptopStandalone, computer: 'old-desk', scope: 'turn' }],
      ['droid_respond', { session: REMOTE.laptopStandalone, computer: 'old-desk', requestId: 'r', cancel: true }],
    ] as const) {
      const res = await c.call(name, args);
      assert.equal(res.isError, true, name);
      assert.match(res.text, /computer old-desk is offline \(daemon last seen 20\d\d-[\d-]+T[\d:]+Z\); start its daemon or pick another computer/, name);
    }
    assert.deepEqual(api.calls.filter((x) => x.path.startsWith('/api/v0/sessions')), []);
    const missing = await c.call('droid_wait', { session: REMOTE.laptopStandalone, computer: 'nope' });
    assert.match(missing.text, /no computer named nope; known computers: this-box, laptop/);
  } finally {
    await c.close();
  }
});

test('send and wait pass computerId for a named or remembered computer, and a remembered offline computer refuses', async () => {
  const { c, api, clock } = await fleet();
  try {
    const sent = await c.call('droid_send', { session: REMOTE.cloudStandalone, computer: 'cloud-a', prompt: 'go', idempotencyKey: 'c1' });
    assert.equal(sent.json.via, 'rest', sent.text);
    const post = api.calls.find((x) => x.method === 'POST' && x.path === `/api/v0/sessions/${REMOTE.cloudStandalone}/messages`);
    assert.deepEqual(post?.body, { text: 'go', computerId: FLEET.cloudA.id });

    await c.call('droid_find', {});
    const wait = await c.call('droid_wait', { session: REMOTE.laptopStandalone, waitMs: 0 });
    assert.equal(wait.isError, false, wait.text);
    const get = api.calls.find((x) => x.path === `/api/v0/sessions/${REMOTE.laptopStandalone}`);
    assert.equal(get?.query.get('computerId'), FLEET.laptop.id, 'remembered from droid_find');

    clock.now += 10 * 60_000;
    const before = api.calls.length;
    const stale = await c.call('droid_send', { session: REMOTE.laptopStandalone, prompt: 'hi', idempotencyKey: 'c2' });
    assert.match(stale.text, /computer laptop is offline/);
    assert.ok(api.calls.slice(before).every((x) => x.path === '/api/v0/computers'));
  } finally {
    await c.close();
  }
});

test('droid_send on a closed owned run follows the named computer instead of treating it as owned', async () => {
  const run = { id: '8c1d2e3f-4a5b-5c6d-9e7f-0a1b2c3d4e5f', state: 'closed', events: [], waiters: new Set() } as unknown as OwnRun;
  class OwnedRuns extends Runs {
    get(id: string) {
      return id === run.id ? run : undefined;
    }
  }
  const { c, api } = await fleet({ ctx: { runs: new OwnedRuns({ repoOf: (cwd) => cwd }) } });
  try {
    const sent = await c.call('droid_send', { session: run.id, computer: 'cloud-a', prompt: 'go', idempotencyKey: 'closed1' });
    assert.equal(sent.json?.via, 'rest', sent.text);
    const post = api.calls.find((x) => x.method === 'POST' && x.path === `/api/v0/sessions/${run.id}/messages`);
    assert.deepEqual(post?.body, { text: 'go', computerId: FLEET.cloudA.id });
    const offline = await c.call('droid_send', { session: run.id, computer: 'old-desk', prompt: 'go', idempotencyKey: 'closed2' });
    assert.match(offline.text, /computer old-desk is offline/);
  } finally {
    await c.close();
  }
});

test('a failed computer lookup in droid_send leaves the idempotencyKey free for a retry', async () => {
  let computerCalls = 0;
  const api = fakeApi((call) => {
    if (call.method === 'GET' && call.path === '/api/v0/computers') {
      if (computerCalls++ === 0) return Response.json({ status: 503, title: 'Unavailable' }, { status: 503 });
      return { computers: [{ ...FLEET.cloudA, lastSeenAt: Date.now() }] };
    }
    if (call.method === 'POST' && call.path.endsWith('/messages')) return { messageId: 'm1', status: 'running' };
    return undefined;
  });
  const rest = createRest({ apiKey: 'k', fetch: api.fetch });
  const c = await connect({ rest, keys: new KeyStore(join(dir, 'lookup-retry.json')) });
  try {
    const args = { session: REMOTE.cloudStandalone, computer: 'cloud-a', prompt: 'go', idempotencyKey: 'lookup-retry' };
    const first = await c.call('droid_send', args);
    assert.equal(first.isError, true);
    assert.match(first.text, /503/);
    const retry = await c.call('droid_send', args);
    assert.equal(retry.isError, false, retry.text);
    assert.equal(retry.json.messageId, 'm1');
  } finally {
    await c.close();
  }
});
test('a run this server owns is read and closed locally even when its session is remembered on an offline computer', async () => {
  let closed = false;
  const run = {
    id: REMOTE.laptopStandalone,
    cwd: project,
    repo: project,
    state: 'idle',
    events: [{ seq: 1, at: NOW, kind: 'assistant', text: 'done here' }],
    nextSeq: 2,
    pending: new Map(),
    lastResult: 'the owned result',
    lock: Promise.resolve(),
    waiters: new Set(),
    close: async () => {
      closed = true;
    },
  } as unknown as OwnRun;
  class OwnedRuns extends Runs {
    get(id: string) {
      return id === run.id ? run : undefined;
    }
  }
  const { c, api } = await fleet({
    ctx: { runs: new OwnedRuns({ repoOf: (cwd) => cwd }), sessionComputers: new Map([[run.id, FLEET.desk.id]]) },
  });
  try {
    const wait = await c.call('droid_wait', { session: run.id, afterSeq: 0, waitMs: 0 });
    assert.equal(wait.isError, false, wait.text);
    assert.deepEqual(wait.json.events.map((e: { text: string }) => e.text), ['done here']);
    const result = await c.call('droid_result', { session: run.id });
    assert.equal(result.json.content, 'the owned result', result.text);
    const named = await c.call('droid_result', { session: run.id, computer: 'old-desk' });
    assert.equal(named.json.content, 'the owned result', named.text);
    const cancel = await c.call('droid_cancel', { session: run.id, scope: 'session' });
    assert.equal(cancel.json.state, 'closed', cancel.text);
    assert.equal(closed, true);
    assert.deepEqual(api.calls.filter((x) => x.path.startsWith('/api/v0/sessions')), []);
  } finally {
    await c.close();
  }
});

test('droid_computers lists state per computer, and only this machine without a key', async () => {
  const { c } = await fleet();
  try {
    const res = await c.call('droid_computers', {});
    assert.equal(res.json.onlineWindowMinutes, 5);
    const states = Object.fromEntries(res.json.computers.map((x: { name: string; state: string }) => [x.name, x.state]));
    assert.deepEqual(states, { 'this-box': 'online', laptop: 'online', 'old-desk': 'offline', 'cloud-a': 'online', 'cloud-b': 'paused', 'slow-box': 'online' });
    assert.equal(res.json.computers.find((x: { thisMachine: boolean }) => x.thisMachine).name, 'this-box');
  } finally {
    await c.close();
  }
  const bare = await connect({});
  try {
    const res = await bare.call('droid_computers', {});
    assert.deepEqual(res.json.computers.map((x: { name: string; state: string; thisMachine: boolean }) => [x.name, x.state, x.thisMachine]), [
      ['test-host', 'online', true],
    ]);
    assert.match(res.json.note, /FACTORY_API_KEY/);
  } finally {
    await bare.close();
  }
});

test('droid_events pages the event log and says whether forwarding is on', async () => {
  const events = new EventLog();
  const c = await connect({ events });
  try {
    for (const kind of ['finished', 'question', 'ended'] as const) {
      events.add({ sessionId: IDS.liveStandalone, kind, text: `${kind} text` }, { computer: 'laptop', watched: false, forwarding: false });
    }
    const all = await c.call('droid_events', { after: 0 });
    assert.deepEqual(all.json.events.map((e: { seq: number }) => e.seq), [1, 2, 3]);
    assert.equal(all.json.nextAfter, 3);
    assert.equal(all.json.forwarding, 'off');
    assert.match(all.json.note, /untrusted/);
    assert.match(all.json.events[0].at, /^\d{4}-/);
    const questions = await c.call('droid_events', { after: 0, kinds: ['question'] });
    assert.deepEqual(questions.json.events.map((e: { kind: string }) => e.kind), ['question']);
    assert.equal(questions.json.nextAfter, 3);
    const page = await c.call('droid_events', { after: 0, limit: 2 });
    assert.equal(page.json.nextAfter, 2);
  } finally {
    await c.close();
  }
});

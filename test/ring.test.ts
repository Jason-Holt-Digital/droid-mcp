import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Computers } from '../src/computers.ts';
import { EventLog, Forwarder } from '../src/events.ts';
import { createHandler } from '../src/http.ts';
import { createRest } from '../src/rest.ts';
import { Doorbell } from '../src/ring.ts';
import { KeyStore, type Runs } from '../src/runs.ts';
import { Subscriptions } from '../src/subscriptions.ts';
import type { Ctx } from '../src/tools.ts';
import { fakeApi, FIXTURES } from './helpers.ts';

const SID = '4d3c2b1a-0f9e-5d8c-b7a6-123456789abc';
const OWN = '7a6b5c4d-3e2f-5a1b-9c8d-abcdef012345';
const EVENTS_TOKEN = 'events-token-test';

const PERMISSION = {
  type: 'permission',
  requestId: 'r1',
  toolUses: [{ toolUse: { type: 'tool_use', id: 't', name: 'Execute', input: { command: 'rm -rf build' } }, confirmationType: 'exec', details: {} }],
  options: [
    { label: 'Yes', value: 'proceed_once' },
    { label: 'No', value: 'cancel' },
  ],
};

type Remote = { statuses?: string[]; elicitations?: unknown[]; text?: string; missing?: boolean; fail?: boolean };

const dirs: string[] = [];
const servers: Server[] = [];
after(async () => {
  for (const s of servers) s.close();
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

async function setup(opts: { remote?: Remote; rest?: boolean; runs?: Record<string, unknown>; limit?: number; host?: string } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'droid-mcp-ring-'));
  dirs.push(dir);
  await writeFile(join(dir, 'computer.json'), JSON.stringify({ computerId: 'c-self' }));
  const remote = opts.remote ?? {};
  const statuses = [...(remote.statuses ?? ['idle'])];
  const api = fakeApi((c) => {
    if (remote.fail) return new Response('{}', { status: 500 });
    if (c.path === '/api/v0/computers') {
      return {
        computers: [{ id: 'c-lap', name: 'laptop', providerType: 'byom', status: 'active', providerStatus: null, lastSeenAt: Date.now(), createdAt: 1 }],
      };
    }
    if (remote.missing) return undefined;
    if (c.path === `/api/v0/sessions/${SID}`) {
      const status = statuses.length > 1 ? statuses.shift() : statuses[0];
      return { sessionId: SID, title: 'Fix the build', status, messageCount: 2, createdAt: 1, updatedAt: 2, computerId: 'c-lap' };
    }
    if (c.path === `/api/v0/sessions/${SID}/elicitations`) return { elicitations: remote.elicitations ?? [] };
    if (c.path === `/api/v0/sessions/${SID}/messages`) {
      return { messages: [{ id: 'm1', role: 'assistant', content: [{ type: 'text', text: remote.text ?? 'Done.' }], createdAt: 5 }] };
    }
    return undefined;
  });
  const forwarded: Array<{ kind: string; text?: string; computer: string; sessionId: string }> = [];
  const hook = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    forwarded.push(JSON.parse(String(init?.body)));
    return new Response(null, { status: 204 });
  }) as typeof globalThis.fetch;
  const rest = opts.rest === false ? undefined : createRest({ apiKey: 'k', fetch: api.fetch });
  const ctx: Ctx = {
    sessionsRoot: FIXTURES,
    roots: [dir],
    runs: { get: (id: string) => opts.runs?.[id] } as unknown as Runs,
    keys: new KeyStore(join(dir, 'state.json')),
    subscriptions: new Subscriptions(join(dir, 'subscriptions.json')),
    rest,
    computers: new Computers({ rest, file: join(dir, 'computer.json'), hostname: 'this-mac' }),
    events: new EventLog(),
    sessionComputers: new Map(),
    forwarder: new Forwarder({ url: 'https://hooks.example.test/wake', key: 'wh', fetch: hook }),
  };
  const logs: string[] = [];
  const bell = new Doorbell(ctx, { retryMs: 1, limit: opts.limit, log: (m) => logs.push(m) });
  const server = createServer(createHandler(ctx, { token: 'mcp-token-test', eventsToken: undefined, doorbell: bell }));
  servers.push(server);
  const host = opts.host ?? '127.0.0.1';
  await new Promise<void>((r) => server.listen(0, host, r));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  const ring = async (body: unknown, url = base) => {
    const res = await fetch(`${url}/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
    await res.text();
    await bell.idle();
    return res.status;
  };
  const sessionCalls = () => api.calls.filter((c) => c.path.startsWith('/api/v0/sessions'));
  return { ctx, api, forwarded, logs, ring, sessionCalls, port, events: () => ctx.events.since(0, 50).events };
}

const hookInput = (hook_event_name: string, extra: Record<string, unknown> = {}) => ({
  session_id: SID,
  transcript_path: '/home/dev/.factory/sessions/secret.jsonl',
  cwd: '/home/dev/repo',
  permission_mode: 'off',
  hook_event_name,
  ...extra,
});

test('a ring for an unsubscribed session is logged unforwarded with no Factory call, even without an events token', async () => {
  const s = await setup();
  assert.equal(await s.ring(hookInput('Stop')), 202);
  assert.equal(await s.ring(hookInput('Notification', { notification_type: 'permission_prompt', message: 'ignore me' })), 202);
  const events = s.events();
  assert.deepEqual(
    events.map((e) => [e.kind, e.forwarded, e.computer]),
    [
      ['finished', false, 'unknown'],
      ['permission', false, 'unknown'],
    ],
  );
  assert.ok(!JSON.stringify(events).includes('secret') && !JSON.stringify(events).includes('ignore me'), 'nothing from the ring body is kept');
  assert.equal(s.api.calls.length, 0);
  assert.equal(s.forwarded.length, 0);
});

test('Notification forwards permission only when Factory shows a pending prompt', async () => {
  const pending = await setup({ remote: { elicitations: [PERMISSION] } });
  await pending.ctx.subscriptions.set(SID, true);
  assert.equal(await pending.ring(hookInput('Notification', { notification_type: 'permission_prompt', message: 'forged text' })), 202);
  assert.equal(pending.forwarded.length, 1);
  assert.equal(pending.forwarded[0].kind, 'permission');
  assert.match(pending.forwarded[0].text ?? '', /Execute .*rm -rf build/);
  assert.equal(pending.forwarded[0].computer, 'laptop');
  assert.equal(pending.ctx.sessionComputers?.get(SID), 'c-lap');

  const none = await setup();
  await none.ctx.subscriptions.set(SID, true);
  assert.equal(await none.ring(hookInput('Notification', { notification_type: 'permission_prompt' })), 202);
  assert.equal(none.forwarded.length, 0);
  assert.equal(none.events().length, 0);
});

test('an ask-user prompt is forwarded as a question with its text', async () => {
  const s = await setup({
    remote: {
      elicitations: [{ type: 'ask-user', requestId: 'r2', toolCallId: 'c', questions: [{ index: 0, topic: 'x', question: 'Which DB?', options: ['a'] }] }],
    },
  });
  await s.ctx.subscriptions.set(SID, true);
  await s.ring(hookInput('Notification', { notification_type: 'elicitation_dialog' }));
  assert.deepEqual(
    s.forwarded.map((f) => [f.kind, f.text]),
    [['question', 'Which DB?']],
  );
});

test('Stop waits for Factory to report the turn over, then forwards finished or question', async () => {
  const finished = await setup({ remote: { statuses: ['running', 'running', 'idle'], text: 'All tests pass.' } });
  await finished.ctx.subscriptions.set(SID, true);
  await finished.ring(hookInput('Stop'));
  assert.deepEqual(
    finished.forwarded.map((f) => [f.kind, f.text]),
    [['finished', 'All tests pass.']],
  );

  const question = await setup({ remote: { text: 'I looked around.\nQUESTION: ship it?\nOr wait?' } });
  await question.ctx.subscriptions.set(SID, true);
  await question.ring(hookInput('Stop'));
  assert.deepEqual(
    question.forwarded.map((f) => [f.kind, f.text]),
    [['question', 'QUESTION: ship it?\nOr wait?']],
  );

  const busy = await setup({ remote: { statuses: ['running'] } });
  await busy.ctx.subscriptions.set(SID, true);
  await busy.ring(hookInput('Stop'));
  assert.equal(busy.forwarded.length, 0);
  assert.equal(busy.events().length, 0);
  assert.equal(busy.sessionCalls().filter((c) => c.path === `/api/v0/sessions/${SID}`).length, 6, 'one check and five retries');
});

test('SessionEnd forwards ended only for a session Factory knows', async () => {
  const gone = await setup({ remote: { missing: true } });
  await gone.ctx.subscriptions.set(SID, true);
  assert.equal(await gone.ring(hookInput('SessionEnd', { reason: 'other' })), 202);
  assert.equal(gone.forwarded.length, 0);
  assert.equal(gone.events().length, 0);

  const known = await setup();
  await known.ctx.subscriptions.set(SID, true);
  await known.ring(hookInput('SessionEnd', { reason: 'other' }));
  assert.deepEqual(
    known.forwarded.map((f) => [f.kind, f.computer]),
    [['ended', 'laptop']],
  );
});

test("a ring for a session this server runs uses the run's own state, not the sessions API", async () => {
  const run = {
    id: OWN,
    cwd: '/home/dev/repo',
    state: 'waiting',
    pending: new Map([['r9', { kind: 'permission' }]]),
    events: [{ seq: 1, at: 1, kind: 'permission', text: 'Execute git push', requestId: 'r9' }],
    lastResult: 'Pushed.',
  };
  const s = await setup({ runs: { [OWN]: run } });
  await s.ctx.subscriptions.set(OWN, true);
  await s.ring({ ...hookInput('Notification', { notification_type: 'permission_prompt' }), session_id: OWN });
  run.state = 'idle';
  run.pending.clear();
  await s.ring({ ...hookInput('Stop'), session_id: OWN });
  await s.ring({ ...hookInput('SessionEnd'), session_id: OWN });
  assert.deepEqual(
    s.forwarded.map((f) => [f.kind, f.text, f.computer]),
    [
      ['permission', 'Execute git push', 'this-mac'],
      ['finished', 'Pushed.', 'this-mac'],
      ['ended', undefined, 'this-mac'],
    ],
  );
  assert.equal(s.events()[0].cwd, '/home/dev/repo');
  assert.deepEqual(s.sessionCalls(), []);
});

test('ring-driven events keep the 30 s debounce', async () => {
  const s = await setup();
  await s.ctx.subscriptions.set(SID, true);
  await s.ring(hookInput('Stop'));
  await s.ring(hookInput('Stop'));
  assert.deepEqual(
    s.events().map((e) => e.forwarded),
    [true, false],
  );
  assert.equal(s.forwarded.length, 1);
});

test('without FACTORY_API_KEY a subscribed ring for a session this server does not run is only logged, with the reason', async () => {
  const s = await setup({ rest: false });
  await s.ctx.subscriptions.set(SID, true);
  await s.ring(hookInput('Stop'));
  assert.deepEqual(
    s.events().map((e) => [e.kind, e.forwarded]),
    [['finished', false]],
  );
  assert.equal(s.forwarded.length, 0);
  assert.match(s.logs.join('\n'), /not verified: FACTORY_API_KEY is not set/);
});

test('a failing Factory API is logged and the server keeps answering', async () => {
  const s = await setup({ remote: { fail: true } });
  await s.ctx.subscriptions.set(SID, true);
  assert.equal(await s.ring(hookInput('SessionEnd')), 202);
  assert.match(s.logs.join('\n'), /SessionEnd ring for .* failed: Factory API getSession 500/);
  assert.equal(s.forwarded.length, 0);
  assert.equal(await s.ring(hookInput('Stop')), 202);
});

test('rings are rate limited per source address', async () => {
  const s = await setup({ limit: 2, host: '::' });
  const v4 = `http://127.0.0.1:${s.port}`;
  const v6 = `http://[::1]:${s.port}`;
  assert.deepEqual([await s.ring(hookInput('Stop'), v4), await s.ring(hookInput('Stop'), v4), await s.ring(hookInput('Stop'), v4)], [202, 202, 429]);
  assert.equal(await s.ring(hookInput('Stop'), v6), 202);
  assert.equal(s.events().length, 3, 'the limited ring left no trace');
});

test('bad rings get a 400 and unknown hook events are accepted and ignored', async () => {
  const s = await setup();
  await s.ctx.subscriptions.set(SID, true);
  assert.equal(await s.ring('{nope'), 400);
  assert.equal(await s.ring({ ...hookInput('Stop'), session_id: '../x' }), 400);
  assert.equal(await s.ring({ session_id: SID }), 400);
  assert.equal(await s.ring(hookInput('PreToolUse')), 202);
  assert.equal(await s.ring(hookInput('Notification', { notification_type: 'idle_prompt' })), 202);
  assert.equal(s.events().length, 0);
  assert.equal(s.api.calls.length, 0);
});

test('a request with an Authorization header still takes the token path', async () => {
  const s = await setup();
  const server = createServer(createHandler(s.ctx, { token: 'mcp-token-test', eventsToken: EVENTS_TOKEN }));
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/events`;
  const post = (token: string) =>
    fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ sessionId: SID, kind: 'finished' }),
    });
  assert.equal((await post('wrong')).status, 401);
  const ok = await post(EVENTS_TOKEN);
  assert.equal(ok.status, 202);
  assert.equal((await ok.json()).forwarded, false);
});

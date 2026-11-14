import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { openSession, type Access } from '../src/access.ts';
import type { Computer } from '../src/computers.ts';
import { API_KEY_FIX } from '../src/config.ts';
import type { Rest } from '../src/rest.ts';
import type { OwnRun, RunEvent, Runs } from '../src/runs.ts';
import type { Ctx } from '../src/tools.ts';
import { permission } from './helpers.ts';

const STANDALONE = '4a1b2c3d-4e5f-5a6b-8c7d-9e0f1a2b3c4d';
const AGENT = '5b2c3d4e-5f6a-5b7c-9d8e-0f1a2b3c4d5e';
const REMOTE = '6c3d4e5f-6a7b-5c8d-8e9f-1a2b3c4d5e6f';
const OWN = '7d4e5f6a-7b8c-5d9e-9f0a-2b3c4d5e6f7a';

let root: string;
let cwd: string;

const line = (role: string, text: string) => JSON.stringify({ type: 'message', message: { role, content: [{ type: 'text', text }] } });

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'droid-mcp-access-'));
  cwd = join(root, 'repo');
  const dir = join(root, 'sessions', '-repo');
  await mkdir(dir, { recursive: true });
  await mkdir(cwd);
  const start = (id: string) => JSON.stringify({ type: 'session_start', id, title: id, cwd });
  await writeFile(
    join(dir, `${STANDALONE}.jsonl`),
    [start(STANDALONE), line('user', 'one'), line('assistant', 'old'), line('user', 'two'), line('assistant', 'a'), line('assistant', 'b'), ''].join('\n'),
  );
  await writeFile(join(dir, `${STANDALONE}.settings.json`), JSON.stringify({ tags: [], autonomyLevel: 'off' }));
  await writeFile(join(dir, `${AGENT}.jsonl`), `${start(AGENT)}\n`);
  await writeFile(join(dir, `${AGENT}.settings.json`), JSON.stringify({ tags: [{ name: 'mission-v2', metadata: { kind: 'agent', missionId: 'm1' } }] }));
});
after(() => rm(root, { recursive: true, force: true }));

const COMPUTERS: Computer[] = [
  { id: 'comp-self', name: 'self', kind: 'own', state: 'online', thisMachine: true },
  { id: 'comp-laptop', name: 'laptop', kind: 'own', state: 'online', thisMachine: false },
  { id: 'comp-desk', name: 'desk', kind: 'own', state: 'offline', lastSeenAt: 0, thisMachine: false },
];

function fakeRest() {
  const calls: Array<[string, ...unknown[]]> = [];
  const rest = {
    status: async (id: string, computerId?: string) => {
      calls.push(['status', id, computerId]);
      return { status: 'idle', messageCount: 2, elicitations: [] };
    },
    messages: async (id: string, q: { computerId?: string; role?: string }) => {
      calls.push(['messages', id, q.computerId, q.role]);
      return {
        messages: [
          { id: 'b', role: 'assistant', text: 'newest', createdAt: 2, seq: 2 },
          { id: 'a', role: 'user', text: 'hello', createdAt: 1, seq: 1 },
        ],
      };
    },
    elicitations: async (id: string) => {
      calls.push(['elicitations', id]);
      return [permission('r1', 'ls')];
    },
    answer: async (id: string, requestId: string, body: unknown) => {
      calls.push(['answer', id, requestId, body]);
    },
    interrupt: async (id: string) => {
      calls.push(['interrupt', id]);
    },
  } as unknown as Rest;
  return { rest, calls };
}

function ownRun(): { runs: Runs; run: OwnRun; calls: unknown[][] } {
  const calls: unknown[][] = [];
  const events: RunEvent[] = [
    { seq: 1, at: 1, kind: 'user', text: 'hi' },
    { seq: 2, at: 2, kind: 'assistant', text: 'hello' },
  ];
  const run = { id: OWN, cwd, state: 'idle', events, pending: new Map() } as unknown as OwnRun;
  const runs = {
    get: (id: string) => (id === OWN ? run : undefined),
    wait: async (_r: OwnRun, afterSeq: number) => ({ events: events.filter((e) => e.seq > afterSeq), gap: false }),
    pendingRequests: () => [],
    respond: (_r: OwnRun, requestId: string, d: unknown) => calls.push(['respond', requestId, d]),
    cancel: async (r: OwnRun, scope: string) => {
      calls.push(['cancel', scope]);
      if (scope === 'session') r.state = 'closed';
    },
  } as unknown as Runs;
  return { runs, run, calls };
}

function ctxWith(patch: Partial<Ctx> = {}): Ctx {
  const computers = {
    list: async () => COMPUTERS,
    require: async (name: string) => COMPUTERS.find((c) => c.name === name || c.id === name)!,
  };
  return { sessionsRoot: join(root, 'sessions'), roots: [root], runs: ownRun().runs, computers, env: {}, ...patch } as unknown as Ctx;
}

const page = async (access: Access, afterSeq?: number) => {
  const p = await access.follow(afterSeq, 0, 50);
  return p.page(p.events);
};

test('own: follows the run, answers and cancels through Runs, and reads its result and cwd', async () => {
  const { runs, run, calls } = ownRun();
  run.lastResult = 'the result';
  const access = await openSession(ctxWith({ runs, sessionComputers: new Map([[OWN, 'comp-desk']]) }), OWN, undefined);
  assert.equal(access.kind, 'own', 'an owned run wins over a remembered offline computer');
  const p = await page(access, 1);
  assert.deepEqual(p, { state: 'idle', gap: undefined, events: [{ seq: 2, at: 2, kind: 'assistant', text: 'hello' }], nextSeq: 2, attention: [] });
  assert.deepEqual(await access.respond('r1', { decision: 'proceed_once' }), { sessionId: OWN, requestId: 'r1', state: 'idle' });
  assert.deepEqual(await access.interrupt(), { sessionId: OWN, state: 'idle' });
  assert.deepEqual(await access.close(), { sessionId: OWN, state: 'closed' });
  assert.deepEqual(calls, [
    ['respond', 'r1', { decision: 'proceed_once' }],
    ['cancel', 'turn'],
    ['cancel', 'session'],
  ]);
  assert.equal(await access.result(), 'the result');
  assert.equal(access.cwd(), cwd);
});

test('local without a key: reads the transcript, refuses close, and needs a key to answer or interrupt', async () => {
  const access = await openSession(ctxWith(), STANDALONE, undefined);
  assert.equal(access.kind, 'local');
  const p = await page(access);
  assert.equal(p.state, 'local');
  assert.deepEqual(
    (p.events as Array<{ kind: string; text: string }>).map((e) => `${e.kind}:${e.text}`),
    ['user:one', 'assistant:old', 'user:two', 'assistant:a', 'assistant:b'],
  );
  assert.equal(await access.result(), 'a\n\nb', 'every assistant message after the last user message');
  assert.equal(access.cwd(), cwd);
  await assert.rejects(access.close(), { code: 'invalid', message: 'only sessions this server started can be closed' });
  await assert.rejects(access.respond('r1', { cancel: true }), {
    code: 'needs_api_key',
    message: 'answering prompts for sessions this server did not start needs FACTORY_API_KEY',
    fix: API_KEY_FIX,
  });
  await assert.rejects(access.interrupt(), { code: 'needs_api_key', message: 'cancelling for sessions this server did not start needs FACTORY_API_KEY' });
});

test('local workstream session with a key: followed and answered over REST, result still from the transcript', async () => {
  const { rest, calls } = fakeRest();
  const access = await openSession(ctxWith({ rest }), AGENT, undefined);
  assert.equal(access.kind, 'local');
  const p = await page(access);
  assert.equal(p.state, 'idle');
  assert.deepEqual(
    (p.events as Array<{ seq: number }>).map((e) => e.seq),
    [1, 2],
  );
  assert.deepEqual(await access.respond('r1', { decision: 'proceed_once' }), { sessionId: AGENT, requestId: 'r1', via: 'rest' });
  assert.deepEqual(await access.interrupt(), { sessionId: AGENT, via: 'rest', interrupted: true });
  assert.equal(await access.result(), '');
  assert.deepEqual(calls, [
    ['status', AGENT, undefined],
    ['messages', AGENT, undefined, undefined],
    ['elicitations', AGENT],
    ['answer', AGENT, 'r1', { selectedOption: 'proceed_once', comment: undefined }],
    ['interrupt', AGENT],
  ]);

  const standalone = await openSession(ctxWith({ rest }), STANDALONE, undefined);
  assert.equal((await page(standalone)).state, 'local', 'a standalone local session is read from disk even with a key');
});

test('rest on a named remote computer: passes its computerId, checks decisions, reads the newest assistant text', async () => {
  const { rest, calls } = fakeRest();
  const access = await openSession(ctxWith({ rest }), REMOTE, 'laptop');
  assert.equal(access.kind, 'rest');
  assert.equal(access.computerId, 'comp-laptop');
  assert.equal(access.cwd(), undefined);
  const p = await page(access, 1);
  assert.deepEqual(p.events, [{ seq: 2, kind: 'assistant', text: 'newest' }]);
  assert.equal(p.nextSeq, 2);
  await assert.rejects(access.respond('r1', { decision: 'proceed_always' }), { code: 'invalid', message: 'decision must be one of: proceed_once, cancel' });
  await assert.rejects(access.respond('nope', { cancel: true }), { code: 'not_found', message: 'no pending request nope' });
  assert.equal(await access.result(), 'newest');
  await assert.rejects(access.close(), { code: 'invalid' });
  assert.deepEqual(calls.slice(0, 2), [
    ['status', REMOTE, 'comp-laptop'],
    ['messages', REMOTE, 'comp-laptop', undefined],
  ]);
  assert.deepEqual(calls.at(-1), ['messages', REMOTE, 'comp-laptop', 'assistant']);
});

test('openSession uses a remembered computer, refuses a remembered offline one, and needs a key for an unknown session', async () => {
  const { rest, calls } = fakeRest();
  const remembered = await openSession(ctxWith({ rest, sessionComputers: new Map([[REMOTE, 'comp-laptop']]) }), REMOTE, undefined);
  assert.equal(remembered.kind, 'rest');
  assert.equal(remembered.computerId, 'comp-laptop');

  const here = await openSession(ctxWith({ rest }), STANDALONE, 'self');
  assert.equal(here.kind, 'local', 'naming this machine reads the local transcript');

  await assert.rejects(openSession(ctxWith({ rest, sessionComputers: new Map([[REMOTE, 'comp-desk']]) }), REMOTE, undefined), { code: 'computer_offline' });
  await assert.rejects(openSession(ctxWith(), '../etc', undefined), { code: 'invalid', message: 'invalid session id: ../etc' });
  assert.deepEqual(calls, []);

  const unknown = await openSession(ctxWith(), REMOTE, undefined);
  assert.equal(unknown.kind, 'rest');
  await assert.rejects(unknown.follow(undefined, 0, 50), {
    code: 'needs_api_key',
    message: `session ${REMOTE} is not on this machine; following it needs FACTORY_API_KEY`,
    fix: API_KEY_FIX,
  });
  await assert.rejects(unknown.result(), { code: 'needs_api_key', message: 'reading results for sessions this server did not start needs FACTORY_API_KEY' });
});

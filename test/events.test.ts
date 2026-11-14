import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEBOUNCE_MS, EventLog, Forwarder, parseEventBody, type DroidEvent } from '../src/events.ts';

const SID = '4d3c2b1a-0f9e-5d8c-b7a6-123456789abc';
const OTHER = '5e4d3c2b-1a0f-5e9d-c8b7-23456789abcd';

test('EventLog keeps the newest events, numbers them from 1 and reports a missed range', () => {
  const log = new EventLog(3);
  for (let i = 0; i < 5; i++) log.add({ sessionId: SID, kind: 'finished', text: `t${i}` }, { computer: 'box', forward: false, now: i });
  const all = log.since(0, 50);
  assert.deepEqual(
    all.events.map((e) => e.seq),
    [3, 4, 5],
  );
  assert.equal(all.missed, true, 'events 1 and 2 were evicted');
  assert.equal(all.nextAfter, 5);
  assert.equal(log.since(1, 50).missed, true);
  assert.equal(log.since(2, 50).missed, false, 'nothing between 2 and the oldest kept event was lost');
  assert.deepEqual(log.since(3, 1), { events: [all.events[1]], nextAfter: 4, missed: false });
  assert.deepEqual(log.since(5, 10), { events: [], nextAfter: 5, missed: false });
  assert.deepEqual(
    log.since(undefined, 2).events.map((e) => e.seq),
    [4, 5],
    'without after, the latest events',
  );
  assert.equal(new EventLog().since(0, 5).missed, false);
});

test('EventLog treats a cursor ahead of the log as stale from before a restart', () => {
  const log = new EventLog();
  for (let i = 0; i < 2; i++) log.add({ sessionId: SID, kind: 'finished' }, { computer: 'box', forward: false, now: i });
  const res = log.since(100, 50);
  assert.deepEqual(
    res.events.map((e) => e.seq),
    [1, 2],
  );
  assert.equal(res.nextAfter, 2);
  assert.equal(res.missed, true);
});

test('an event forwards only when asked, and never twice in 30 s for the same session and kind', () => {
  const log = new EventLog();
  const add = (kind: DroidEvent['kind'], now: number, sessionId = SID, forward = true) =>
    log.add({ sessionId, kind }, { computer: 'box', forward, now }).forwarded;
  assert.equal(add('question', 0), true);
  assert.equal(add('question', 10_000), false, 'debounced');
  assert.equal(add('permission', 10_000), true, 'another kind is not debounced');
  assert.equal(add('question', 10_000, OTHER), true, 'another session is not debounced');
  assert.equal(add('question', DEBOUNCE_MS), true, '30 s after the last forward');
  assert.equal(add('finished', 0, SID, false), false, 'not asked to forward');
  assert.equal(add('finished', 1), true, 'an event that was not forwarded does not start the debounce');
  assert.equal(log.since(0, 50).events.length, 7, 'every event is logged, forwarded or not');
});

test('parseEventBody validates the session id and field sizes and drops unknown fields', () => {
  const ok = parseEventBody({ sessionId: SID, kind: 'finished', title: 'T', host: 'h', tags: ['cto'], extra: 'dropped' });
  assert.deepEqual(ok, { sessionId: SID, kind: 'finished', title: 'T', host: 'h', tags: ['cto'] });
  const bad: Array<[string, unknown]> = [
    ['path-like id', { sessionId: '../etc/passwd', kind: 'finished' }],
    ['missing id', { kind: 'finished' }],
    ['unknown kind', { sessionId: SID, kind: 'exploded' }],
    ['title', { sessionId: SID, kind: 'finished', title: 'x'.repeat(201) }],
    ['text', { sessionId: SID, kind: 'finished', text: 'x'.repeat(1001) }],
    ['cwd', { sessionId: SID, kind: 'finished', cwd: 'x'.repeat(501) }],
    ['host', { sessionId: SID, kind: 'finished', host: 'x'.repeat(101) }],
    ['tags', { sessionId: SID, kind: 'finished', tags: Array.from({ length: 21 }, (_, i) => `t${i}`) }],
    ['not an object', 'finished'],
  ];
  for (const [what, body] of bad) assert.throws(() => parseEventBody(body), /invalid event/, what);
  assert.doesNotThrow(() => parseEventBody({ sessionId: SID, kind: 'question', text: 'x'.repeat(1000), title: 'x'.repeat(200) }));
});

const event: DroidEvent = {
  seq: 7,
  at: Date.UTC(2026, 10, 13, 12),
  computer: 'laptop',
  sessionId: SID,
  kind: 'question',
  title: 'T',
  text: 'QUESTION: which?',
  cwd: '/home/dev/repos/x',
  tags: ['cto'],
  forwarded: true,
};

test('Forwarder posts the compact event with both auth headers', async () => {
  const sent: Request[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    sent.push(new Request(input, init));
    return new Response(null, { status: 204 });
  }) as typeof globalThis.fetch;
  const fw = new Forwarder({ url: 'https://hooks.example.test/wake?token=q', key: 'wh-key', fetch });
  assert.equal(fw.enabled, true);
  assert.equal(await fw.send(event), true);
  const [req] = sent;
  assert.equal(req.method, 'POST');
  assert.equal(req.headers.get('content-type'), 'application/json');
  assert.equal(req.headers.get('authorization'), 'Bearer wh-key');
  assert.equal(req.headers.get('x-automation-key'), 'wh-key');
  assert.deepEqual(await req.json(), {
    source: 'droid-mcp',
    seq: 7,
    at: '2026-11-13T12:00:00.000Z',
    computer: 'laptop',
    sessionId: SID,
    kind: 'question',
    title: 'T',
    text: 'QUESTION: which?',
    cwd: '/home/dev/repos/x',
  });
});

test('Forwarder refuses redirects so the key never follows one to another origin', async () => {
  let redirect: RequestRedirect | undefined;
  const fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    redirect = init?.redirect;
    return new Response(null, { status: 204 });
  }) as typeof globalThis.fetch;
  assert.equal(await new Forwarder({ url: 'https://hooks.example.test/wake', key: 'wh-key', fetch }).send(event), true);
  assert.equal(redirect, 'error');
});
test('Forwarder never throws, logs without the key or URL query, and is off without both values', async () => {
  const logs: string[] = [];
  const failing = (async () => {
    throw new TypeError('connect ECONNREFUSED for https://hooks.example.test/wake?token=q with wh-key');
  }) as typeof globalThis.fetch;
  const fw = new Forwarder({ url: 'https://hooks.example.test/wake?token=q', key: 'wh-key', fetch: failing, log: (m) => logs.push(m) });
  assert.equal(await fw.send(event), false);
  const status = new Forwarder({
    url: 'https://hooks.example.test/wake?token=q',
    key: 'wh-key',
    fetch: (async () => new Response('', { status: 500 })) as typeof globalThis.fetch,
    log: (m) => logs.push(m),
  });
  assert.equal(await status.send(event), false);
  assert.equal(logs.length, 2);
  for (const line of logs) {
    assert.match(line, /hooks\.example\.test\/wake/);
    assert.ok(!line.includes('wh-key') && !line.includes('token=q'), line);
  }
  assert.match(logs[1], /HTTP 500/);

  let called = false;
  const spy = (async () => {
    called = true;
    return new Response();
  }) as typeof globalThis.fetch;
  for (const off of [new Forwarder({ url: 'https://x.test', fetch: spy }), new Forwarder({ key: 'k', fetch: spy })]) {
    assert.equal(off.enabled, false);
    assert.equal(await off.send(event), false);
  }
  assert.equal(called, false);
});

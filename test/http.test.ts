import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { connect, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { Computers } from '../src/computers.ts';
import { EventLog, Forwarder } from '../src/events.ts';
import { createHandler } from '../src/http.ts';
import { createRest } from '../src/rest.ts';
import { KeyStore, type Runs } from '../src/runs.ts';
import { Subscriptions } from '../src/subscriptions.ts';
import type { Ctx } from '../src/tools.ts';
import { fakeApi, FIXTURES } from './helpers.ts';

const MCP_TOKEN = 'mcp-token-test';
const EVENTS_TOKEN = 'events-token-test';
const SID = '4d3c2b1a-0f9e-5d8c-b7a6-123456789abc';
const OWN = '7a6b5c4d-3e2f-5a1b-9c8d-abcdef012345';
const OTHER = '5e4d3c2b-1a0f-5e9d-c8b7-23456789abcd';

let dir: string;
let ctx: Ctx;
let forwarded: unknown[];
const servers: Server[] = [];

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'droid-mcp-http-'));
  await writeFile(join(dir, 'computer.json'), JSON.stringify({ computerId: 'c-self' }));
  const api = fakeApi(() => ({
    computers: [{ id: 'c-lap', name: 'laptop', providerType: 'byom', status: 'active', providerStatus: null, lastSeenAt: Date.now(), createdAt: 1 }],
  }));
  forwarded = [];
  const hook = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    forwarded.push(JSON.parse(String(init?.body)));
    return new Response(null, { status: 204 });
  }) as typeof globalThis.fetch;
  const rest = createRest({ apiKey: 'k', fetch: api.fetch });
  ctx = {
    sessionsRoot: FIXTURES,
    roots: [dir],
    runs: { get: (id: string) => (id === OWN ? { id } : undefined) } as unknown as Runs,
    keys: new KeyStore(join(dir, 'state.json')),
    subscriptions: new Subscriptions(join(dir, 'subscriptions.json')),
    rest,
    computers: new Computers({ rest, file: join(dir, 'computer.json') }),
    events: new EventLog(),
    forwarder: new Forwarder({ url: 'https://hooks.example.test/wake', key: 'wh', fetch: hook }),
  };
});
after(async () => {
  for (const s of servers) s.close();
  await rm(dir, { recursive: true, force: true });
});

async function serve(eventsToken: string | null = EVENTS_TOKEN): Promise<string> {
  const server = createServer(createHandler(ctx, { token: MCP_TOKEN, eventsToken: eventsToken ?? undefined }));
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const post = (url: string, token: string | undefined, body: unknown) =>
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

test('POST /events needs the events token, and the MCP bearer is not accepted there', async () => {
  const base = await serve();
  const body = { sessionId: SID, kind: 'question', computerId: 'c-lap', text: 'QUESTION: ship it?' };
  assert.equal((await post(`${base}/events`, undefined, body)).status, 400, 'without a header it is read as a ring');
  assert.equal((await post(`${base}/events`, 'wrong', body)).status, 401);
  assert.equal((await post(`${base}/events`, MCP_TOKEN, body)).status, 401);
  assert.equal(ctx.events.since(0, 50).events.length, 0, 'nothing recorded from rejected requests');

  await ctx.subscriptions.set(SID, true);
  const ok = await post(`${base}/events`, EVENTS_TOKEN, body);
  assert.equal(ok.status, 202);
  const { seq, forwarded: fw } = await ok.json();
  assert.equal(fw, true);
  const [stored] = ctx.events.since(seq - 1, 1).events;
  assert.equal(stored.computer, 'laptop', 'computer name resolved from computerId');
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual((forwarded.at(-1) as { sessionId: string; kind: string }).sessionId, SID);

  const fallback = await post(`${base}/events`, EVENTS_TOKEN, { sessionId: SID, kind: 'finished', host: 'arch-box' });
  const second = await fallback.json();
  assert.equal(ctx.events.since(second.seq - 1, 1).events[0].computer, 'arch-box');
  const own = await (await post(`${base}/events`, EVENTS_TOKEN, { sessionId: OWN, kind: 'finished' })).json();
  assert.equal(ctx.events.since(own.seq - 1, 1).events[0].computer, 'unknown');
});

test('an unsubscribed session never reaches the webhook, whatever the kind, its tags or who started it', async () => {
  const base = await serve();
  const before = forwarded.length;
  const seqs: number[] = [];
  for (const body of [{ sessionId: OTHER }, { sessionId: OWN }, { sessionId: OTHER, tags: ['cto'] }]) {
    for (const kind of ['question', 'permission', 'finished', 'ended']) {
      const res = await post(`${base}/events`, EVENTS_TOKEN, { ...body, kind });
      assert.equal(res.status, 202);
      const { seq, forwarded: fw } = await res.json();
      assert.equal(fw, false, `${body.sessionId} ${kind}`);
      seqs.push(seq);
    }
  }
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(forwarded.length, before, 'the webhook was never called');
  const logged = ctx.events.since(seqs[0] - 1, 50).events;
  assert.deepEqual(
    logged.map((e) => e.seq),
    seqs,
  );
  assert.ok(logged.every((e) => !e.forwarded));
});

test("a subscribed session's events are forwarded, once per kind within 30 s", async () => {
  const base = await serve();
  const before = forwarded.length;
  await ctx.subscriptions.set(OWN, true);
  const send = async (kind: string) => (await (await post(`${base}/events`, EVENTS_TOKEN, { sessionId: OWN, kind })).json()).forwarded;
  try {
    assert.equal(await send('finished'), true);
    assert.equal(await send('finished'), false, 'debounced');
    assert.equal(await send('ended'), true);
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(
      forwarded.slice(before).map((b) => (b as { kind: string }).kind),
      ['finished', 'ended'],
    );
  } finally {
    await ctx.subscriptions.set(OWN, false);
  }
  assert.equal(await send('question'), false, 'unsubscribed again');
});

test('an event from an unknown computerId is recorded but does not set the session computer', async () => {
  const base = await serve();
  const homes = new Map<string, string>();
  ctx.sessionComputers = homes;
  try {
    const ok = await post(`${base}/events`, EVENTS_TOKEN, { sessionId: SID, kind: 'finished', computerId: 'c-gone', host: 'ghost' });
    assert.equal(ok.status, 202);
    const { seq } = await ok.json();
    assert.equal(ctx.events.since(seq - 1, 1).events[0].computer, 'ghost');
    assert.equal(homes.has(SID), false);
    await post(`${base}/events`, EVENTS_TOKEN, { sessionId: SID, kind: 'finished', computerId: 'c-lap' });
    assert.equal(homes.get(SID), 'c-lap');
  } finally {
    ctx.sessionComputers = undefined;
  }
});
test('POST /events rejects bad JSON, bad shapes and oversized bodies', async () => {
  const base = await serve();
  assert.equal((await post(`${base}/events`, EVENTS_TOKEN, '{nope')).status, 400);
  assert.equal((await post(`${base}/events`, EVENTS_TOKEN, { sessionId: '../x', kind: 'finished' })).status, 400);
  assert.equal((await post(`${base}/events`, EVENTS_TOKEN, { sessionId: SID, kind: 'finished', title: 'x'.repeat(300) })).status, 400);
  assert.equal((await post(`${base}/events`, EVENTS_TOKEN, { sessionId: SID, kind: 'finished', pad: 'x'.repeat(17 * 1024) })).status, 413);
});

test('an unparseable request path gets a 400 and the server keeps answering', async () => {
  const rejections: unknown[] = [];
  const onRejection = (reason: unknown) => rejections.push(reason);
  process.on('unhandledRejection', onRejection);
  try {
    const base = await serve();
    const { port } = new URL(base);
    const socket = connect(Number(port), '127.0.0.1');
    let raw = '';
    socket.setEncoding('utf8').on('data', (d) => (raw += d));
    socket.end('POST // HTTP/1.1\r\nHost: x\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
    await new Promise((r) => socket.on('close', r));
    assert.match(raw, /^HTTP\/1\.1 400 /);
    assert.ok(raw.includes(JSON.stringify({ error: 'bad request' })), raw);

    assert.equal((await post(`${base}/events`, 'wrong', { sessionId: SID, kind: 'finished' })).status, 401);
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(rejections, []);
  } finally {
    process.off('unhandledRejection', onRejection);
  }
});

test('the events token does not open MCP, the MCP bearer still does, and /events is 404 without a token', async () => {
  const base = await serve();
  const init = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } },
  };
  const mcp = (token: string) =>
    fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` },
      body: JSON.stringify(init),
    });
  assert.equal((await mcp(EVENTS_TOKEN)).status, 401);
  const ok = await mcp(MCP_TOKEN);
  assert.equal(ok.status, 200);
  await ok.text();

  const off = await serve(null);
  assert.equal((await post(`${off}/events`, EVENTS_TOKEN, { sessionId: SID, kind: 'finished' })).status, 404);
  assert.equal((await post(`${off}/events`, MCP_TOKEN, { sessionId: SID, kind: 'finished' })).status, 404);
});

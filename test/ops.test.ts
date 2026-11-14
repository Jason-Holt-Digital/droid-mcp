import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Computers } from '../src/computers.ts';
import { API_KEY_FIX } from '../src/config.ts';
import { EventLog } from '../src/events.ts';
import { relayDaemon, type DaemonCall, type RelayDeps } from '../src/ops.ts';
import { createRest } from '../src/rest.ts';
import { KeyStore, type Runs } from '../src/runs.ts';
import { Subscriptions } from '../src/subscriptions.ts';
import { LIMIT_BYTES, registerTools, type Ctx } from '../src/tools.ts';
import { catalog, FIXTURES } from './helpers.ts';

type Entry = { id: string; summary: string; readOnly: boolean; destructive: boolean; secret: boolean };
const ALLOW = { DROID_MCP_ALLOW_DESTRUCTIVE: '1' };
const operations: Array<{ source: string }> = JSON.parse(readFileSync(new URL('../src/generated/catalog.json', import.meta.url), 'utf8')).operations;

let dir: string;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'droid-mcp-ops-'));
});
after(() => rm(dir, { recursive: true, force: true }));

async function connect(ctx: Partial<Ctx>) {
  const server = new McpServer({ name: 'droid-mcp', version: 'test' });
  registerTools(server, {
    sessionsRoot: FIXTURES,
    roots: [dir],
    runs: { get: () => undefined } as unknown as Runs,
    keys: new KeyStore(join(dir, 'state.json')),
    subscriptions: new Subscriptions(join(dir, 'subscriptions.json')),
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
      return { isError: Boolean(res.isError), text, json: JSON.parse(text) };
    },
    close: () => client.close(),
  };
}

type Call = { method: string; path: string; query: string; body: unknown; auth: string | null };

function recordingFetch(reply: unknown = { ok: true }) {
  const calls: Call[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    const text = await req.text();
    calls.push({
      method: req.method,
      path: url.pathname,
      query: url.search,
      body: text ? JSON.parse(text) : undefined,
      auth: req.headers.get('authorization'),
    });
    return Response.json(reply);
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

test('droid_call decides read-only from the catalog flag, not from the method name', async () => {
  const daemonCalls: string[] = [];
  const daemon: DaemonCall = async (method) => {
    daemonCalls.push(method);
    return {};
  };
  const c = await connect({ env: { DROID_MCP_MAX_AUTONOMY: 'low' }, daemon });
  try {
    // Named get…, but it returns any file's contents, so the catalog does not mark it read-only.
    const file = await c.call('droid_call', { id: 'daemon.get_workspace_file_content', params: {} });
    assert.match(file.json.message, /is not read-only/);
    assert.equal((await c.call('droid_call', { id: 'daemon.list_models' })).isError, false);
    assert.deepEqual(daemonCalls, ['listModels']);
  } finally {
    await c.close();
  }
});

test('droid_ops without arguments counts operations by source and says how to search', async () => {
  const c = await connect({});
  try {
    const res = await c.call('droid_ops', {});
    const bySource: Record<string, number> = {};
    for (const o of operations) bySource[o.source] = (bySource[o.source] ?? 0) + 1;
    assert.deepEqual(res.json, { total: operations.length, bySource, hint: 'Pass query to search, or id to describe one operation.' });
  } finally {
    await c.close();
  }
});

test('droid_ops searches id, name and summary case-insensitively and returns compact entries', async () => {
  const c = await connect({});
  try {
    const models = await c.call('droid_ops', { query: 'LIST models' });
    const ids = models.json.operations.map((e: Entry) => e.id);
    assert.ok(ids.includes('daemon.list_models'), ids.join(', '));
    assert.deepEqual(Object.keys(models.json.operations[0]).sort(), ['destructive', 'id', 'readOnly', 'secret', 'summary']);
    const bySummary = await c.call('droid_ops', { query: 'get a session' });
    assert.ok(bySummary.json.operations.some((e: Entry) => e.id === 'rest.getSession'));
    const byPath = await c.call('droid_ops', { query: '/elicitations/{requestId}' });
    assert.deepEqual(
      byPath.json.operations.map((e: Entry) => e.id),
      ['rest.answerSessionElicitation'],
    );
    const page = await c.call('droid_ops', { query: 'session', limit: 3 });
    assert.equal(page.json.operations.length, 3);
    assert.ok(page.json.total > 3);
    const all = await c.call('droid_ops', { query: 'a', limit: 50 });
    assert.ok(Buffer.byteLength(all.text) <= LIMIT_BYTES);
    assert.deepEqual((await c.call('droid_ops', { query: 'no-such-operation-anywhere' })).json, { total: 0, operations: [] });
  } finally {
    await c.close();
  }
});

test('droid_ops with an id describes the operation in full', async () => {
  const c = await connect({});
  try {
    const res = await c.call('droid_ops', { id: 'rest.getSession' });
    assert.deepEqual(res.json, {
      id: 'rest.getSession',
      source: 'rest',
      name: 'GET /api/v0/sessions/{sessionId}',
      summary: 'Get a session',
      params: {
        type: 'object',
        properties: { sessionId: { type: 'string', description: 'Session ID' }, computerId: { type: 'string', description: 'Computer ID to query directly' } },
        required: ['sessionId'],
      },
      readOnly: true,
      destructive: false,
      secret: false,
    });
    const daemon = await c.call('droid_ops', { id: 'daemon.kill_worker_session' });
    assert.equal(daemon.json.destructive, true);
    assert.equal(daemon.json.readOnly, false);
    const unknown = await c.call('droid_ops', { id: 'rest.nope' });
    assert.equal(unknown.json.code, 'invalid');
  } finally {
    await c.close();
  }
});

test('droid_call refuses an unknown id and points at droid_ops', async () => {
  const c = await connect({});
  try {
    const res = await c.call('droid_call', { id: 'rest.nope' });
    assert.equal(res.isError, true);
    assert.deepEqual(res.json, { code: 'invalid', message: 'unknown operation rest.nope', fix: 'Search with droid_ops query, then pass an id it returns.' });
  } finally {
    await c.close();
  }
});

test('droid_call refuses destructive operations unless the server allows them, and then still needs confirm: true', async () => {
  const { fetch, calls } = recordingFetch({});
  const locked = await connect({ rest: createRest({ apiKey: 'k', fetch }) });
  try {
    for (const id of ['rest.deleteSession', 'daemon.kill_worker_session']) {
      const res = await locked.call('droid_call', { id, params: { sessionId: 'abc' }, confirm: true });
      assert.equal(res.isError, true);
      assert.deepEqual(res.json, {
        code: 'invalid',
        message: `${id} is destructive, and this server does not allow destructive operations`,
        fix: 'Ask the user to do it in the Factory app, or to restart droid-mcp with DROID_MCP_ALLOW_DESTRUCTIVE=1.',
      });
    }
  } finally {
    await locked.close();
  }
  for (const env of [{ DROID_MCP_ALLOW_DESTRUCTIVE: 'true' }, { DROID_MCP_ALLOW_DESTRUCTIVE: '0' }]) {
    const other = await connect({ rest: createRest({ apiKey: 'k', fetch }), env });
    try {
      const res = await other.call('droid_call', { id: 'rest.deleteSession', params: { sessionId: 'abc' }, confirm: true });
      assert.match(res.json.message, /does not allow destructive operations/, 'only the exact value 1 turns it on');
    } finally {
      await other.close();
    }
  }
  const c = await connect({ rest: createRest({ apiKey: 'k', fetch }), env: ALLOW });
  try {
    for (const confirm of [undefined, false]) {
      const res = await c.call('droid_call', { id: 'rest.deleteSession', params: { sessionId: 'abc' }, confirm });
      assert.deepEqual(res.json, { code: 'invalid', message: 'rest.deleteSession is destructive', fix: 'Confirm with the user, then pass confirm: true.' });
    }
    assert.equal(calls.length, 0);
    const ok = await c.call('droid_call', { id: 'rest.deleteSession', params: { sessionId: 'abc' }, confirm: true });
    assert.equal(ok.isError, false, ok.text);
    assert.deepEqual(
      calls.map((x) => `${x.method} ${x.path}`),
      ['DELETE /api/v0/sessions/abc'],
    );
  } finally {
    await c.close();
  }
});

test('droid_call refuses operations that return keys or tokens, whatever the settings', async () => {
  const { fetch, calls } = recordingFetch({});
  let ran = 0;
  const c = await connect({ rest: createRest({ apiKey: 'k', fetch }), env: ALLOW, daemon: async () => ran++ });
  try {
    for (const id of ['daemon.get_proxy_token', 'rest.createServiceAccountApiKey', 'rest.rotateServiceAccountApiKey']) {
      const res = await c.call('droid_call', { id, params: {}, confirm: true });
      assert.equal(res.json.code, 'invalid', id);
      assert.match(res.json.message, /returns a key or token/, id);
    }
    assert.deepEqual([calls.length, ran], [0, 0]);
  } finally {
    await c.close();
  }
});

test('droid_call under an off or low autonomy cap runs only read-only operations', async () => {
  const { fetch, calls } = recordingFetch({ sessions: [] });
  for (const cap of ['off', 'low']) {
    const daemonCalls: string[] = [];
    const daemon: DaemonCall = async (method) => {
      daemonCalls.push(method);
      return {};
    };
    const c = await connect({ rest: createRest({ apiKey: 'k', fetch }), env: { DROID_MCP_MAX_AUTONOMY: cap, ...ALLOW }, daemon });
    try {
      const post = await c.call('droid_call', { id: 'rest.postMessage', params: { sessionId: 'abc', body: { text: 'hi' } } });
      assert.deepEqual(post.json, {
        code: 'invalid',
        message: `rest.postMessage is not read-only, and the autonomy cap is '${cap}' (DROID_MCP_MAX_AUTONOMY)`,
        fix: `Call a read-only operation, or ask the user to raise DROID_MCP_MAX_AUTONOMY above '${cap}'.`,
      });
      const kill = await c.call('droid_call', { id: 'daemon.kill_worker_session', params: {}, confirm: true });
      assert.match(kill.json.fix, /DROID_MCP_MAX_AUTONOMY/);
      assert.equal((await c.call('droid_call', { id: 'rest.listSessions' })).isError, false);
      assert.equal((await c.call('droid_call', { id: 'daemon.list_models' })).isError, false);
      assert.deepEqual(daemonCalls, ['listModels']);
    } finally {
      await c.close();
    }
  }
  assert.ok(calls.every((x) => x.method === 'GET'));
  const medium = await connect({ rest: createRest({ apiKey: 'k', fetch }), env: { DROID_MCP_MAX_AUTONOMY: 'medium' } });
  try {
    assert.equal((await medium.call('droid_call', { id: 'rest.postMessage', params: { sessionId: 'abc', body: { text: 'hi' } } })).isError, false);
  } finally {
    await medium.close();
  }
});

test('droid_call over REST fills path params, sends the rest as query and params.body as the body, with the key', async () => {
  const { fetch, calls } = recordingFetch({ messages: [{ id: 'm1' }] });
  const c = await connect({ rest: createRest({ apiKey: 'k', fetch }), env: ALLOW });
  try {
    const get = await c.call('droid_call', { id: 'rest.getMessages', params: { sessionId: 'abc', limit: 5, role: 'user' } });
    assert.deepEqual(get.json, { id: 'rest.getMessages', result: { messages: [{ id: 'm1' }] } });
    const post = await c.call('droid_call', { id: 'rest.postMessage', params: { sessionId: 'abc', body: { text: 'hi', computerId: 'c1' } } });
    assert.equal(post.isError, false, post.text);
    const del = await c.call('droid_call', { id: 'rest.removeUser', params: { email: 'a@example.com' }, confirm: true });
    assert.equal(del.isError, false, del.text);
    assert.deepEqual(calls, [
      { method: 'GET', path: '/api/v0/sessions/abc/messages', query: '?limit=5&role=user', body: undefined, auth: 'Bearer k' },
      { method: 'POST', path: '/api/v0/sessions/abc/messages', query: '', body: { text: 'hi', computerId: 'c1' }, auth: 'Bearer k' },
      { method: 'DELETE', path: '/api/v0/organization/users', query: '?email=a%40example.com', body: undefined, auth: 'Bearer k' },
    ]);
  } finally {
    await c.close();
  }
});

test('droid_call checks REST params against the schema before sending anything', async () => {
  const { fetch, calls } = recordingFetch();
  const c = await connect({ rest: createRest({ apiKey: 'k', fetch }) });
  try {
    const fix = "Describe it with droid_ops id 'rest.getSession', then pass the params it lists.";
    assert.deepEqual((await c.call('droid_call', { id: 'rest.getSession' })).json, {
      code: 'invalid',
      message: 'rest.getSession is missing params: sessionId',
      fix,
    });
    assert.deepEqual((await c.call('droid_call', { id: 'rest.getSession', params: { sessionId: 'a', limit: 1, x: 2 } })).json, {
      code: 'invalid',
      message: 'rest.getSession does not take params: limit, x',
      fix,
    });
    const body = await c.call('droid_call', { id: 'rest.getSession', params: { sessionId: 'abc', body: {} } });
    assert.equal(body.json.message, 'rest.getSession does not take params: body');
    const computer = await c.call('droid_call', { id: 'rest.listSessions', computer: 'test-host' });
    assert.equal(computer.json.message, 'computer applies only to daemon operations');
    assert.equal(calls.length, 0);
  } finally {
    await c.close();
  }
});

test('droid_call maps REST errors and refuses without FACTORY_API_KEY', async () => {
  const notFound = (async () => Response.json({ status: 404, title: 'Not Found' }, { status: 404 })) as typeof globalThis.fetch;
  const keyed = await connect({ rest: createRest({ apiKey: 'k', fetch: notFound }) });
  try {
    const res = await keyed.call('droid_call', { id: 'rest.getSession', params: { sessionId: 'abc' } });
    assert.equal(res.json.code, 'not_found');
    assert.match(res.json.message, /GET \/api\/v0\/sessions\/\{sessionId\} 404/);
  } finally {
    await keyed.close();
  }
  const bare = await connect({});
  try {
    for (const id of ['rest.listSessions', 'daemon.list_models']) {
      assert.deepEqual((await bare.call('droid_call', { id })).json, { code: 'needs_api_key', message: `${id} needs FACTORY_API_KEY`, fix: API_KEY_FIX });
    }
  } finally {
    await bare.close();
  }
});

test("droid_call runs a daemon method on this machine's daemon only, and trims a large result", async () => {
  const seen: Array<[string, unknown]> = [];
  const daemon: DaemonCall = async (method, params) => {
    seen.push([method, params]);
    return method === 'listModels' ? { models: [{ id: 'claude-opus-5-5' }] } : { blob: 'x'.repeat(3 * LIMIT_BYTES) };
  };
  const c = await connect({ daemon });
  try {
    const res = await c.call('droid_call', { id: 'daemon.list_models', params: { includeDisabled: true }, computer: 'test-host' });
    assert.deepEqual(res.json, { id: 'daemon.list_models', result: { models: [{ id: 'claude-opus-5-5' }] } });
    const elsewhere = await c.call('droid_call', { id: 'daemon.list_models', computer: 'laptop' });
    assert.equal(elsewhere.json.code, 'not_found', 'without a key only this machine is known');
    const big = await c.call('droid_call', { id: 'daemon.list_skills' });
    assert.equal(big.json.truncated, true);
    assert.equal(big.json.result, undefined);
    assert.ok(big.json.totalBytes > 3 * LIMIT_BYTES);
    assert.ok(Buffer.byteLength(big.text) <= LIMIT_BYTES);
    assert.deepEqual(seen, [
      ['listModels', { includeDisabled: true }],
      ['listSkills', undefined],
    ]);
  } finally {
    await c.close();
  }
});

test('droid_call refuses a daemon operation aimed at another computer', async () => {
  const computers = [
    { id: 'comp-self', name: 'this-box', providerType: 'byom', status: 'active', lastSeenAt: Date.now(), createdAt: 1 },
    { id: 'comp-laptop', name: 'laptop', providerType: 'byom', status: 'active', lastSeenAt: Date.now(), createdAt: 1 },
  ];
  const { fetch } = recordingFetch({ computers });
  const rest = createRest({ apiKey: 'k', fetch });
  const file = join(dir, 'computer.json');
  await writeFile(file, JSON.stringify({ computerId: 'comp-self' }));
  let ran = 0;
  const c = await connect({ rest, computers: new Computers({ rest, file }), daemon: async () => ran++ });
  try {
    const res = await c.call('droid_call', { id: 'daemon.list_models', computer: 'laptop' });
    assert.deepEqual(res.json, {
      code: 'invalid',
      message: 'daemon operations run only on this machine, not on laptop',
      fix: 'Omit computer, or run droid-mcp on that computer.',
    });
    assert.equal((await c.call('droid_call', { id: 'daemon.list_models', computer: 'this-box' })).isError, false);
    assert.equal(ran, 1);
  } finally {
    await c.close();
  }
});

type FakeClient = { listModels?: (p: unknown) => Promise<unknown>; disconnect: () => void };

function fakeRelay(client: FakeClient, opts: { relayClientUrl?: string; connect?: RelayDeps['connect'] } = {}) {
  const seen = { created: [] as unknown[], connected: [] as Array<{ url: string; apiKey: string }>, disconnected: 0, computers: [] as string[] };
  const wrapped = {
    ...client,
    disconnect: () => {
      seen.disconnected++;
      client.disconnect();
    },
  };
  const deps: RelayDeps = {
    createClient: ((o: unknown) => {
      seen.created.push(o);
      return wrapped;
    }) as unknown as RelayDeps['createClient'],
    connect:
      opts.connect ??
      ((async (a: { url: string; authParams: { apiKey: string } }) => {
        seen.connected.push({ url: a.url, apiKey: a.authParams.apiKey });
      }) as unknown as RelayDeps['connect']),
    timeoutMs: 20,
  };
  const rest = {
    computer: async (id: string) => {
      seen.computers.push(id);
      return { providerType: 'byom', relayClientUrl: 'relayClientUrl' in opts ? opts.relayClientUrl : 'wss://relay.example/c1' };
    },
  };
  return { call: relayDaemon('secret-key', rest, { thisId: async () => 'comp-self' }, deps), seen };
}

test('the relay path connects to this computer through the relay URL Factory reports, calls the method and disconnects', async () => {
  const params: unknown[] = [];
  const ok = fakeRelay({ listModels: async (p) => (params.push(p), { models: [{ id: 'm' }] }), disconnect: () => {} });
  assert.deepEqual(await ok.call('listModels', { includeDisabled: true }), { models: [{ id: 'm' }] });
  assert.deepEqual(params, [{ includeDisabled: true }]);
  assert.deepEqual(ok.seen.computers, ['comp-self']);
  assert.deepEqual(ok.seen.connected, [{ url: 'wss://relay.example/c1', apiKey: 'secret-key' }]);
  assert.equal((ok.seen.created[0] as { computerId: string }).computerId, 'comp-self');
  assert.equal(ok.seen.disconnected, 1);

  const missing = fakeRelay({ disconnect: () => {} });
  await assert.rejects(
    missing.call('listModels', undefined),
    (e: Error & { code: string }) => e.code === 'internal' && /no DaemonClient\.listModels/.test(e.message),
  );
  assert.equal(missing.seen.disconnected, 1, 'disconnects after a failed call too');

  const offline = fakeRelay({ disconnect: () => {} }, { relayClientUrl: undefined });
  await assert.rejects(offline.call('listModels', undefined), (e: Error & { code: string }) => e.code === 'computer_offline');
  assert.equal(offline.seen.created.length, 0);

  const stalled = fakeRelay({ disconnect: () => {} }, { connect: (() => new Promise(() => {})) as unknown as RelayDeps['connect'] });
  await assert.rejects(
    stalled.call('listModels', undefined),
    (e: Error & { code: string }) => e.code === 'computer_offline' && /did not answer/.test(e.message),
  );
  assert.equal(stalled.seen.disconnected, 1);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRest } from '../src/rest.ts';

const KEY = 'fk-secret-test-key';

type Call = { method: string; path: string; query: string; body: unknown; auth: string | null };

function mockFetch(routes: Record<string, { status?: number; body: unknown }>) {
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
    const hit = routes[`${req.method} ${url.pathname}`];
    if (!hit) return new Response('{}', { status: 500 });
    return new Response(JSON.stringify(hit.body), {
      status: hit.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

test('send posts the text as the key holder and returns messageId and status', async () => {
  const { fetch, calls } = mockFetch({
    'POST /api/v0/sessions/abc/messages': { body: { messageId: 'm1', status: 'running' } },
  });
  const rest = createRest({ apiKey: KEY, fetch });
  assert.deepEqual(await rest.send('abc', 'hello'), { messageId: 'm1', status: 'running' });
  assert.equal(calls[0].auth, `Bearer ${KEY}`);
  assert.deepEqual(calls[0].body, { text: 'hello' });
});

test('status combines the session with its pending elicitations', async () => {
  const { fetch } = mockFetch({
    'GET /api/v0/sessions/abc': {
      body: { sessionId: 'abc', title: 'T', status: 'running', messageCount: 4, createdAt: 1, updatedAt: 2, tags: [{ name: 'mission-v2' }] },
    },
    'GET /api/v0/sessions/abc/elicitations': {
      body: {
        elicitations: [
          {
            type: 'permission',
            requestId: 'r1',
            toolUses: [{ toolUse: { type: 'tool_use', id: 't', name: 'Execute', input: { command: 'ls' } }, confirmationType: 'exec', details: { type: 'exec', fullCommand: 'ls', command: 'ls' } }],
            options: [{ label: 'Yes', value: 'proceed_once' }, { label: 'No', value: 'cancel' }],
          },
          { type: 'ask-user', requestId: 'r2', toolCallId: 'c', questions: [{ index: 0, topic: 'x', question: 'Which?', options: ['a', 'b'] }] },
        ],
      },
    },
  });
  const s = await createRest({ apiKey: KEY, fetch }).status('abc');
  assert.equal(s.status, 'running');
  assert.equal(s.messageCount, 4);
  assert.deepEqual(s.tags, ['mission-v2']);
  assert.deepEqual(s.elicitations[0].options, ['proceed_once', 'cancel']);
  assert.match(s.elicitations[0].summary ?? '', /Execute/);
  assert.deepEqual(s.elicitations[1].questions, [{ index: 0, question: 'Which?', options: ['a', 'b'] }]);
});

test('API errors become one Error with status and title, never the key', async () => {
  const { fetch } = mockFetch({
    'POST /api/v0/sessions/abc/messages': { status: 403, body: { status: 403, title: 'Forbidden', detail: 'REST is not enabled for this organization' } },
  });
  await assert.rejects(createRest({ apiKey: KEY, fetch }).send('abc', 'x'), (err: Error) => {
    assert.match(err.message, /403 Forbidden: REST is not enabled/);
    assert.ok(!err.message.includes(KEY));
    return true;
  });
});

test('children asks for attention; answer and interrupt hit the session paths', async () => {
  const { fetch, calls } = mockFetch({
    'GET /api/v0/sessions/orc/children': {
      body: {
        sessions: [
          { sessionId: 'a1', title: 'Agent', status: 'running', createdAt: 1, updatedAt: 2, attention: { kind: 'permission', since: 3 }, computerId: 'c1', computer: { id: 'c1', name: 'flutter-box', templateId: null } },
        ],
      },
    },
    'POST /api/v0/sessions/a1/elicitations/r1': { body: {} },
    'POST /api/v0/sessions/a1/interrupt': { body: {} },
  });
  const rest = createRest({ apiKey: KEY, fetch });
  assert.deepEqual(await rest.children('orc'), [
    { sessionId: 'a1', title: 'Agent', status: 'running', updatedAt: 2, tags: [], attention: { kind: 'permission', since: 3 }, computer: 'flutter-box' },
  ]);
  assert.match(calls[0].query, /includeAttention=true/);
  await rest.answer('a1', 'r1', { selectedOption: 'proceed_once' });
  assert.deepEqual(calls[1].body, { selectedOption: 'proceed_once' });
  await rest.interrupt('a1');
  assert.equal(calls[2].path, '/api/v0/sessions/a1/interrupt');
});

test('messages returns text content and the next cursor', async () => {
  const { fetch, calls } = mockFetch({
    'GET /api/v0/sessions/abc/messages': {
      body: {
        messages: [{ id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'Done.' }, { type: 'tool_use', id: 't', name: 'x', input: {} }], createdAt: 5, updatedAt: 5 }],
        pagination: { hasMore: true, nextCursor: 'c2' },
      },
    },
  });
  const res = await createRest({ apiKey: KEY, fetch }).messages('abc', { role: 'assistant', limit: 5 });
  assert.deepEqual(res, { messages: [{ id: 'm1', role: 'assistant', text: 'Done.', createdAt: 5, seq: undefined }], nextCursor: 'c2' });
  assert.match(calls[0].query, /role=assistant/);
  assert.match(calls[0].query, /limit=5/);
});

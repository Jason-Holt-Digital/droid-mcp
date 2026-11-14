import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SessionRecord } from '../src/catalog.ts';
import { RECENT_MS, routeSend, type Target } from '../src/route.ts';
import type { OwnRun } from '../src/runs.ts';

const NOW = 1_800_000_000_000;
const base: SessionRecord = {
  id: 's1',
  title: 't',
  cwd: '/home/dev/repos/x',
  file: '/dev/null',
  updatedAt: NOW - RECENT_MS - 1,
  tags: [],
  archived: false,
  classified: true,
  autonomy: 'off',
};
const local = (patch: Partial<SessionRecord>): Target => ({ kind: 'local', record: { ...base, ...patch } });
const route = (target: Target, restEnabled: boolean, allowLocalResume = true, closedAt?: number) =>
  routeSend(target, { restEnabled, allowLocalResume, now: NOW, cap: 'medium', closedAt });
const refusedWith = (r: ReturnType<typeof routeSend>, text: RegExp, code = 'invalid') => {
  assert.ok('refused' in r, `expected a refusal, got ${JSON.stringify(r)}`);
  assert.match(r.refused.message, text);
  assert.equal(r.refused.code, code);
  assert.ok(r.refused.fix);
};

test('own runs always route to the own session', () => {
  const own: Target = { kind: 'own', run: { id: 's1' } as OwnRun };
  assert.deepEqual(route(own, false, false), { via: 'own' });
  assert.deepEqual(route(own, true), { via: 'own' });
});

test('workstream sessions use REST or are refused, never resumed locally', () => {
  for (const role of ['orchestrator', 'agent'] as const) {
    const ws = local({ workstream: { id: 'm', role } });
    assert.deepEqual(route(ws, true), { via: 'rest' });
    refusedWith(route(ws, false, true), /workstream sessions need FACTORY_API_KEY; never loaded locally/, 'needs_api_key');
  }
});

test('sessions not on this disk use REST or are refused', () => {
  const unknown: Target = { kind: 'unknown', id: 'elsewhere' };
  assert.deepEqual(route(unknown, true), { via: 'rest' });
  refusedWith(route(unknown, false), /not on this machine.*FACTORY_API_KEY/, 'needs_api_key');
});

test('standalone local sessions prefer REST when it is enabled', () => {
  assert.deepEqual(route(local({}), true, false), { via: 'rest' });
  assert.deepEqual(route(local({ archived: true, updatedAt: NOW }), true, false), { via: 'rest' });
});

test('standalone local sessions resume locally only when allowed, live, top-level and idle for 30 min', () => {
  assert.deepEqual(route(local({}), false, true), { via: 'local-resume' });
  refusedWith(route(local({}), false, false), /without FACTORY_API_KEY resumes it/);
  refusedWith(route(local({ archived: true }), false), /archived/);
  refusedWith(route(local({ parentId: 'p' }), false), /subagent/);
  refusedWith(route(local({ tags: ['mission-v2-subagent'] }), false), /subagent/);
  refusedWith(route(local({ updatedAt: NOW - RECENT_MS + 1000 }), false), /last 30 minutes/, 'busy');
  refusedWith(route(local({ classified: false }), false), /may be a workstream/, 'needs_api_key');
  refusedWith(route(local({ autonomy: 'high' }), false), /exceeds the cap 'medium'/);
  assert.deepEqual(route(local({ autonomy: 'medium' }), false), { via: 'local-resume' });
  refusedWith(route(local({ autonomy: undefined }), false), /'unknown' exceeds the cap/);
});

test('a session this server closed resumes locally at once unless touched since; other guards still apply', () => {
  const recent = local({ updatedAt: NOW - 1000 });
  assert.deepEqual(route(recent, false, true, NOW), { via: 'local-resume' });
  refusedWith(route(recent, false, true), /last 30 minutes/, 'busy');
  refusedWith(route(recent, false, false, NOW), /without FACTORY_API_KEY resumes it/);
  assert.deepEqual(route(recent, true, false, NOW), { via: 'local-resume' }, 'with a key it resumes locally instead of going over REST');
  refusedWith(route(local({ updatedAt: NOW, autonomy: 'high' }), true, false, NOW), /exceeds the cap/);
  refusedWith(route(recent, false, true, NOW - 2000), /last 30 minutes/, 'busy');
  const unknown: Target = { kind: 'unknown', id: 'elsewhere' };
  assert.deepEqual(route(unknown, true, false, NOW), { via: 'rest' });
});

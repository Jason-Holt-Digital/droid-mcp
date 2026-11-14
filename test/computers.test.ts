import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { classifyComputer, Computers, ONLINE_WINDOW_MS, pickComputer, type RawComputer } from '../src/computers.ts';
import { Refused } from '../src/config.ts';
import { createRest } from '../src/rest.ts';
import { fakeApi } from './helpers.ts';

const NOW = 1_800_000_000_000;
const byom = (patch: Partial<RawComputer> = {}): RawComputer => ({ id: 'c-own', name: 'desk', providerType: 'byom', status: 'active', ...patch });
const e2b = (providerStatus: string | null, patch: Partial<RawComputer> = {}): RawComputer => ({
  id: 'c-cloud',
  name: 'cloud',
  providerType: 'e2b',
  status: 'active',
  providerStatus,
  ...patch,
});

test('classifyComputer: own computers by heartbeat, cloud computers by sandbox state, never by status', () => {
  assert.equal(classifyComputer(byom({ lastSeenAt: NOW - 60_000 }), NOW).state, 'online');
  assert.equal(classifyComputer(byom({ lastSeenAt: NOW - 150_000 }), NOW).state, 'online', 'the slowest measured gap');
  assert.equal(classifyComputer(byom({ lastSeenAt: NOW - ONLINE_WINDOW_MS - 1 }), NOW).state, 'offline');
  assert.equal(classifyComputer(byom({ lastSeenAt: NOW - 10 * 3600_000 }), NOW).state, 'offline', 'status active does not mean alive');
  assert.equal(classifyComputer(byom(), NOW).state, 'offline', 'no heartbeat recorded');
  assert.equal(classifyComputer(byom(), NOW).kind, 'own');

  assert.equal(classifyComputer(e2b('running', { lastSeenAt: NOW - 3600_000 }), NOW).state, 'online');
  assert.equal(classifyComputer(e2b('paused', { lastSeenAt: NOW - 3600_000 }), NOW).state, 'paused');
  assert.equal(classifyComputer(e2b('snapshotting'), NOW).state, 'paused');
  for (const s of ['terminated', 'failed', 'booting', null]) assert.equal(classifyComputer(e2b(s, { lastSeenAt: NOW }), NOW).state, 'offline', String(s));
  assert.equal(classifyComputer(e2b('running'), NOW).kind, 'cloud');
  assert.equal(classifyComputer(e2b('paused'), NOW).providerStatus, 'paused');

  assert.equal(classifyComputer(byom({ lastSeenAt: NOW }), NOW, 'c-own').thisMachine, true);
  assert.equal(classifyComputer(byom({ lastSeenAt: NOW }), NOW, 'other').thisMachine, false);
});

test('pickComputer matches an exact id, then a name in any case; refuses ambiguous and missing names', () => {
  const list = [
    classifyComputer(byom({ id: 'c1', name: 'Desk', lastSeenAt: NOW }), NOW),
    classifyComputer(byom({ id: 'c2', name: 'twin' }), NOW),
    classifyComputer(byom({ id: 'c3', name: 'TWIN', lastSeenAt: NOW }), NOW),
    classifyComputer(byom({ id: 'twin-id', name: 'c1' }), NOW),
  ];
  assert.equal(pickComputer(list, 'c1').name, 'Desk', 'an id wins over a name');
  assert.equal(pickComputer(list, 'desk').id, 'c1');
  assert.equal(pickComputer(list, 'c3').name, 'TWIN');
  assert.throws(
    () => pickComputer(list, 'twin'),
    (err: Error) => err instanceof Refused && /ambiguous.*c2 \(offline\).*c3 \(online\)/.test(err.message),
  );
  assert.throws(
    () => pickComputer(list, 'laptop'),
    (err: Error) => err instanceof Refused && /no computer named laptop; known computers: Desk, twin, TWIN, c1/.test(err.message),
  );
});

test('Computers caches for 30 s, marks this machine from computer.json, and require refuses offline computers', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'droid-mcp-computers-'));
  try {
    const file = join(dir, 'computer.json');
    await writeFile(file, JSON.stringify({ computerId: 'c-self', registeredAt: 1 }));
    const clock = { now: NOW };
    const api = fakeApi(() => ({
      computers: [
        { id: 'c-self', name: 'self', providerType: 'byom', status: 'active', providerStatus: null, lastSeenAt: NOW, createdAt: 1 },
        {
          id: 'c-dead',
          name: 'dead-box',
          providerType: 'byom',
          status: 'active',
          providerStatus: null,
          lastSeenAt: Date.UTC(2026, 10, 13, 11, 50),
          createdAt: 1,
        },
        { id: 'c-nap', name: 'nap', providerType: 'e2b', status: 'active', providerStatus: 'paused', lastSeenAt: 1, createdAt: 1 },
      ],
    }));
    const computers = new Computers({ rest: createRest({ apiKey: 'k', fetch: api.fetch }), file, now: () => clock.now });
    assert.equal((await computers.list()).find((c) => c.thisMachine)?.name, 'self');
    await computers.list();
    assert.equal(api.calls.length, 1, 'cached');
    clock.now += 31_000;
    await computers.list();
    assert.equal(api.calls.length, 2, 'expired after 30 s');
    await computers.list(true);
    assert.equal(api.calls.length, 3, 'fresh skips the cache');

    await assert.rejects(computers.require('dead-box'), (err: Error) => {
      assert.ok(err instanceof Refused);
      assert.equal(err.code, 'computer_offline');
      assert.equal(err.message, 'computer dead-box is offline (daemon last seen 2026-11-13T11:50:00Z)');
      assert.equal(err.fix, 'Start its daemon, or pick another computer from droid_computers.');
      return true;
    });
    assert.equal((await computers.require('nap')).state, 'paused', 'paused cloud computers may be named');
    assert.equal(await computers.thisName(), 'self');

    const bare = new Computers({ file, hostname: 'my-host' });
    assert.deepEqual(await bare.list(), [{ id: 'c-self', name: 'my-host', kind: 'own', state: 'online', thisMachine: true }]);
    const none = new Computers({ file: join(dir, 'missing.json'), hostname: 'my-host' });
    assert.equal((await none.require('my-host')).thisMachine, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

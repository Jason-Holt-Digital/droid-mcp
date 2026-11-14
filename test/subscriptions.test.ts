import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Subscriptions } from '../src/subscriptions.ts';

const A = '4d3c2b1a-0f9e-5d8c-b7a6-123456789abc';
const B = '5e4d3c2b-1a0f-5e9d-c8b7-23456789abcd';

async function withDir(fn: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'droid-mcp-subs-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('subscriptions survive a new store on the same file, and so does an unsubscribe', () =>
  withDir(async (dir) => {
    const path = join(dir, 'nested', 'subscriptions.json');
    const logs: string[] = [];
    const first = new Subscriptions(path, (m) => logs.push(m));
    assert.equal(first.has(A), false);
    await Promise.all([first.set(A, true), first.set(B, true)]);
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { sessions: [A, B] });
    const second = new Subscriptions(path);
    assert.equal(second.has(A), true);
    assert.equal(second.has(B), true);
    await second.set(A, false);
    await second.set(A, false);
    const third = new Subscriptions(path);
    assert.equal(third.has(A), false);
    assert.equal(third.has(B), true);
    assert.deepEqual(logs, [], 'a missing file is the normal first start');
  }));

test('two stores on one file see and keep each other’s changes', () =>
  withDir(async (dir) => {
    const path = join(dir, 'subscriptions.json');
    const first = new Subscriptions(path);
    const second = new Subscriptions(path);
    await first.set(A, true);
    assert.equal(second.has(A), true);
    await first.set(B, true);
    await second.set(A, false);
    assert.equal(first.has(A), false);
    assert.equal(first.has(B), true);
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { sessions: [B] });
  }));

test('a corrupt or malformed file starts empty and logs once', () =>
  withDir(async (dir) => {
    for (const body of ['{not json', '{"sessions": "x"}', 'null']) {
      const path = join(dir, 'subscriptions.json');
      await writeFile(path, body);
      const logs: string[] = [];
      const subs = new Subscriptions(path, (m) => logs.push(m));
      assert.equal(subs.has(A), false, body);
      assert.equal(logs.length, 1, body);
      assert.match(logs[0], /starting with no subscriptions/);
      await subs.set(A, true);
      assert.equal(new Subscriptions(path).has(A), true, 'the next save replaces the bad file');
    }
    const path = join(dir, 'mixed.json');
    await writeFile(path, JSON.stringify({ sessions: [A, '../etc', 7] }));
    const subs = new Subscriptions(path);
    assert.equal(subs.has(A), true);
    assert.equal(subs.has('../etc'), false);
  }));

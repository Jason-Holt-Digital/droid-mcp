import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Refused } from '../src/config.ts';
import { KeyStore } from '../src/runs.ts';

async function withDir(fn: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'droid-mcp-keys-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('a completed key replays its result in a fresh store; a failed one can be retried', () =>
  withDir(async (dir) => {
    const path = join(dir, 'state.json');
    let calls = 0;
    assert.equal(await new KeyStore(path).once('k', async () => ++calls), 1);
    assert.equal(await new KeyStore(path).once('k', async () => ++calls), 1);
    await assert.rejects(
      new KeyStore(path).once('busy', async () => Promise.reject(new Refused('busy', 'busy', 'wait'))),
      /busy/,
    );
    assert.equal(await new KeyStore(path).once('busy', async () => 'ok'), 'ok', 'a refusal before any effect can be retried');
    await assert.rejects(
      new KeyStore(path).once('net', async () => Promise.reject(new Error('socket hang up'))),
      /socket/,
    );
    await assert.rejects(
      new KeyStore(path).once('net', async () => 'again'),
      /may have taken effect/,
      'an error after a possible effect is not retried',
    );
  }));

test('a key whose action never finished (crash) refuses instead of running twice', () =>
  withDir(async (dir) => {
    const path = join(dir, 'state.json');
    await writeFile(path, JSON.stringify({ keys: { k: { at: Date.now(), pending: true } } }));
    await assert.rejects(
      new KeyStore(path).once('k', async () => 'again'),
      /did not finish/,
    );
  }));

test('concurrent keys in one store are all persisted', () =>
  withDir(async (dir) => {
    const path = join(dir, 'state.json');
    const store = new KeyStore(path);
    await Promise.all(['a', 'b', 'c'].map((k) => store.once(k, async () => k)));
    assert.deepEqual(Object.keys(JSON.parse(await readFile(path, 'utf8')).keys).sort(), ['a', 'b', 'c']);
  }));

test('an unreadable state file fails closed rather than forgetting completed work', () =>
  withDir(async (dir) => {
    const path = join(dir, 'state.json');
    await writeFile(path, '{not json');
    await assert.rejects(new KeyStore(path).once('k', async () => 'x'));
  }));

test("two server processes sharing the file keep each other's keys, and a concurrent retry joins the first attempt", () =>
  withDir(async (dir) => {
    const path = join(dir, 'state.json');
    const a = new KeyStore(path);
    const b = new KeyStore(path);
    let calls = 0;
    const slow = () => new Promise<number>((r) => setTimeout(() => r(++calls), 20));
    const [x, y] = await Promise.all([a.once('k', slow), a.once('k', slow)]);
    assert.equal(x, y);
    await b.once('other', async () => 'b');
    await a.once('third', async () => 'a');
    assert.deepEqual(Object.keys(JSON.parse(await readFile(path, 'utf8')).keys).sort(), ['k', 'other', 'third']);
    assert.equal(calls, 1);
  }));

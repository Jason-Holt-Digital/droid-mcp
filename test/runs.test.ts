import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SessionRecord } from '../src/catalog.ts';
import { ToolError } from '../src/config.ts';
import { move, Runs, type OwnRun, type RunState } from '../src/runs.ts';
import { fakeResume } from './helpers.ts';

const ID = '3f2e1d0c-9b8a-5c7d-8e6f-5a4b3c2d1e0f';
const STATES: RunState[] = ['working', 'needs_you', 'idle', 'dead', 'closed'];
const LEGAL = new Set([
  'working>needs_you',
  'working>idle',
  'working>dead',
  'working>closed',
  'needs_you>working',
  'needs_you>dead',
  'needs_you>closed',
  'idle>working',
  'idle>dead',
  'idle>closed',
  'dead>working',
  'dead>closed',
]);

test('the transition table allows exactly the legal state changes', () => {
  for (const from of STATES) {
    for (const to of STATES) {
      const run = { state: from };
      if (LEGAL.has(`${from}>${to}`)) {
        move(run, to);
        assert.equal(run.state, to);
      } else {
        assert.throws(
          () => move(run, to),
          (err) => err instanceof ToolError && err.code === 'internal',
          `${from} -> ${to}`,
        );
        assert.equal(run.state, from);
      }
    }
  }
});

async function started(fail?: Error) {
  const fake = fakeResume(fail);
  const runs = new Runs({ apiKey: 'k', repoOf: (cwd) => cwd, resumeSession: fake.resume });
  const run = await runs.resume({ id: ID } as SessionRecord, '/repo', 'first');
  return { runs, run, made: fake.made };
}

const lastState = (run: OwnRun) => run.events.filter((e) => e.kind === 'state').at(-1)?.text;

test('a droid process that exits while idle leaves the run dead and wakes waiters', async () => {
  const { runs, run, made } = await started();
  assert.equal(run.state, 'working');
  made[0].finish();
  await run.turn;
  assert.equal(run.state, 'idle');
  const waited = runs.wait(run, run.nextSeq - 1, 5000);
  const t = Date.now();
  made[0].exit();
  assert.equal(run.state, 'dead');
  assert.deepEqual(
    (await waited).events.map((e) => [e.kind, e.text]),
    [['state', 'dead']],
  );
  assert.ok(Date.now() - t < 1000);
});

test('a droid process that exits mid-turn with a pending prompt leaves the run dead and cancels the prompt', async () => {
  const { runs, run, made } = await started();
  const answer = made[0].options.permissionHandler!({
    toolUses: [{ toolUse: { name: 'Execute', input: { command: 'ls' } } }],
    options: [{ value: 'proceed_once' }, { value: 'cancel' }],
  });
  assert.equal(run.state, 'needs_you');
  assert.equal(runs.pendingRequests(run).length, 1);
  made[0].exit();
  assert.equal(run.state, 'dead');
  assert.equal(await answer, 'cancel');
  assert.equal(run.pending.size, 0);
  assert.ok(run.events.some((e) => e.kind === 'state' && e.text.startsWith('cancelled')));
  assert.equal(lastState(run), 'dead');
  await run.turn;
  assert.equal(run.state, 'dead', 'the failed stream does not move a dead run back to idle');
});

test('a send to a dead run resumes it in a new droid process under the same id, then sends', async () => {
  const { runs, run, made } = await started();
  made[0].exit();
  await run.turn;
  await runs.send(run, 'again', 'queue');
  assert.equal(run.state, 'working');
  assert.equal(run.id, ID);
  assert.equal(made.length, 2);
  assert.equal(made[0].closed, true, 'the dead process is cleaned up');
  assert.deepEqual(made[1].prompts, ['again']);
  made[0].exit();
  assert.equal(run.state, 'working', 'the old process no longer counts');
});

test('a failed resume of a dead run is a ToolError with a fix and leaves it dead', async () => {
  const { runs, run, made } = await started();
  made[0].exit();
  await run.turn;
  const fail = fakeResume(new Error('session file locked'));
  const failing = new Runs({ apiKey: 'k', repoOf: (cwd) => cwd, resumeSession: fail.resume });
  await assert.rejects(
    failing.send(run, 'again', 'queue'),
    (err) => err instanceof ToolError && err.code === 'internal' && /resuming it failed: session file locked/.test(err.message) && /droid_start/.test(err.fix),
  );
  assert.equal(run.state, 'dead');
  await runs.send(run, 'retry', 'queue');
  assert.equal(run.state, 'working');
});

test('a run closed by us stays closed when its process exits afterwards', async () => {
  const { runs, run, made } = await started();
  await runs.cancel(run, 'session');
  assert.equal(run.state, 'closed');
  assert.equal(lastState(run), 'closed');
  made[0].exit();
  assert.equal(run.state, 'closed');
  assert.ok(!run.events.some((e) => e.text === 'dead'));
});

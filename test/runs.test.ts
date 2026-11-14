import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
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

const IDLE_MS = 1000;
const flush = () => new Promise((resolve) => setImmediate(resolve));

async function forked(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fake = fakeResume();
  const runs = new Runs({ apiKey: 'k', repoOf: (cwd) => cwd, resumeSession: fake.resume, idleMs: IDLE_MS });
  const run = await runs.start({ cwd: '/repo', prompt: 'first', autonomy: 'off', settings: { fork: ID } });
  return { runs, run, made: fake.made };
}

async function endTurn(run: OwnRun, droid: { finish: () => void }) {
  droid.finish();
  await run.turn;
  assert.equal(run.state, 'idle');
}

test('a started run closes itself after the idle time, stopping the process and pushing a state event', async (t) => {
  const { run, made } = await forked(t);
  await endTurn(run, made[0]);
  t.mock.timers.tick(IDLE_MS - 1);
  await flush();
  assert.equal(run.state, 'idle');
  t.mock.timers.tick(1);
  await flush();
  assert.equal(run.state, 'closed');
  assert.equal(made[0].closed, true);
  assert.match(lastState(run) ?? '', /^closed after .* min idle$/);
  assert.equal(run.idleTimer, undefined);
});

test('a started run that auto-closed and is resumed keeps auto-closing', async (t) => {
  const { runs, run, made } = await forked(t);
  await endTurn(run, made[0]);
  t.mock.timers.tick(IDLE_MS);
  await flush();
  assert.equal(run.state, 'closed');
  const again = await runs.resume({ id: run.id } as SessionRecord, '/repo', 'more');
  assert.equal(again.autoClose, true);
});

test('a send before the idle time resets the timer', async (t) => {
  const { runs, run, made } = await forked(t);
  await endTurn(run, made[0]);
  t.mock.timers.tick(IDLE_MS - 10);
  await runs.send(run, 'again', 'queue');
  t.mock.timers.tick(IDLE_MS);
  await flush();
  assert.equal(run.state, 'working');
  await endTurn(run, made[0]);
  t.mock.timers.tick(IDLE_MS - 10);
  await flush();
  assert.equal(run.state, 'idle', 'the timer restarted when the second turn ended');
  t.mock.timers.tick(10);
  await flush();
  assert.equal(run.state, 'closed');
});

test('a long working or needs_you turn is never closed for idleness', async (t) => {
  const { run, made } = await forked(t);
  t.mock.timers.tick(IDLE_MS * 10);
  await flush();
  assert.equal(run.state, 'working');
  void made[0].options.permissionHandler!({ toolUses: [], options: [{ value: 'proceed_once' }] });
  assert.equal(run.state, 'needs_you');
  t.mock.timers.tick(IDLE_MS * 10);
  await flush();
  assert.equal(run.state, 'needs_you');
  assert.equal(made[0].closed, false);
});

test('a dead or closed run has no idle timer', async (t) => {
  const { runs, run, made } = await forked(t);
  await endTurn(run, made[0]);
  made[0].exit();
  assert.equal(run.state, 'dead');
  assert.equal(run.idleTimer, undefined);
  await runs.send(run, 'again', 'queue');
  await endTurn(run, made[1]);
  await runs.cancel(run, 'session');
  assert.equal(run.idleTimer, undefined);
  t.mock.timers.tick(IDLE_MS * 2);
  await flush();
  assert.equal(lastState(run), 'closed');
});

test('a resumed session of the user is never auto-closed', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fake = fakeResume();
  const runs = new Runs({ apiKey: 'k', repoOf: (cwd) => cwd, resumeSession: fake.resume, idleMs: IDLE_MS });
  const run = await runs.resume({ id: ID } as SessionRecord, '/repo', 'first');
  await endTurn(run, fake.made[0]);
  assert.equal(run.idleTimer, undefined);
  t.mock.timers.tick(IDLE_MS * 10);
  await flush();
  assert.equal(run.state, 'idle');
  assert.equal(fake.made[0].closed, false);
});

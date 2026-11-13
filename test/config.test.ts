import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { allowedDecisions, allowedRoots, autonomyCap, checkCwd, resolveAutonomy } from '../src/config.ts';

let dir: string;
let root: string;
let outside: string;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'droid-mcp-config-'));
  root = join(dir, 'repos');
  outside = join(dir, 'outside');
  await mkdir(join(root, 'proj', 'sub'), { recursive: true });
  await mkdir(outside);
  await symlink(outside, join(root, 'escape'));
  await symlink(join(root, 'proj'), join(root, 'alias'));
});
after(() => rm(dir, { recursive: true, force: true }));

test('allowedRoots defaults to ~/repos and reads a colon list', () => {
  assert.deepEqual(allowedRoots({}), [join(homedir(), 'repos')]);
  assert.deepEqual(allowedRoots({ DROID_MCP_ROOTS: '/a:/b::' }), ['/a', '/b']);
});

test('checkCwd accepts directories inside a root and returns the real path', async () => {
  const proj = await realpath(join(root, 'proj'));
  assert.equal(checkCwd(join(root, 'proj'), [root]), proj);
  assert.equal(checkCwd(join(root, 'proj', 'sub', '..'), [root]), proj);
  assert.equal(checkCwd(join(root, 'alias'), [root]), proj, 'symlink that stays inside the root');
  assert.equal(checkCwd(root, [root]), await realpath(root));
});

test('checkCwd rejects .. escapes, symlink escapes, sibling prefixes and missing paths', async () => {
  assert.throws(() => checkCwd(join(root, 'proj', '..', '..', 'outside'), [root]), /outside the allowed roots/);
  assert.throws(() => checkCwd(join(root, 'escape'), [root]), /outside the allowed roots/);
  await mkdir(`${root}-evil`, { recursive: true });
  assert.throws(() => checkCwd(`${root}-evil`, [root]), /outside the allowed roots/);
  assert.throws(() => checkCwd(join(root, 'nope'), [root]), /does not exist/);
  assert.throws(() => checkCwd(join(root, 'proj'), [join(dir, 'missing-root')]), /outside the allowed roots/);
});

test('autonomy defaults to off, is capped at high, and DROID_MCP_MAX_AUTONOMY lowers the cap', () => {
  assert.equal(resolveAutonomy(undefined, {}), 'off');
  assert.equal(resolveAutonomy('high', {}), 'high');
  assert.equal(resolveAutonomy('medium', { DROID_MCP_MAX_AUTONOMY: 'medium' }), 'medium');
  assert.throws(() => resolveAutonomy('high', { DROID_MCP_MAX_AUTONOMY: 'medium' }), /exceeds the cap 'medium'/);
  assert.throws(() => resolveAutonomy('low', { DROID_MCP_MAX_AUTONOMY: 'off' }), /exceeds the cap 'off'/);
  assert.equal(autonomyCap({ DROID_MCP_MAX_AUTONOMY: 'hgih' }), 'off', 'a typo fails closed');
});

test('permission answers can never raise autonomy past the cap', () => {
  const offered = ['proceed_once', 'proceed_always', 'proceed_always_tools', 'proceed_auto_run', 'proceed_auto_run_low', 'proceed_auto_run_medium', 'proceed_auto_run_high', 'proceed_new_session', 'proceed_new_session_high', 'proceed_edit', 'cancel'];
  assert.deepEqual(allowedDecisions(offered, 'medium'), ['proceed_once', 'proceed_auto_run_low', 'proceed_auto_run_medium', 'cancel']);
  assert.deepEqual(allowedDecisions(offered, 'high'), ['proceed_once', 'proceed_auto_run_low', 'proceed_auto_run_medium', 'proceed_auto_run_high', 'proceed_new_session_high', 'cancel']);
});

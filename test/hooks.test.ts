import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseEventBody } from '../src/events.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const HOOK = join(ROOT, 'hooks', 'droid_mcp_hook.py');
const INSTALLER = join(ROOT, 'scripts', 'install_hooks.py');
const PS_INSTALLER = join(ROOT, 'scripts', 'install-hooks.ps1');
const skip = spawnSync('python3', ['--version']).error ? 'python3 not found' : false;
const pwshSkip = spawnSync('pwsh', ['-NoProfile', '-Command', 'exit 0']).error ? 'pwsh not found' : false;
const TOKEN = 'fake-events-token';
const SESSION = '11111111-2222-3333-4444-555555555555';

type Received = { auth?: string; type?: string; body: Record<string, unknown> };

function env(home: string): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...process.env, DROID_MCP_HOOK_HOME: home, DROID_MCP_EVENTS_TOKEN: TOKEN };
  for (const k of ['http_proxy', 'HTTP_PROXY', 'https_proxy', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY']) delete e[k];
  return e;
}

function run(cmd: string, args: string[], opts: { env: NodeJS.ProcessEnv; input?: string; shell?: boolean }) {
  return new Promise<{ code: number | null; stdout: string; stderr: string; ms: number }>((resolve, reject) => {
    const started = performance.now();
    const child = spawn(cmd, args, { env: opts.env, shell: opts.shell, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    // 'close' fires only once every holder of the stdio pipes has closed them, which is what Droid waits for.
    child.on('close', (code) => resolve({ code, stdout, stderr, ms: performance.now() - started }));
    child.stdin.end(opts.input ?? '');
  });
}

async function server(delayMs = 0) {
  const received: Received[] = [];
  let notify: () => void = () => {};
  const srv: Server = createServer(async (req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    received.push({ auth: req.headers.authorization, type: req.headers['content-type'], body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
    notify();
    setTimeout(() => res.writeHead(204).end(), delayMs);
  });
  srv.listen(0, '127.0.0.1');
  await once(srv, 'listening');
  const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/events`;
  const next = (ms = 5000) =>
    new Promise<Received | undefined>((resolve) => {
      if (received.length) return resolve(received.shift());
      const timer = setTimeout(() => resolve(undefined), ms);
      notify = () => {
        clearTimeout(timer);
        resolve(received.shift());
      };
    });
  const close = () => {
    srv.closeAllConnections();
    return new Promise<void>((r) => srv.close(() => r()));
  };
  return { url, next, close };
}

async function withHome(fn: (home: string) => Promise<void>) {
  const home = await mkdtemp(join(tmpdir(), 'droid-mcp-hooks-'));
  try {
    await fn(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

async function fakeSession(home: string, lastAssistant: string) {
  const dir = join(home, '.factory', 'sessions', '-tmp-fake-repo');
  await mkdir(dir, { recursive: true });
  const transcript = join(dir, `${SESSION}.jsonl`);
  const msg = (role: string, content: unknown) => JSON.stringify({ type: 'message', id: 'm', message: { role, content } });
  const lines = [
    JSON.stringify({ type: 'session_start', id: SESSION, title: 'Fake session title', cwd: '/tmp/fake-repo' }),
    msg('assistant', 'QUESTION: an old question outside the tail?'),
    // Pushes the header and the old message out of the 512 KB tail window.
    msg('user', 'x'.repeat(600 * 1024)),
    msg('user', [{ type: 'text', text: 'please do the fake task' }]),
    msg('assistant', [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: lastAssistant }]),
    msg('assistant', [{ type: 'tool_use', id: 't', name: 'Read', input: {} }]),
  ];
  await writeFile(transcript, lines.join('\n') + '\n');
  await writeFile(
    join(dir, `${SESSION}.settings.json`),
    JSON.stringify({ tags: [{ name: 'fake-tag', metadata: { a: 'b' } }, { name: 'second' }], autonomyLevel: 'off' }),
  );
  await writeFile(join(home, '.factory', 'computer.json'), JSON.stringify({ computerId: 'fake-computer', registeredAt: 'x' }));
  return transcript;
}

async function configure(home: string, url: string) {
  const dir = join(home, '.factory', 'droid-mcp');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'hook.json'), JSON.stringify({ url, token: TOKEN }), { mode: 0o600 });
}

const stopInput = (transcript: string) =>
  JSON.stringify({ session_id: SESSION, transcript_path: transcript, cwd: '/tmp/fake-repo', hook_event_name: 'Stop', stop_hook_active: false });

const install = (home: string, ...extra: string[]) =>
  run('python3', [INSTALLER, '--home', home, '--url', 'http://127.0.0.1:9/events', ...extra], { env: env(home) });

const ORIGINAL = {
  PreToolUse: [{ matcher: 'Execute', hooks: [{ type: 'command', command: '/usr/bin/true fake-guard', timeout: 10 }] }],
  Stop: [{ hooks: [{ type: 'command', command: '/usr/bin/true fake-stop', timeout: 3 }] }],
};

test('install keeps unrelated hooks, backs up, is idempotent, and uninstall restores the original events', { skip }, () =>
  withHome(async (home) => {
    const hooksPath = join(home, '.factory', 'hooks.json');
    await mkdir(join(home, '.factory'), { recursive: true });
    await writeFile(hooksPath, JSON.stringify(ORIGINAL, null, 2));

    const first = await install(home);
    assert.equal(first.code, 0, first.stderr);
    assert.equal(first.stdout.trim().split('\n').length, 1);
    assert.match(first.stdout, /snapshots hooks at startup/);
    assert.ok(!first.stdout.includes(TOKEN) && !first.stderr.includes(TOKEN));

    const installed = JSON.parse(await readFile(hooksPath, 'utf8'));
    assert.deepEqual(installed.PreToolUse, ORIGINAL.PreToolUse);
    assert.deepEqual(installed.Stop[0], ORIGINAL.Stop[0]);
    for (const event of ['Stop', 'Notification', 'SessionEnd']) {
      const ours = installed[event].at(-1).hooks;
      assert.equal(ours.length, 1);
      assert.equal(ours[0].type, 'command');
      assert.equal(ours[0].timeout, 5);
      assert.ok(ours[0].command.endsWith(join(home, '.factory', 'droid-mcp', 'droid_mcp_hook.py')), ours[0].command);
    }
    assert.equal(installed.Stop.length, 2);
    const backups = (await readdir(join(home, '.factory'))).filter((n) => /^hooks\.json\.bak-droid-mcp-\d{14}/.test(n));
    assert.equal(backups.length, 1);
    assert.deepEqual(JSON.parse(await readFile(join(home, '.factory', backups[0]), 'utf8')), ORIGINAL);

    const config = join(home, '.factory', 'droid-mcp', 'hook.json');
    assert.equal((await stat(config)).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await readFile(config, 'utf8')), { url: 'http://127.0.0.1:9/events', token: TOKEN });

    const firstText = await readFile(hooksPath, 'utf8');
    const second = await install(home);
    assert.equal(second.code, 0, second.stderr);
    assert.equal(await readFile(hooksPath, 'utf8'), firstText);

    const removed = await install(home, '--uninstall');
    assert.equal(removed.code, 0, removed.stderr);
    assert.deepEqual(JSON.parse(await readFile(hooksPath, 'utf8')), ORIGINAL);
    await assert.rejects(stat(join(home, '.factory', 'droid-mcp')));
    const after = (await readdir(join(home, '.factory'))).filter((n) => n.startsWith('hooks.json.bak-droid-mcp-'));
    assert.equal(after.length, 2, 'uninstall keeps its own backup without overwriting the first');
  }));

const USER_HOOK = { type: 'command', command: '/usr/bin/true user-shared', timeout: 3 };

async function sharedGroupSurvives(home: string, ourCommand: string, installer: (...extra: string[]) => ReturnType<typeof run>) {
  const hooksPath = join(home, '.factory', 'hooks.json');
  await mkdir(join(home, '.factory'), { recursive: true });
  const shared = { matcher: '*', hooks: [USER_HOOK, { type: 'command', command: ourCommand, timeout: 5 }] };
  await writeFile(hooksPath, JSON.stringify({ Stop: [shared] }, null, 2));

  for (const _ of [1, 2]) {
    const r = await installer();
    assert.equal(r.code, 0, r.stderr);
    const installed = JSON.parse(await readFile(hooksPath, 'utf8'));
    assert.deepEqual(installed.Stop[0], { matcher: '*', hooks: [USER_HOOK] });
    assert.equal(installed.Stop.length, 2);
    assert.equal(installed.Stop[1].hooks.length, 1);
  }

  const removed = await installer('--uninstall');
  assert.equal(removed.code, 0, removed.stderr);
  assert.deepEqual(JSON.parse(await readFile(hooksPath, 'utf8')), { Stop: [{ matcher: '*', hooks: [USER_HOOK] }] });
}

test('a user command sharing a group with ours keeps the group and its matcher through install and uninstall', { skip }, () =>
  withHome((home) => sharedGroupSurvives(home, `python3 ${join(home, '.factory', 'droid-mcp', 'droid_mcp_hook.py')}`, (...extra) => install(home, ...extra))));

test('the PowerShell installer keeps a user command sharing a group with ours', { skip: pwshSkip }, () =>
  withHome((home) =>
    sharedGroupSurvives(home, `pwsh -File "${join(home, '.factory', 'droid-mcp', 'droid-mcp-hook.ps1')}"`, (...extra) =>
      run(
        'pwsh',
        ['-NoProfile', '-NonInteractive', '-File', PS_INSTALLER, '-HomeDir', home, '-Url', 'http://127.0.0.1:9/events', ...(extra.length ? ['-Uninstall'] : [])],
        { env: env(home) },
      ),
    ),
  ));

test('install creates hooks.json when missing; token can come from stdin and is never printed', { skip }, () =>
  withHome(async (home) => {
    const e = env(home);
    delete e.DROID_MCP_EVENTS_TOKEN;
    const r = await run('python3', [INSTALLER, '--home', home, '--url', 'http://127.0.0.1:9/events', '--token-stdin'], { env: e, input: 'stdin-token\n' });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(!r.stdout.includes('stdin-token'));
    const hooks = JSON.parse(await readFile(join(home, '.factory', 'hooks.json'), 'utf8'));
    assert.deepEqual(Object.keys(hooks), ['Stop', 'Notification', 'SessionEnd']);
    assert.equal(JSON.parse(await readFile(join(home, '.factory', 'droid-mcp', 'hook.json'), 'utf8')).token, 'stdin-token');
    await install(home, '--uninstall');
    assert.deepEqual(JSON.parse(await readFile(join(home, '.factory', 'hooks.json'), 'utf8')), {});
  }));

test('the installed command posts a QUESTION from the last assistant message with the bearer and only the known fields', { skip }, () =>
  withHome(async (home) => {
    const srv = await server();
    try {
      const transcript = await fakeSession(home, 'I did the fake work.\nQUESTION: ship it?\nSay yes or no.');
      const r = await run('python3', [INSTALLER, '--home', home, '--url', srv.url], { env: env(home) });
      assert.equal(r.code, 0, r.stderr);
      const command = JSON.parse(await readFile(join(home, '.factory', 'hooks.json'), 'utf8')).Stop[0].hooks[0].command;
      const hook = await run(command, [], { env: env(home), input: stopInput(transcript), shell: true });
      assert.equal(hook.code, 0);
      assert.equal(hook.stdout, '');
      const got = await srv.next();
      assert.ok(got, 'no event received');
      assert.equal(got.auth, `Bearer ${TOKEN}`);
      assert.match(got.type ?? '', /application\/json/);
      assert.deepEqual(got.body, {
        computerId: 'fake-computer',
        host: hostname(),
        sessionId: SESSION,
        kind: 'question',
        title: 'Fake session title',
        text: 'QUESTION: ship it?\nSay yes or no.',
        cwd: '/tmp/fake-repo',
        tags: ['fake-tag', 'second'],
      });
    } finally {
      await srv.close();
    }
  }));

test('Stop without a QUESTION line posts finished with the last 300 characters', { skip }, () =>
  withHome(async (home) => {
    const srv = await server();
    try {
      const long = 'a'.repeat(500) + 'the end.';
      const transcript = await fakeSession(home, long);
      await configure(home, srv.url);
      const hook = await run('python3', [HOOK], { env: env(home), input: stopInput(transcript) });
      assert.equal(hook.code, 0);
      assert.equal(hook.stdout, '');
      const got = await srv.next();
      assert.equal(got?.body.kind, 'finished');
      assert.equal(got?.body.text, long.slice(-300));
    } finally {
      await srv.close();
    }
  }));

test('text is clipped to 1000 UTF-16 code units without splitting an emoji, so the server accepts it', { skip }, () =>
  withHome(async (home) => {
    const srv = await server();
    try {
      const kept = 'QUESTION: ' + 'a'.repeat(989);
      const transcript = await fakeSession(home, kept + '😀 and more text after the limit');
      await configure(home, srv.url);
      const hook = await run('python3', [HOOK], { env: env(home), input: stopInput(transcript) });
      assert.equal(hook.code, 0);
      const got = await srv.next();
      assert.ok(got, 'no event received');
      assert.ok((got.body.text as string).length <= 1000);
      assert.equal(got.body.text, kept);
      assert.equal(parseEventBody(got.body).text, kept);
    } finally {
      await srv.close();
    }
  }));

test('Notification maps permission_prompt and elicitation_dialog; idle_prompt and unknown events post nothing', { skip }, () =>
  withHome(async (home) => {
    const srv = await server();
    try {
      await configure(home, srv.url);
      const base = { session_id: SESSION, transcript_path: join(home, 'missing.jsonl'), cwd: '/tmp/fake-repo' };
      const send = (extra: object) => run('python3', [HOOK], { env: env(home), input: JSON.stringify({ ...base, ...extra }) });

      for (const r of [
        await send({ hook_event_name: 'Notification', notification_type: 'idle_prompt', message: 'idle' }),
        await send({ hook_event_name: 'PreToolUse', tool_name: 'Execute' }),
      ]) {
        assert.equal(r.code, 0);
        assert.equal(r.stdout, '');
      }
      assert.equal(await srv.next(1500), undefined, 'idle_prompt and PreToolUse must not post');

      await send({ hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Allow Execute?' });
      const perm = await srv.next();
      assert.equal(perm?.body.kind, 'permission');
      assert.equal(perm?.body.text, 'Allow Execute?');
      assert.equal(perm?.body.title, '');
      assert.deepEqual(perm?.body.tags, []);
      assert.equal('computerId' in (perm?.body ?? {}), false, 'no computer.json, no computerId');

      await send({ hook_event_name: 'Notification', notification_type: 'elicitation_dialog', message: 'Pick one' });
      assert.equal((await srv.next())?.body.kind, 'question');

      await send({ hook_event_name: 'SessionEnd', reason: 'logout' });
      const ended = await srv.next();
      assert.equal(ended?.body.kind, 'ended');
      assert.equal(ended?.body.text, 'logout');
    } finally {
      await srv.close();
    }
  }));

test('the hook returns in well under 1 s while the server takes 2 s to answer', { skip }, () =>
  withHome(async (home) => {
    const srv = await server(2000);
    try {
      const transcript = await fakeSession(home, 'done');
      await configure(home, srv.url);
      const hook = await run('python3', [HOOK], { env: env(home), input: stopInput(transcript) });
      assert.equal(hook.code, 0);
      assert.equal(hook.stdout, '');
      assert.ok(hook.ms < 1000, `hook took ${hook.ms.toFixed(0)} ms`);
      assert.equal((await srv.next())?.body.kind, 'finished', 'the detached child still delivers');
    } finally {
      await srv.close();
    }
  }));

test('an unreachable url or missing config still exits 0 quickly with no output', { skip }, () =>
  withHome(async (home) => {
    const transcript = await fakeSession(home, 'done');
    const noConfig = await run('python3', [HOOK], { env: env(home), input: stopInput(transcript) });
    assert.equal(noConfig.code, 0);
    assert.equal(noConfig.stdout + noConfig.stderr, '');

    const closed = await server();
    await closed.close();
    await configure(home, closed.url);
    for (const input of [stopInput(transcript), 'not json']) {
      const r = await run('python3', [HOOK], { env: env(home), input });
      assert.equal(r.code, 0);
      assert.equal(r.stdout + r.stderr, '');
      assert.ok(r.ms < 5000, `hook took ${r.ms.toFixed(0)} ms`);
    }
  }));

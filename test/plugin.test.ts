import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { needs } from './helpers.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const EVENTS = ['Stop', 'Notification', 'SessionEnd'];
const skip = needs('curl', ['--version']);

type Hooks = Record<string, { hooks: { type: string; command: string; timeout: number }[] }[]>;

const readJson = async (path: string) => JSON.parse(await readFile(join(ROOT, path), 'utf8'));

async function command() {
  const hooks: Hooks = await readJson('plugin/hooks/hooks.json');
  return hooks.Stop[0].hooks[0].command;
}

function run(cmd: string, home: string, input: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  for (const k of ['http_proxy', 'HTTP_PROXY', 'https_proxy', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY']) delete env[k];
  return new Promise<{ code: number | null; stdout: string; ms: number }>((resolve, reject) => {
    const started = performance.now();
    const child = spawn('sh', ['-c', cmd], { env, stdio: ['pipe', 'pipe', 'ignore'] });
    let stdout = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.on('error', reject);
    // curl exits without reading stdin when the curlrc is missing.
    child.stdin.on('error', () => {});
    child.on('close', (code) => resolve({ code, stdout, ms: performance.now() - started }));
    child.stdin.end(input);
  });
}

async function withHome(url: string | undefined, fn: (home: string) => Promise<void>) {
  const home = await mkdtemp(join(tmpdir(), 'droid-mcp-plugin-'));
  try {
    if (url) {
      await mkdir(join(home, '.factory'));
      await writeFile(join(home, '.factory', 'droid-mcp.curlrc'), `url = "${url}"\n`);
    }
    await fn(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

const INPUT = JSON.stringify({ session_id: 'fake-session', hook_event_name: 'Stop', cwd: '/tmp/x', note: 'ünïcode "quotes"\n' }) + '\n';

test('the marketplace lists one droid-mcp plugin from ./plugin with only hooks', async () => {
  const market = await readJson('.factory-plugin/marketplace.json');
  assert.equal(market.name, 'droid-mcp');
  assert.deepEqual(
    market.plugins.map((p: { name: string; source: string }) => [p.name, p.source]),
    [['droid-mcp', './plugin']],
  );
  assert.equal((await readJson('plugin/.factory-plugin/plugin.json')).name, 'droid-mcp');
  assert.deepEqual((await readdir(join(ROOT, 'plugin'))).sort(), ['.factory-plugin', 'hooks']);
  assert.deepEqual(await readdir(join(ROOT, 'plugin', 'hooks')), ['hooks.json']);
});

test('hooks.json covers exactly Stop, Notification and SessionEnd with one shared command', async () => {
  const hooks: Hooks = await readJson('plugin/hooks/hooks.json');
  assert.deepEqual(Object.keys(hooks), EVENTS);
  const all = EVENTS.flatMap((e) => hooks[e].flatMap((g) => g.hooks));
  assert.equal(all.length, EVENTS.length);
  for (const h of all) {
    assert.equal(h.type, 'command');
    assert.equal(h.command, all[0].command);
    assert.ok(h.timeout > 3 && h.timeout <= 5, `timeout ${h.timeout}`);
  }
});

test('the command posts stdin unchanged as application/json to the curlrc url, silently', { skip }, async () => {
  const got: { method?: string; url?: string; type?: string; body: Buffer }[] = [];
  const srv = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    got.push({ method: req.method, url: req.url, type: req.headers['content-type'], body: Buffer.concat(chunks) });
    res.writeHead(202, { 'content-type': 'application/json' }).end('{"seq":1}');
  });
  srv.listen(0, '127.0.0.1');
  await once(srv, 'listening');
  try {
    const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/events`;
    await withHome(url, async (home) => {
      const r = await run(await command(), home, INPUT);
      assert.equal(r.code, 0);
      assert.equal(r.stdout, '');
    });
    assert.equal(got.length, 1);
    assert.equal(got[0].method, 'POST');
    assert.equal(got[0].url, '/events');
    assert.equal(got[0].type, 'application/json');
    assert.ok(got[0].body.equals(Buffer.from(INPUT)), got[0].body.toString());
  } finally {
    srv.closeAllConnections();
    srv.close();
  }
});

test('without a curlrc, or with a closed port, the command exits 0 quickly with no output', { skip }, async () => {
  const closed = createServer();
  closed.listen(0, '127.0.0.1');
  await once(closed, 'listening');
  const url = `http://127.0.0.1:${(closed.address() as AddressInfo).port}/events`;
  closed.close();
  await once(closed, 'close');
  for (const curlrc of [undefined, url]) {
    await withHome(curlrc, async (home) => {
      const r = await run(await command(), home, INPUT);
      assert.equal(r.code, 0);
      assert.equal(r.stdout, '');
      assert.ok(r.ms < 2500, `took ${r.ms.toFixed(0)} ms`);
    });
  }
});

test('a server that never answers is cut off by the 3 s curl limit, inside the hook timeout', { skip }, async () => {
  const srv = createServer(() => {});
  srv.listen(0, '127.0.0.1');
  await once(srv, 'listening');
  try {
    await withHome(`http://127.0.0.1:${(srv.address() as AddressInfo).port}/events`, async (home) => {
      const r = await run(await command(), home, INPUT);
      assert.equal(r.code, 0);
      assert.equal(r.stdout, '');
      assert.ok(r.ms < 4500, `took ${r.ms.toFixed(0)} ms`);
    });
  } finally {
    srv.closeAllConnections();
    srv.close();
  }
});

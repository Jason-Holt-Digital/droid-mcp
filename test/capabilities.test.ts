import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  capabilities,
  curlrcUrl,
  doctorReport,
  localOnly,
  pasteLine,
  reachesBind,
  resolveBind,
  tailnetEventsUrl,
  type CapabilityInput,
} from '../src/capabilities.ts';
import { API_KEY_FIX } from '../src/config.ts';

const ALL: CapabilityInput = {
  apiKey: true,
  webhook: true,
  eventsToken: false,
  httpToken: true,
  http: '127.0.0.1:37999',
  roots: ['/home/dev/repos'],
  missingRoots: [],
  cap: 'medium',
  curlrcUrl: 'http://127.0.0.1:37999/events',
  pluginInstalled: true,
};

const byName = (input: CapabilityInput) => Object.fromEntries(capabilities(input).map((c) => [c.name, c]));

test('capabilities lists every check in order, all ok and without fixes when everything is set', () => {
  const checks = capabilities(ALL);
  assert.deepEqual(
    checks.map((c) => c.name),
    ['api_key', 'webhook', 'http', 'roots', 'autonomy_cap', 'plugin', 'curlrc', 'events_token'],
  );
  assert.ok(checks.every((c) => c.ok && c.fix === undefined && c.unlocks));
  const c = byName(ALL);
  assert.match(c.autonomy_cap.detail, /medium/);
  assert.match(c.events_token.detail, /legacy/);
  assert.match(c.api_key.unlocks, /other computers.*ring verification/);
});

test('each missing capability fails with a fix', () => {
  const c = byName({ ...ALL, apiKey: false, webhook: false, roots: [], pluginInstalled: false, curlrcUrl: 'http://old:1/events' });
  assert.deepEqual(
    Object.values(c)
      .filter((x) => !x.ok)
      .map((x) => x.name),
    ['api_key', 'webhook', 'roots', 'plugin', 'curlrc'],
  );
  assert.equal(c.api_key.fix, API_KEY_FIX);
  assert.match(c.plugin.fix ?? '', /droid plugin install droid-mcp@droid-mcp --scope user/);
  assert.equal(c.curlrc.detail, 'this machine: url is http://old:1/events, which does not reach 127.0.0.1:37999');
  assert.equal(c.curlrc.fix, 'Write this one line to ~/.factory/droid-mcp.curlrc: url = "http://127.0.0.1:37999/events"');
  assert.equal(byName({ ...ALL, curlrcUrl: undefined }).curlrc.ok, false);
});

test('when droid plugin list cannot run, the plugin state is unknown, not missing', () => {
  const c = byName({ ...ALL, pluginInstalled: undefined }).plugin;
  assert.equal(c.ok, false);
  assert.match(c.detail, /droid not on PATH/);
  assert.match(c.fix ?? '', /PATH/);
  assert.match(byName({ ...ALL, pluginInstalled: undefined, pluginError: 'droid plugin list timed out after 5 s' }).plugin.detail, /timed out/);
});

test('stdio is a sane http state with no events URL; a malformed host:port is not', () => {
  const stdio = byName({ ...ALL, http: undefined });
  assert.equal(stdio.http.ok, true);
  assert.match(stdio.http.detail, /no \/events/);
  assert.equal(stdio.curlrc.ok, false);
  assert.match(stdio.curlrc.fix ?? '', /--http/);
  const bad = byName({ ...ALL, http: 'nonsense' }).http;
  assert.equal(bad.ok, false);
  assert.match(bad.fix ?? '', /--http <host:port>/);
});

test('pasteLine installs the plugin and writes the url and computer header', () => {
  assert.equal(
    pasteLine('http://100.73.48.66:37999/events', 'comp-laptop'),
    `droid plugin marketplace add Jason-Holt-Digital/droid-mcp && droid plugin install droid-mcp@droid-mcp --scope user && printf 'url = "%s"\\nheader = "x-droid-mcp-computer: %s"\\n' 'http://100.73.48.66:37999/events' 'comp-laptop' > ~/.factory/droid-mcp.curlrc`,
  );
});

test('the printf half of pasteLine writes the two-line curlrc', { skip: process.platform === 'win32' }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'droid-mcp-paste-'));
  try {
    await mkdir(join(home, '.factory'));
    const write = pasteLine('http://100.73.48.66:37999/events', 'comp-laptop').split(' && ').at(-1)!;
    execFileSync('sh', ['-c', write], { env: { ...process.env, HOME: home } });
    const text = await readFile(join(home, '.factory', 'droid-mcp.curlrc'), 'utf8');
    assert.equal(text, 'url = "http://100.73.48.66:37999/events"\nheader = "x-droid-mcp-computer: comp-laptop"\n');
    assert.equal(curlrcUrl(text), 'http://100.73.48.66:37999/events');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('localOnly is true for loopback and wildcard binds only', () => {
  assert.deepEqual(['127.0.0.1:1', 'localhost:1', '[::1]:1', '0.0.0.0:1', '100.73.48.66:1', 'mac-mini.tail.ts.net:1'].map(localOnly), [
    true,
    true,
    true,
    true,
    false,
    false,
  ]);
});

test('roots fail when none exists, and the detail names the missing ones', () => {
  const none = byName({ ...ALL, roots: ['/a', '/b'], missingRoots: ['/a', '/b'] }).roots;
  assert.equal(none.ok, false);
  assert.match(none.detail, /missing: \/a:\/b$/);
  const some = byName({ ...ALL, roots: ['/a', '/b'], missingRoots: ['/a'] }).roots;
  assert.equal(some.ok, true);
  assert.match(some.detail, /missing: \/a$/);
});

test('the curlrc may point at the configured events URL or the --http address', () => {
  const eventsUrl = 'https://droid.example.ts.net/events';
  assert.equal(byName({ ...ALL, eventsUrl, curlrcUrl: eventsUrl }).curlrc.ok, true);
  assert.equal(byName({ ...ALL, eventsUrl, curlrcUrl: 'http://127.0.0.1:37999/events' }).curlrc.ok, true);
  const wrong = byName({ ...ALL, eventsUrl, curlrcUrl: 'http://old:1/events' }).curlrc;
  assert.equal(wrong.ok, false);
  assert.match(wrong.fix ?? '', /url = "https:\/\/droid\.example\.ts\.net\/events"/);
  assert.equal(byName({ ...ALL, http: undefined, eventsUrl, curlrcUrl: eventsUrl }).curlrc.ok, true, 'a configured URL works without --http');
});

test('the curlrc check accepts any url that reaches the bind address', () => {
  const ok = (http: string, curlrcUrl: string) => byName({ ...ALL, http, curlrcUrl, localAddresses: ['100.73.48.66', 'fd7a::1'] }).curlrc.ok;
  assert.equal(ok('127.0.0.1:37999', 'http://localhost:37999/events'), true, 'loopback alias');
  assert.equal(ok('0.0.0.0:37999', 'http://127.0.0.1:37999/events'), true, 'wildcard bind, loopback url');
  assert.equal(ok('0.0.0.0:37999', 'http://100.73.48.66:37999/events'), true, 'wildcard bind, tailnet url');
  assert.equal(ok('[::]:37999', 'http://[::1]:37999/events'), true, 'IPv6 wildcard');
  assert.equal(ok('100.73.48.66:37999', 'http://127.0.0.1:37999/events'), false, 'loopback does not reach a tailnet bind');
  assert.equal(ok('127.0.0.1:37999', 'http://127.0.0.2:37999/events'), false, 'another loopback address is another listener');
  assert.equal(ok('127.0.0.1:37999', 'http://[::1]:37999/events'), false, 'IPv6 loopback does not reach an IPv4 bind');
  assert.equal(ok('[::1]:37999', 'http://localhost:37999/events'), true, 'localhost reaches an IPv6 loopback bind');
  assert.equal(ok('0.0.0.0:37999', 'http://[::1]:37999/events'), false, 'an IPv4 wildcard takes no IPv6 address');
  assert.equal(ok('[::]:37999', 'http://127.0.0.1:37999/events'), true, 'an IPv6 wildcard takes IPv4 too');
  assert.equal(reachesBind('http://[::1]:37999/events', { host: 'localhost', port: 37999 }, { bindAddress: '::1' }), true, 'the address localhost resolved to');
  assert.equal(reachesBind('http://127.0.0.1:37999/events', { host: 'localhost', port: 37999 }, { bindAddress: '::1' }), false, 'not the other family');
  assert.equal(ok('0.0.0.0:37999', 'http://127.0.0.1:38000/events'), false, 'wrong port');
  assert.equal(ok('0.0.0.0:37999', 'http://127.0.0.1:37999/other'), false, 'wrong path');
  assert.equal(ok('0.0.0.0:37999', 'not a url'), false);
  assert.match(byName({ ...ALL, http: '0.0.0.0:37999', curlrcUrl: undefined }).curlrc.fix ?? '', /url = "http:\/\/127\.0\.0\.1:37999\/events"/);
});

test('a wildcard bind is reached only at an address of this machine', () => {
  const ok = (http: string, curlrcUrl: string, curlrcAddresses?: string[]) =>
    byName({ ...ALL, http, curlrcUrl, curlrcAddresses, localAddresses: ['100.73.48.66', 'fd7a::1'] }).curlrc.ok;
  assert.equal(ok('0.0.0.0:37999', 'http://192.0.2.123:37999/events'), false, 'a stale url pointing at another machine');
  assert.equal(ok('[::]:37999', 'http://192.0.2.123:37999/events'), false, 'the same under an IPv6 wildcard');
  assert.equal(ok('[::]:37999', 'http://[fd7a::1]:37999/events'), true, 'an IPv6 interface address');
  assert.equal(ok('0.0.0.0:37999', 'http://[fd7a::1]:37999/events'), false, 'but not under an IPv4 wildcard');
  assert.equal(ok('0.0.0.0:37999', 'http://mini.tail:37999/events', ['100.73.48.66']), true, 'a name resolving to this machine');
  assert.equal(ok('0.0.0.0:37999', 'http://other.tail:37999/events', ['100.64.0.9']), false, 'a name resolving elsewhere');
  assert.equal(ok('0.0.0.0:37999', 'http://other.tail:37999/events'), false, 'a name that did not resolve');
  assert.equal(ok('0.0.0.0:37999', 'http://localhost:37999/events'), true, 'localhost');
});

test('--http without DROID_MCP_TOKEN fails the http check and the doctor', () => {
  const c = byName({ ...ALL, httpToken: false }).http;
  assert.equal(c.ok, false);
  assert.match(c.detail, /DROID_MCP_TOKEN is not set/);
  assert.equal(doctorReport(capabilities({ ...ALL, httpToken: false })).code, 1);
  assert.equal(byName({ ...ALL, http: undefined, httpToken: false }).http.ok, true, 'stdio needs no token');
});

test('an out-of-range port is not a valid --http value', () => {
  for (const http of ['127.0.0.1:99999', '127.0.0.1:0']) assert.equal(byName({ ...ALL, http }).http.ok, false, http);
  assert.equal(byName({ ...ALL, http: '[::1]:65535' }).http.ok, true);
});

test('curlrcUrl reads the url with or without quotes and ignores the header line', () => {
  assert.equal(curlrcUrl('url = "http://a:1/events"\nheader = "x-droid-mcp-computer: c"\n'), 'http://a:1/events');
  assert.equal(curlrcUrl('url=http://b:2/events'), 'http://b:2/events');
  assert.equal(curlrcUrl('header = "x: y"'), undefined);
});

test('doctorReport prints one aligned line per check and fails only on api_key, http and roots', () => {
  const ok = doctorReport(capabilities({ ...ALL, http: undefined, webhook: false, pluginInstalled: false }));
  assert.equal(ok.code, 0, 'stdio, no webhook and no plugin do not fail the doctor');
  assert.equal(ok.lines.length, 8);
  assert.equal(ok.lines[0], 'ok   api_key       FACTORY_API_KEY found');
  assert.match(ok.lines[1], /^FIX {2}webhook {7}.* -> Set DROID_MCP_WEBHOOK_URL/);
  for (const broken of [{ apiKey: false }, { roots: [] }, { http: 'nonsense' }, { missingRoots: ['/home/dev/repos'] }]) {
    assert.equal(doctorReport(capabilities({ ...ALL, ...broken })).code, 1, JSON.stringify(broken));
  }
});

test('curlrcUrl reads the first active url and skips comments', () => {
  assert.equal(curlrcUrl('# url = "http://old:37999/events"\nurl = "http://127.0.0.1:37999/events"\n'), 'http://127.0.0.1:37999/events');
  assert.equal(curlrcUrl('  # url = "http://old/events"\n--url http://new:1/events\n'), 'http://new:1/events');
  assert.equal(curlrcUrl('header = "x-droid-mcp-computer: c"\n# url = "http://old/events"\n'), undefined);
  assert.equal(curlrcUrl('url = "http://a:1/events"\nheader = "x-droid-mcp-computer: c"\n'), 'http://a:1/events');
});

test('resolveBind resolves a hostname bind and leaves addresses alone', async () => {
  assert.equal(await resolveBind('127.0.0.1:37999'), undefined);
  assert.equal(await resolveBind(undefined), undefined);
  assert.ok(['127.0.0.1', '::1'].includes((await resolveBind('localhost:37999')) ?? ''));
});

const SERVE = JSON.stringify({
  TCP: { 8443: { HTTPS: true } },
  Web: { 'jasons-mac-mini.tail57dad6.ts.net:8443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:37999' } } } },
});
const serve = (web: unknown) => async () => JSON.stringify({ Web: web });

test('tailnetEventsUrl finds the tailscale serve address that proxies to the bind', async () => {
  const url = 'https://jasons-mac-mini.tail57dad6.ts.net:8443/events';
  assert.equal(await tailnetEventsUrl('127.0.0.1:37999', { run: async () => SERVE }), url);
  assert.equal(await tailnetEventsUrl('localhost:37999', { run: async () => SERVE }), url, 'both loopback');
  assert.equal(await tailnetEventsUrl('0.0.0.0:37999', { run: async () => SERVE }), url, 'wildcard bind');
  assert.equal(await tailnetEventsUrl('127.0.0.1:38000', { run: async () => SERVE }), undefined, 'wrong port');
  assert.equal(await tailnetEventsUrl('100.73.48.66:37999', { run: async () => SERVE }), undefined, 'another host');
  assert.equal(await tailnetEventsUrl(undefined, { run: async () => SERVE }), undefined);
  assert.equal(await tailnetEventsUrl('nope', { run: async () => SERVE }), undefined);
  const bare = serve({ 'box.ts.net:443': { Handlers: { '/events': { Proxy: '37999' } } } });
  assert.equal(await tailnetEventsUrl('127.0.0.1:37999', { run: bare }), 'https://box.ts.net/events');
  const slash = serve({ 'a.ts.net:443': { Handlers: { '/': { Text: 'hi' } } }, 'b.ts.net:8443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:37999/' } } } });
  assert.equal(await tailnetEventsUrl('127.0.0.1:37999', { run: slash }), 'https://b.ts.net:8443/events');
  const other = serve({ 'c.ts.net:443': { Handlers: { '/api': { Proxy: 'http://127.0.0.1:37999' } } } });
  assert.equal(await tailnetEventsUrl('127.0.0.1:37999', { run: other }), undefined, 'other paths do not count');
});

test('tailnetEventsUrl tries each tailscale binary and never throws', async () => {
  const files: string[] = [];
  const second = async (file: string) => {
    files.push(file);
    if (files.length === 1) throw new Error('ENOENT');
    return SERVE;
  };
  assert.equal(await tailnetEventsUrl('127.0.0.1:37999', { run: second }), 'https://jasons-mac-mini.tail57dad6.ts.net:8443/events');
  assert.equal(files[0], 'tailscale');
  assert.equal(files.length, 2);
  const failing = async () => {
    throw new Error('not running');
  };
  assert.equal(await tailnetEventsUrl('127.0.0.1:37999', { run: failing }), undefined);
  assert.equal(await tailnetEventsUrl('127.0.0.1:37999', { run: async () => 'not json' }), undefined);
  assert.equal(await tailnetEventsUrl('127.0.0.1:37999', { run: async () => 'null' }), undefined);
});

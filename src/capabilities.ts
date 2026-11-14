import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { API_KEY_FIX, type Autonomy } from './config.ts';

export type Check = { name: string; ok: boolean; detail: string; unlocks: string; fix?: string };
export type ThisMachine = { curlrcUrl?: string; pluginInstalled?: boolean; pluginError?: string };
export type CapabilityInput = ThisMachine & {
  apiKey: boolean;
  webhook: boolean;
  eventsToken: boolean;
  // Whether DROID_MCP_TOKEN is set; --http refuses to start without it.
  httpToken: boolean;
  http?: string;
  roots: string[];
  // Roots that do not exist; checkCwd skips them, so droid_start works only under the others.
  missingRoots: string[];
  cap: Autonomy;
};

export const PLUGIN_INSTALL = 'droid plugin marketplace add Jason-Holt-Digital/droid-mcp && droid plugin install droid-mcp@droid-mcp --scope user';
const HTTP_FIX = 'Run the server with --http <host:port> and DROID_MCP_TOKEN.';
const REQUIRED = ['api_key', 'http', 'roots'];

export function hostPort(spec: string): { host: string; port: number } | undefined {
  const m = /^(.+):(\d+)$/.exec(spec);
  const port = Number(m?.[2]);
  return m && port >= 1 && port <= 65535 ? { host: m[1].replace(/^\[(.*)\]$/, '$1'), port } : undefined;
}

export const eventsUrl = (http: string) => `http://${http}/events`;

// Loopback and wildcard binds give a URL that other computers cannot use.
export function localOnly(http: string): boolean {
  const host = hostPort(http)?.host ?? '';
  return isLoopback(host) || isWildcard(host);
}

export function pasteLine(url: string, computerId: string): string {
  return `${PLUGIN_INSTALL} && printf 'url = "%s"\\nheader = "x-droid-mcp-computer: %s"\\n' '${url}' '${computerId}' > ~/.factory/droid-mcp.curlrc`;
}

function check(name: string, ok: boolean, detail: string, unlocks: string, fix: string): Check {
  return ok ? { name, ok, detail, unlocks } : { name, ok, detail, unlocks, fix };
}

function httpCheck(http: string | undefined, token: boolean): Check {
  const unlocks = 'rings from the plugin';
  if (http === undefined) return check('http', true, 'stdio: there is no /events endpoint, so plugin rings cannot reach this server', unlocks, '');
  if (hostPort(http) === undefined) return check('http', false, `${http} is not host:port`, unlocks, HTTP_FIX);
  return check('http', token, token ? `events URL is ${eventsUrl(http)}` : 'DROID_MCP_TOKEN is not set, so --http will not start', unlocks, HTTP_FIX);
}

function pluginCheck(installed: boolean | undefined, error = 'droid not on PATH'): Check {
  const detail = installed === undefined ? error : installed ? 'droid-mcp plugin installed' : 'droid-mcp plugin not installed';
  const fix = installed === undefined ? "Make sure `droid plugin list` runs with this process's PATH." : PLUGIN_INSTALL;
  return check('plugin', installed === true, `this machine: ${detail}`, 'rings from this machine', fix);
}

const isLoopback = (host: string) => host === 'localhost' || host === '::1' || host.startsWith('127.');
const isWildcard = (host: string) => host === '0.0.0.0' || host === '::';

// Whether a curlrc url on this machine reaches a server bound to `bind`: the exact address, a loopback
// address when bound to loopback, or any host on the port when bound to every interface.
export function reachesBind(url: string, bind: { host: string; port: number }): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const host = u.hostname.replace(/^\[(.*)\]$/, '$1');
  if (u.protocol !== 'http:' || u.pathname !== '/events' || Number(u.port || 80) !== bind.port) return false;
  return host === bind.host || isWildcard(bind.host) || (isLoopback(bind.host) && isLoopback(host));
}

function curlrcCheck(http: string | undefined, url: string | undefined): Check {
  const unlocks = 'rings from this machine reaching this server';
  const bind = http === undefined ? undefined : hostPort(http);
  if (!bind) return check('curlrc', false, 'no events URL to point the curlrc at', unlocks, HTTP_FIX);
  const want = isWildcard(bind.host) ? `http://127.0.0.1:${bind.port}/events` : eventsUrl(http!);
  const ok = url !== undefined && reachesBind(url, bind);
  const detail = url === undefined ? 'no url in ~/.factory/droid-mcp.curlrc' : ok ? `url is ${url}` : `url is ${url}, which does not reach ${http}`;
  return check('curlrc', ok, `this machine: ${detail}`, unlocks, `Write this one line to ~/.factory/droid-mcp.curlrc: url = "${want}"`);
}

export function capabilities(input: CapabilityInput): Check[] {
  return [
    check(
      'api_key',
      input.apiKey,
      input.apiKey ? 'FACTORY_API_KEY found' : 'FACTORY_API_KEY not set',
      'other computers, sending to sessions this server did not start, ring verification',
      API_KEY_FIX,
    ),
    check(
      'webhook',
      input.webhook,
      input.webhook ? 'webhook URL and key set' : 'DROID_MCP_WEBHOOK_URL and DROID_MCP_WEBHOOK_KEY are not both set',
      'waking the agent',
      'Set DROID_MCP_WEBHOOK_URL and DROID_MCP_WEBHOOK_KEY (or Keychain accounts WEBHOOK_URL and WEBHOOK_KEY), then restart.',
    ),
    httpCheck(input.http, input.httpToken),
    check(
      'roots',
      input.roots.some((r) => !input.missingRoots.includes(r)),
      (input.roots.join(':') || 'no roots') + (input.missingRoots.length ? `; missing: ${input.missingRoots.join(':')}` : ''),
      'droid_start in these directories',
      'Set DROID_MCP_ROOTS to colon-separated project directories.',
    ),
    check('autonomy_cap', true, `cap is ${input.cap} (DROID_MCP_MAX_AUTONOMY)`, `autonomy up to ${input.cap}`, ''),
    pluginCheck(input.pluginInstalled, input.pluginError),
    curlrcCheck(input.http, input.curlrcUrl),
    check(
      'events_token',
      true,
      `DROID_MCP_EVENTS_TOKEN ${input.eventsToken ? 'set' : 'not set'}; the token hook path is legacy, the plugin needs no token`,
      'legacy token hooks',
      '',
    ),
  ];
}

export function doctorReport(checks: Check[]): { lines: string[]; code: number } {
  const width = Math.max(...checks.map((c) => c.name.length));
  const lines = checks.map((c) => (c.ok ? `ok   ${c.name.padEnd(width)}  ${c.detail}` : `FIX  ${c.name.padEnd(width)}  ${c.detail} -> ${c.fix}`));
  return { lines, code: checks.every((c) => c.ok || !REQUIRED.includes(c.name)) ? 0 : 1 };
}

export const missingRoots = (roots: string[]) => roots.filter((r) => !existsSync(r));

export const curlrcUrl = (text: string) => /url\s*=\s*"?([^"\s]+)/.exec(text)?.[1];

export async function probeThisMachine(): Promise<ThisMachine> {
  const [url, plugin] = await Promise.all([
    readFile(join(homedir(), '.factory', 'droid-mcp.curlrc'), 'utf8').then(curlrcUrl, () => undefined),
    new Promise<Pick<ThisMachine, 'pluginInstalled' | 'pluginError'>>((resolve) =>
      execFile('droid', ['plugin', 'list'], { timeout: 5000 }, (err, stdout) => {
        if (!err) return resolve({ pluginInstalled: stdout.includes('droid-mcp@') });
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return resolve({});
        resolve({ pluginError: err.killed ? 'droid plugin list timed out after 5 s' : `droid plugin list failed: ${err.message.split('\n')[0]}` });
      }),
    ),
  ]);
  return { curlrcUrl: url, ...plugin };
}

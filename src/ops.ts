import { readFileSync } from 'node:fs';
import { connectAndAuthenticate, createWebSocketDaemonClient, MachineType, SDK_VERSION } from '@factory/droid-sdk/node';
import type { Computers } from './computers.ts';
import { API_KEY_FIX, autonomyCap, exceedsCap, Refused, ToolError, type Autonomy } from './config.ts';
import type { HttpMethod, Rest, RestRequest } from './rest.ts';

type ParamSchema = { type?: string; properties?: Record<string, unknown>; required?: string[]; description?: string };
// readOnly, destructive and secret come from the catalog, where scripts/codegen.ts sets them by HTTP method and hand-checked lists.
export type Operation = {
  id: string;
  source: 'daemon' | 'rest';
  name: string;
  summary: string;
  params: ParamSchema;
  readOnly: boolean;
  destructive: boolean;
  secret: boolean;
};
export type DaemonCall = (method: string, params: Record<string, unknown> | undefined) => Promise<unknown>;
type OpsContext = { env?: NodeJS.ProcessEnv; rest?: Pick<Rest, 'call'>; computers: Pick<Computers, 'resolve'>; daemon?: DaemonCall };
type CallArgs = { id: string; params?: Record<string, unknown>; confirm?: boolean; computer?: string };

const OPERATIONS: Operation[] = JSON.parse(readFileSync(new URL('./generated/catalog.json', import.meta.url), 'utf8')).operations;
const BY_ID = new Map(OPERATIONS.map((o) => [o.id, o]));
export const ALLOW_DESTRUCTIVE = 'DROID_MCP_ALLOW_DESTRUCTIVE';
const RELAY_TIMEOUT_MS = 30_000;

// The server's owner decides this when starting it; an agent's confirm: true alone is not enough.
export const allowsDestructive = (env: NodeJS.ProcessEnv = process.env) => env[ALLOW_DESTRUCTIVE] === '1';

export function operation(id: string): Operation {
  const op = BY_ID.get(id);
  if (!op) throw new Refused('invalid', `unknown operation ${id}`, 'Search with droid_ops query, then pass an id it returns.');
  return op;
}

export function searchOperations(query: string): Operation[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return OPERATIONS.filter((o) => {
    const text = `${o.id} ${o.name} ${o.summary}`.toLowerCase();
    return words.every((w) => text.includes(w));
  });
}

export function countOperations() {
  const bySource: Record<string, number> = {};
  for (const o of OPERATIONS) bySource[o.source] = (bySource[o.source] ?? 0) + 1;
  return { total: OPERATIONS.length, bySource };
}

const AUTONOMY_KEYS = new Set(['autonomyLevel', 'subagentAutonomyLevel']);
// The deprecated autonomyMode, mapped to the level it grants. An unknown mode counts as above any cap.
const MODE_LEVEL = new Map<string, Autonomy>([
  ['normal', 'off'],
  ['spec', 'off'],
  ['auto-low', 'low'],
  ['auto-medium', 'medium'],
  ['auto-high', 'high'],
]);

// droid_start and droid_send refuse autonomy above the cap; this keeps droid_call from setting it through params,
// e.g. rest.updateSession with body.sessionSettings.autonomyLevel. Walks every level of params.
export function checkAutonomy(value: unknown, cap: Autonomy, path = 'params'): void {
  if (value === null || typeof value !== 'object') return;
  for (const [k, v] of Object.entries(value)) {
    const where = Array.isArray(value) ? `${path}[${k}]` : `${path}.${k}`;
    // A subagent that inherits gets its session's level, which can exceed a lower cap; at 'high' nothing can.
    const inherits = k === 'subagentAutonomyLevel' && v === 'inherit' && cap === 'high';
    const level = inherits ? undefined : AUTONOMY_KEYS.has(k) ? v : k === 'autonomyMode' && typeof v === 'string' ? (MODE_LEVEL.get(v) ?? v) : undefined;
    if (level !== undefined && level !== null && (typeof level !== 'string' || exceedsCap(level, cap))) {
      throw new Refused(
        'invalid',
        `${where} '${String(v)}' exceeds the autonomy cap '${cap}' (DROID_MCP_MAX_AUTONOMY)`,
        `Pass '${cap}' or lower, or leave it out.`,
      );
    }
    checkAutonomy(v, cap, where);
  }
}

// Shallow on purpose: required keys and unknown top-level keys. Daemon params carry only a signature description.
function checkParams(op: Operation, params: Record<string, unknown>) {
  if (op.params.type !== 'object') return;
  const fix = `Describe it with droid_ops id '${op.id}', then pass the params it lists.`;
  const missing = (op.params.required ?? []).filter((k) => !(k in params));
  if (missing.length > 0) throw new Refused('invalid', `${op.id} is missing params: ${missing.join(', ')}`, fix);
  const known = op.params.properties ?? {};
  const unknown = Object.keys(params).filter((k) => !(k in known));
  if (unknown.length > 0) throw new Refused('invalid', `${op.id} does not take params: ${unknown.join(', ')}`, fix);
}

function restRequest(op: Operation, params: Record<string, unknown>): [HttpMethod, string, RestRequest] {
  const [method, url] = op.name.split(' ');
  const inPath = new Set(Array.from(url.matchAll(/\{(\w+)\}/g), (m) => m[1]));
  const { body, ...rest } = params;
  const req: RestRequest = { path: {}, query: {}, body };
  for (const [k, v] of Object.entries(rest)) (inPath.has(k) ? req.path : req.query)[k] = v;
  return [method as HttpMethod, url, req];
}

// Operations a dedicated tool already covers with its own guards; droid_call would bypass them.
const COVERED = new Map([
  ['rest.answerSessionElicitation', 'droid_respond'],
  ['daemon.answer_elicitation', 'droid_respond'],
]);

export async function callOperation(ctx: OpsContext, a: CallArgs): Promise<unknown> {
  const op = operation(a.id);
  const tool = COVERED.get(op.id);
  if (tool) {
    throw new Refused('invalid', `${op.id} is covered by ${tool}, which applies the permission and autonomy limits`, `Use ${tool} instead.`);
  }
  if (op.secret) {
    throw new Refused(
      'invalid',
      `${op.id} returns a key or token, and droid-mcp never hands secrets to an agent`,
      'Ask the user to do this in the Factory app or CLI.',
    );
  }
  const cap = autonomyCap(ctx.env);
  if ((cap === 'off' || cap === 'low') && !op.readOnly) {
    throw new Refused(
      'invalid',
      `${op.id} is not read-only, and the autonomy cap is '${cap}' (DROID_MCP_MAX_AUTONOMY)`,
      `Call a read-only operation, or ask the user to raise DROID_MCP_MAX_AUTONOMY above '${cap}'.`,
    );
  }
  if (op.destructive && !allowsDestructive(ctx.env)) {
    throw new Refused(
      'invalid',
      `${op.id} is destructive, and this server does not allow destructive operations`,
      `Ask the user to do it in the Factory app, or to restart droid-mcp with ${ALLOW_DESTRUCTIVE}=1.`,
    );
  }
  if (op.destructive && a.confirm !== true) throw new Refused('invalid', `${op.id} is destructive`, 'Confirm with the user, then pass confirm: true.');
  checkAutonomy(a.params, cap);
  checkParams(op, a.params ?? {});
  if (op.source === 'rest') {
    if (a.computer !== undefined) {
      throw new Refused('invalid', 'computer applies only to daemon operations', 'Drop computer; pass computerId in params when the operation takes one.');
    }
    if (!ctx.rest) throw new Refused('needs_api_key', `${op.id} needs FACTORY_API_KEY`, API_KEY_FIX);
    return ctx.rest.call(...restRequest(op, a.params ?? {}));
  }
  if (a.computer !== undefined && !(await ctx.computers.resolve(a.computer)).thisMachine) {
    throw new Refused('invalid', `daemon operations run only on this machine, not on ${a.computer}`, 'Omit computer, or run droid-mcp on that computer.');
  }
  if (!ctx.daemon) throw new Refused('needs_api_key', `${op.id} needs FACTORY_API_KEY`, API_KEY_FIX);
  return ctx.daemon(op.name, a.params);
}

type DaemonClient = ReturnType<typeof createWebSocketDaemonClient>;
export type RelayDeps = {
  createClient?: (opts: Parameters<typeof createWebSocketDaemonClient>[0]) => DaemonClient;
  connect?: typeof connectAndAuthenticate;
  timeoutMs?: number;
};

function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new ToolError('computer_offline', `${what} did not answer within ${ms / 1000} s`, 'Check that the Droid daemon runs here, then retry.')),
      ms,
    );
  });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

// Reaches the daemon already running on this machine through Factory's relay, the same route the Factory app uses
// for a registered computer, so droid-mcp never hosts a daemon of its own. One connection per call.
export function relayDaemon(apiKey: string, rest: Pick<Rest, 'computer'>, computers: Pick<Computers, 'thisId'>, deps: RelayDeps = {}): DaemonCall {
  const createClient = deps.createClient ?? createWebSocketDaemonClient;
  const connect = deps.connect ?? connectAndAuthenticate;
  const timeoutMs = deps.timeoutMs ?? RELAY_TIMEOUT_MS;
  return async (method, params) => {
    const computerId = await computers.thisId();
    if (!computerId) {
      throw new ToolError(
        'invalid',
        'this machine has no Droid computer id (~/.factory/computer.json)',
        'Register this machine as a Droid computer, then retry.',
      );
    }
    const { providerType, relayClientUrl } = await rest.computer(computerId);
    if (!relayClientUrl) throw new ToolError('computer_offline', 'Factory reports no relay URL for this machine', 'Start the Droid daemon here, then retry.');
    const client = createClient({ machineType: MachineType.Computer, computerId, providerType, getCredential: async () => ({ apiKey }) });
    try {
      const authParams = { apiKey, caller: 'sdk' as const, metadata: { sdk: { language: 'typescript' as const, version: SDK_VERSION } } };
      await within(connect({ client, url: relayClientUrl, authParams }), timeoutMs, 'the Droid daemon relay');
      // Catalog daemon names are generated from public DaemonClient methods, and params is their first argument.
      const fn = (client as unknown as Record<string, unknown>)[method];
      if (typeof fn !== 'function') {
        throw new ToolError(
          'internal',
          `the installed @factory/droid-sdk has no DaemonClient.${method}`,
          'Run npm run codegen after upgrading @factory/droid-sdk.',
        );
      }
      return await within(Promise.resolve(fn.call(client, params)), timeoutMs, `DaemonClient.${method}`);
    } finally {
      client.disconnect();
    }
  };
}

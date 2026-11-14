import { readFileSync } from 'node:fs';
import { connectAndAuthenticate, createWebSocketDaemonClient, MachineType, SDK_VERSION } from '@factory/droid-sdk/node';
import type { Computers } from './computers.ts';
import { API_KEY_FIX, autonomyCap, Refused, ToolError } from './config.ts';
import type { HttpMethod, Rest, RestRequest } from './rest.ts';

type ParamSchema = { type?: string; properties?: Record<string, unknown>; required?: string[]; description?: string };
export type Operation = { id: string; source: 'daemon' | 'rest'; name: string; summary: string; params: ParamSchema; destructive: boolean };
export type DaemonCall = (method: string, params: Record<string, unknown> | undefined) => Promise<unknown>;
type OpsContext = { env?: NodeJS.ProcessEnv; rest?: Rest; computers: Computers; daemon?: DaemonCall };
type CallArgs = { id: string; params?: Record<string, unknown>; confirm?: boolean; computer?: string };

const OPERATIONS: Operation[] = JSON.parse(readFileSync(new URL('./generated/catalog.json', import.meta.url), 'utf8')).operations;
const BY_ID = new Map(OPERATIONS.map((o) => [o.id, o]));
// The lookahead keeps names such as listenFor or settings from counting as reads.
const READ_ONLY_DAEMON = /^(get|list|read|search|inspect|count)(?![a-z])/;

export function isReadOnly(op: Pick<Operation, 'source' | 'name'>): boolean {
  return op.source === 'rest' ? op.name.startsWith('GET ') : READ_ONLY_DAEMON.test(op.name);
}

export function operation(id: string): Operation {
  const op = BY_ID.get(id);
  if (!op) throw new Refused('invalid', `unknown operation ${id}`, 'Search with droid_ops query, then pass an id it returns.');
  return op;
}

export function describe(op: Operation) {
  return { ...op, readOnly: isReadOnly(op), callable: true };
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

export async function callOperation(ctx: OpsContext, a: CallArgs): Promise<unknown> {
  const op = operation(a.id);
  const cap = autonomyCap(ctx.env);
  if ((cap === 'off' || cap === 'low') && !isReadOnly(op)) {
    throw new Refused(
      'invalid',
      `${op.id} is not read-only, and the autonomy cap is '${cap}' (DROID_MCP_MAX_AUTONOMY)`,
      `Call a read-only operation, or ask the user to raise DROID_MCP_MAX_AUTONOMY above '${cap}'.`,
    );
  }
  if (op.destructive && a.confirm !== true) throw new Refused('invalid', `${op.id} is destructive`, 'Confirm with the user, then pass confirm: true.');
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

// Reaches the daemon already running on this machine through Factory's relay, the same route the Factory app uses
// for a registered computer, so droid-mcp never hosts a daemon of its own.
export function relayDaemon(apiKey: string, rest: Rest, computers: Computers): DaemonCall {
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
    const client = createWebSocketDaemonClient({ machineType: MachineType.Computer, computerId, providerType, getCredential: async () => ({ apiKey }) });
    try {
      await connectAndAuthenticate({
        client,
        url: relayClientUrl,
        authParams: { apiKey, caller: 'sdk', metadata: { sdk: { language: 'typescript', version: SDK_VERSION } } },
      });
      // Catalog daemon names are generated from public DaemonClient methods, and params is their first argument.
      const fn = (client as unknown as Record<string, (p?: Record<string, unknown>) => Promise<unknown>>)[method];
      return await fn.call(client, params);
    } finally {
      client.disconnect();
    }
  };
}

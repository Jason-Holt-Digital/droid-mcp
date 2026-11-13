import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isWatched, parseEventBody, type DroidEvent, type EventInput } from './events.ts';
import { registerTools, type Ctx } from './tools.ts';

export const EVENT_BODY_MAX = 16 * 1024;

export function newServer(ctx: Ctx): McpServer {
  const server = new McpServer({ name: 'droid-mcp', version: '0.1.0' });
  registerTools(server, ctx);
  return server;
}

function deny(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }));
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function bearer(token: string): (header: string | undefined) => boolean {
  const expected = Buffer.from(`Bearer ${token}`);
  return (header) => {
    const auth = Buffer.from(header ?? '');
    return auth.length === expected.length && timingSafeEqual(auth, expected);
  };
}

async function readBody(req: IncomingMessage, max: number): Promise<string | undefined> {
  if (Number(req.headers['content-length'] ?? 0) > max) return undefined;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > max) return undefined;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function recordEvent(ctx: Ctx, input: EventInput): Promise<DroidEvent> {
  let computer: string | undefined;
  if (input.computerId) {
    try {
      computer = (await ctx.computers.list()).find((c) => c.id === input.computerId)?.name;
    } catch {
      computer = undefined;
    }
  }
  if (input.computerId) ctx.sessionComputers?.set(input.sessionId, input.computerId);
  const event = ctx.events.add(input, {
    computer: computer ?? input.host ?? 'unknown',
    watched: isWatched(input.tags, ctx.runs.get(input.sessionId) !== undefined),
    forwarding: Boolean(ctx.forwarder?.enabled),
  });
  if (event.forwarded) void ctx.forwarder?.send(event);
  return event;
}

// The events token sits on every computer's hooks, so it may only append events, never reach the MCP tools.
async function handleEvent(ctx: Ctx, req: IncomingMessage, res: ServerResponse, authorized?: (h: string | undefined) => boolean) {
  if (!authorized) return json(res, 404, { error: 'events are not enabled (DROID_MCP_EVENTS_TOKEN is not set)' });
  if (!authorized(req.headers.authorization)) return json(res, 401, { error: 'unauthorized' });
  const text = await readBody(req, EVENT_BODY_MAX);
  if (text === undefined) return json(res, 413, { error: `event body exceeds ${EVENT_BODY_MAX} bytes` });
  let input: EventInput;
  try {
    input = parseEventBody(JSON.parse(text));
  } catch (err) {
    return json(res, 400, { error: err instanceof SyntaxError ? 'invalid JSON' : err instanceof Error ? err.message : 'invalid event' });
  }
  const event = await recordEvent(ctx, input);
  json(res, 202, { seq: event.seq, forwarded: event.forwarded });
}

export function createHandler(ctx: Ctx, opts: { token: string; eventsToken?: string }) {
  const mcpAuthorized = bearer(opts.token);
  const eventsAuthorized = opts.eventsToken ? bearer(opts.eventsToken) : undefined;
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.headers.origin !== undefined) return deny(res, 403, 'requests with an Origin header are not allowed');
    if (req.method === 'POST' && new URL(req.url ?? '/', 'http://localhost').pathname === '/events') {
      try {
        return await handleEvent(ctx, req, res, eventsAuthorized);
      } catch (err) {
        console.error('droid-mcp: event failed:', err instanceof Error ? err.message : err);
        if (!res.headersSent) return json(res, 500, { error: 'internal error' });
        return;
      }
    }
    if (!mcpAuthorized(req.headers.authorization)) return deny(res, 401, 'unauthorized');
    const server = newServer(ctx);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (err) {
      console.error('droid-mcp: request failed:', err instanceof Error ? err.message : err);
      if (!res.headersSent) deny(res, 500, 'internal error');
    }
  };
}

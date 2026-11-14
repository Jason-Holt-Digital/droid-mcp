import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { parseEventBody } from './events.ts';
import { Doorbell, parseRing, recordEvent } from './ring.ts';
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

async function readJson<T>(req: IncomingMessage, res: ServerResponse, parse: (json: unknown) => T): Promise<T | undefined> {
  const text = await readBody(req, EVENT_BODY_MAX);
  if (text === undefined) {
    json(res, 413, { error: `event body exceeds ${EVENT_BODY_MAX} bytes` });
    return undefined;
  }
  try {
    return parse(JSON.parse(text));
  } catch (err) {
    json(res, 400, { error: err instanceof SyntaxError ? 'invalid JSON' : err instanceof Error ? err.message : 'invalid event' });
    return undefined;
  }
}

// The events token sits on every computer's hooks, so it may only append events, never reach the MCP tools.
async function handleEvent(ctx: Ctx, req: IncomingMessage, res: ServerResponse, authorized?: (h: string | undefined) => boolean) {
  if (!authorized) return json(res, 404, { error: 'events are not enabled (DROID_MCP_EVENTS_TOKEN is not set)' });
  if (!authorized(req.headers.authorization)) return json(res, 401, { error: 'unauthorized' });
  const input = await readJson(req, res, parseEventBody);
  if (!input) return;
  const event = await recordEvent(ctx, input);
  json(res, 202, { seq: event.seq, forwarded: event.forwarded });
}

// A ring is only a claim: the doorbell verifies it after the reply, since the hook waits at most 3 s.
async function handleRing(bell: Doorbell, req: IncomingMessage, res: ServerResponse) {
  if (!bell.allow(req.socket.remoteAddress ?? '')) return json(res, 429, { error: 'too many rings' });
  const ring = await readJson(req, res, parseRing);
  if (!ring) return;
  json(res, 202, { accepted: true });
  bell.ring(ring);
}

export function createHandler(ctx: Ctx, opts: { token: string; eventsToken?: string; doorbell?: Doorbell }) {
  const mcpAuthorized = bearer(opts.token);
  const eventsAuthorized = opts.eventsToken ? bearer(opts.eventsToken) : undefined;
  const bell = opts.doorbell ?? new Doorbell(ctx);
  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.headers.origin !== undefined) return deny(res, 403, 'requests with an Origin header are not allowed');
    if (!URL.canParse(req.url ?? '/', 'http://localhost')) return json(res, 400, { error: 'bad request' });
    if (req.method === 'POST' && new URL(req.url ?? '/', 'http://localhost').pathname === '/events') {
      if (req.headers.authorization === undefined) return handleRing(bell, req, res);
      return handleEvent(ctx, req, res, eventsAuthorized);
    }
    if (!mcpAuthorized(req.headers.authorization)) return deny(res, 401, 'unauthorized');
    const server = newServer(ctx);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  };
  // The http server does not await this listener, so a rejection would be unhandled and end the process.
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      await handle(req, res);
    } catch (err) {
      console.error('droid-mcp: request failed:', err instanceof Error ? err.message : err);
      if (!res.headersSent) deny(res, 500, 'internal error');
    }
  };
}

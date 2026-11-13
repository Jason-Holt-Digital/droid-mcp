#!/usr/bin/env node
import { timingSafeEqual } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { repoRoot } from './catalog.ts';
import { allowedRoots, autonomyCap, lookupApiKey } from './config.ts';
import { createRest } from './rest.ts';
import { KeyStore, Runs } from './runs.ts';
import { registerTools, type Ctx } from './tools.ts';

function newServer(ctx: Ctx): McpServer {
  const server = new McpServer({ name: 'droid-mcp', version: '0.1.0' });
  registerTools(server, ctx);
  return server;
}

function deny(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }));
}

function serveHttp(ctx: Ctx, spec: string | undefined): void {
  const match = /^(.+):(\d+)$/.exec(spec ?? '');
  const token = process.env.DROID_MCP_TOKEN;
  // Sessions inherit this process's environment; agents in them must not be able to read the bearer token.
  delete process.env.DROID_MCP_TOKEN;
  if (!match) throw new Error('usage: --http <host:port>');
  if (!token) throw new Error('--http requires DROID_MCP_TOKEN');
  const expected = Buffer.from(`Bearer ${token}`);
  const http = createServer(async (req, res) => {
    if (req.headers.origin !== undefined) return deny(res, 403, 'requests with an Origin header are not allowed');
    const auth = Buffer.from(req.headers.authorization ?? '');
    if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) return deny(res, 401, 'unauthorized');
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
  });
  const host = match[1].replace(/^\[(.*)\]$/, '$1');
  http.listen(Number(match[2]), host, () => console.error(`droid-mcp listening on http://${spec}`));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const apiKey = await lookupApiKey();
  const ctx: Ctx = {
    sessionsRoot: join(homedir(), '.factory', 'sessions'),
    roots: allowedRoots(),
    runs: new Runs({ apiKey, repoOf: repoRoot, cap: autonomyCap() }),
    keys: new KeyStore(join(homedir(), '.droid-mcp', 'state.json')),
    rest: apiKey ? createRest({ apiKey }) : undefined,
  };

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    await ctx.runs.closeAll();
    await ctx.keys.flush();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  const http = args.indexOf('--http');
  if (http >= 0) {
    serveHttp(ctx, args[http + 1]);
  } else {
    process.stdin.on('end', shutdown);
    await newServer(ctx).connect(new StdioServerTransport());
  }
}

main().catch((err) => {
  console.error('droid-mcp:', err instanceof Error ? err.message : err);
  process.exit(1);
});

#!/usr/bin/env node
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { repoRoot } from './catalog.ts';
import { Computers } from './computers.ts';
import { allowedRoots, autonomyCap, lookupApiKey, lookupSecret } from './config.ts';
import { EventLog, Forwarder } from './events.ts';
import { createHandler, newServer } from './http.ts';
import { createRest } from './rest.ts';
import { KeyStore, Runs } from './runs.ts';
import { Subscriptions } from './subscriptions.ts';
import type { Ctx } from './tools.ts';

function serveHttp(ctx: Ctx, spec: string | undefined, eventsToken: string | undefined): void {
  const match = /^(.+):(\d+)$/.exec(spec ?? '');
  const token = process.env.DROID_MCP_TOKEN;
  // Sessions inherit this process's environment; agents in them must not be able to read the bearer token.
  delete process.env.DROID_MCP_TOKEN;
  if (!match) throw new Error('usage: --http <host:port>');
  if (!token) throw new Error('--http requires DROID_MCP_TOKEN');
  const http = createServer(createHandler(ctx, { token, eventsToken }));
  const host = match[1].replace(/^\[(.*)\]$/, '$1');
  http.listen(Number(match[2]), host, () => console.error(`droid-mcp listening on http://${spec}`));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const [apiKey, eventsToken, webhookUrl, webhookKey] = await Promise.all([
    lookupApiKey(),
    lookupSecret('DROID_MCP_EVENTS_TOKEN', 'EVENTS_TOKEN'),
    lookupSecret('DROID_MCP_WEBHOOK_URL', 'WEBHOOK_URL'),
    lookupSecret('DROID_MCP_WEBHOOK_KEY', 'WEBHOOK_KEY'),
  ]);
  // Same reason as DROID_MCP_TOKEN: agents in spawned sessions must not read these.
  delete process.env.DROID_MCP_EVENTS_TOKEN;
  delete process.env.DROID_MCP_WEBHOOK_KEY;
  const rest = apiKey ? createRest({ apiKey }) : undefined;
  const ctx: Ctx = {
    sessionsRoot: join(homedir(), '.factory', 'sessions'),
    roots: allowedRoots(),
    runs: new Runs({ apiKey, repoOf: repoRoot, cap: autonomyCap() }),
    keys: new KeyStore(join(homedir(), '.droid-mcp', 'state.json')),
    subscriptions: new Subscriptions(join(homedir(), '.droid-mcp', 'subscriptions.json')),
    rest,
    computers: new Computers({ rest, file: join(homedir(), '.factory', 'computer.json') }),
    events: new EventLog(),
    sessionComputers: new Map(),
    forwarder: new Forwarder({ url: webhookUrl, key: webhookKey }),
  };

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    await ctx.runs.closeAll();
    await Promise.all([ctx.keys.flush(), ctx.subscriptions.flush()]);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  const http = args.indexOf('--http');
  if (http >= 0) {
    serveHttp(ctx, args[http + 1], eventsToken);
  } else {
    process.stdin.on('end', shutdown);
    await newServer(ctx).connect(new StdioServerTransport());
  }
}

main().catch((err) => {
  console.error('droid-mcp:', err instanceof Error ? err.message : err);
  process.exit(1);
});

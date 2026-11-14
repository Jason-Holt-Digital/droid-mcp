import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Computers } from '../src/computers.ts';
import { EventLog } from '../src/events.ts';
import { KeyStore, type Runs } from '../src/runs.ts';
import { Subscriptions } from '../src/subscriptions.ts';
import { registerTools } from '../src/tools.ts';
import { catalog, FIXTURES } from './helpers.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');
const DOCS = [
  'README.md',
  ...readdirSync(join(ROOT, 'docs'))
    .filter((f) => f.endsWith('.md'))
    .map((f) => `docs/${f}`),
  'skills/droid-mcp/SKILL.md',
];

async function registeredTools(): Promise<string[]> {
  const dir = await mkdtemp(join(tmpdir(), 'droid-mcp-docs-'));
  const server = new McpServer({ name: 'droid-mcp', version: 'test' });
  registerTools(server, {
    sessionsRoot: FIXTURES,
    roots: [dir],
    runs: { get: () => undefined } as unknown as Runs,
    keys: new KeyStore(join(dir, 'state.json')),
    subscriptions: new Subscriptions(join(dir, 'subscriptions.json')),
    env: {},
    catalog: async () => catalog(),
    computers: new Computers({ file: join(dir, 'no-computer.json'), hostname: 'test-host' }),
    events: new EventLog(),
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  try {
    await Promise.all([server.connect(a), client.connect(b)]);
    return (await client.listTools()).tools.map((t) => t.name).sort();
  } finally {
    await client.close();
    await rm(dir, { recursive: true, force: true });
  }
}

// Code is skipped so that brackets in examples are not read as links.
function links(markdown: string): string[] {
  const prose = markdown.replace(/^```[\s\S]*?^```/gm, '').replace(/`[^`\n]*`/g, '');
  return [...prose.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)].map((m) => m[1]);
}

test('README.md has at most 500 words, code blocks included', () => {
  const words = read('README.md').split(/\s+/).filter(Boolean).length;
  assert.ok(words <= 500, `README.md has ${words} words`);
});

test('every relative link and image in the docs resolves to a file', () => {
  assert.ok(DOCS.length >= 7, DOCS.join(', '));
  for (const doc of DOCS) {
    for (const target of links(read(doc))) {
      if (/^[a-z]+:/i.test(target) || target.startsWith('#')) continue;
      const path = join(ROOT, dirname(doc), decodeURIComponent(target.split('#')[0]));
      assert.ok(existsSync(path), `${doc} links to ${target}, which does not exist`);
    }
  }
});

test('docs/tools.md and SKILL.md name exactly the registered tools', async () => {
  const tools = await registeredTools();
  assert.equal(tools.length, 16);
  for (const doc of ['docs/tools.md', 'skills/droid-mcp/SKILL.md']) {
    const named = [...new Set(read(doc).match(/droid_[a-z_]+/g))].sort();
    assert.deepEqual(named, tools, doc);
  }
});

// Live end-to-end check over a real stdio MCP client. Runs three tiny turns in a scratch dir.
// Usage: node scripts/smoke.ts [scratchDir] [oldScratchSessionIdToResume]
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { lookupApiKey } from '../src/config.ts';

const scratch = process.argv[2] ?? join(homedir(), 'repos', 'droid-mcp-scratch');
const resumeId = process.argv[3];
mkdirSync(scratch, { recursive: true });
// The refusal checks below would really post to a workstream if a key were found, so require that none is.
assert.ok(!(await lookupApiKey({})), 'no FACTORY_API_KEY in the Keychain');
const env = {
  ...(Object.fromEntries(Object.entries(process.env).filter(([k, v]) => v !== undefined && k !== 'FACTORY_API_KEY')) as Record<string, string>),
  DROID_MCP_MAX_AUTONOMY: 'medium',
};
const client = new Client({ name: 'droid-mcp-smoke', version: '0' });
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [new URL('../src/main.ts', import.meta.url).pathname],
    env,
    stderr: 'inherit',
  }),
);

async function call(name: string, args: Record<string, unknown>, expectError = false): Promise<any> {
  const t = Date.now();
  const r: any = await client.callTool({ name, arguments: args }, undefined, { timeout: 60_000 });
  const text = r.content[0].text as string;
  assert.ok(Buffer.byteLength(text) <= 65_536 + 1024, `${name} result is bounded`);
  console.log(
    `${name} ${JSON.stringify(args).slice(0, 120)} -> ${r.isError ? 'ERROR ' : ''}${text.slice(0, 220)} (${Date.now() - t} ms, ${Buffer.byteLength(text)} B)`,
  );
  assert.equal(Boolean(r.isError), expectError, `${name} isError=${expectError}`);
  return r.isError ? text : JSON.parse(text);
}

async function settle(session: string, afterSeq: number): Promise<{ seq: number; events: any[]; state: string; attention: any[] }> {
  const events: any[] = [];
  for (let i = 0; i < 12; i++) {
    const w = await call('droid_wait', { session, afterSeq, waitMs: 45_000 });
    events.push(...w.events);
    afterSeq = w.nextSeq;
    if (w.attention?.length) return { seq: afterSeq, events, state: w.state, attention: w.attention };
    if (w.state === 'idle' && events.some((e) => e.kind === 'result')) return { seq: afterSeq, events, state: w.state, attention: [] };
  }
  throw new Error('session did not settle');
}

try {
  const tools = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(tools, [
    'droid_cancel',
    'droid_computers',
    'droid_events',
    'droid_find',
    'droid_models',
    'droid_respond',
    'droid_result',
    'droid_send',
    'droid_start',
    'droid_wait',
  ]);

  const ws = await call('droid_find', { scope: 'workstreams', limit: 200 });
  assert.ok(ws.workstreams.length > 0, 'workstreams found');
  const firstMissing = ws.workstreams.findIndex((w: any) => w.missingOrchestrator);
  assert.ok(
    firstMissing === -1 || ws.workstreams.slice(firstMissing).every((w: any) => w.missingOrchestrator),
    'local orchestrators come first',
  );
  for (const w of ws.workstreams) for (const a of w.agents) assert.equal(a.role, 'agent');
  const orch = ws.workstreams.find((w: any) => w.orchestrator)!.orchestrator;
  console.log(
    'workstreams:',
    ws.workstreams
      .map((w: any) => `${w.title ?? w.id} (${w.agents.length} agents${w.missingOrchestrator ? ', orchestrator elsewhere' : ''})`)
      .join('; '),
  );

  const all = await call('droid_find', {});
  assert.ok(all.sessions.length > 0 && all.total > 0);
  const byTitle = await call('droid_find', { query: orch.title.slice(0, 12), scope: 'workstreams' });
  assert.ok(
    byTitle.workstreams.some((w: any) => w.id === orch.id),
    'title query finds the workstream',
  );
  const content = await call('droid_find', { query: 'droid_find', content: true, includeSubagents: true });
  assert.ok(content.total >= 1, 'content search finds this build session');

  const followed = await call('droid_wait', { session: orch.id, maxEvents: 3 });
  assert.ok(followed.events.length > 0, 'reads a desktop-held orchestrator read-only');
  await call('droid_result', { session: orch.id, maxBytes: 300 });
  assert.match(
    await call('droid_send', { session: orch.id, prompt: 'x', idempotencyKey: randomUUID() }, true),
    /workstream sessions need FACTORY_API_KEY/,
  );
  assert.match(await call('droid_cancel', { session: orch.id, scope: 'turn' }, true), /FACTORY_API_KEY/);
  assert.match(await call('droid_send', { session: randomUUID(), prompt: 'x', idempotencyKey: randomUUID() }, true), /not on this machine/);
  assert.match(await call('droid_start', { cwd: homedir(), prompt: 'x', idempotencyKey: randomUUID() }, true), /outside the allowed roots/);
  assert.match(
    await call('droid_start', { cwd: scratch, prompt: 'x', autonomy: 'high', idempotencyKey: randomUUID() }, true),
    /exceeds the cap/,
  );

  const key = randomUUID();
  const file = join(scratch, `smoke-${key.slice(0, 8)}.txt`);
  const started = await call('droid_start', {
    cwd: scratch,
    prompt: `Create the file ${file} containing the text OK using the Create tool, then reply with exactly: DONE`,
    autonomy: 'off',
    idempotencyKey: key,
  });
  const again = await call('droid_start', { cwd: scratch, prompt: 'ignored', idempotencyKey: key });
  assert.equal(again.sessionId, started.sessionId, 'same idempotencyKey returns the same session');
  const sid = started.sessionId;
  let s = await settle(sid, 0);
  assert.ok(s.attention.length === 1 && s.attention[0].kind === 'permission', 'permission prompt is parked');
  assert.match(
    await call('droid_respond', { session: sid, requestId: s.attention[0].requestId, decision: 'not-an-option' }, true),
    /decision must be one of/,
  );
  await call('droid_respond', { session: sid, requestId: s.attention[0].requestId, decision: 'proceed_once' });
  s = await settle(sid, s.seq);
  assert.equal(readFileSync(file, 'utf8').trim(), 'OK', 'approved tool ran');
  assert.equal((await call('droid_result', { session: sid })).content.trim(), 'DONE');

  const sendKey = randomUUID();
  const sent = await call('droid_send', { session: sid, prompt: 'Reply with exactly: OK2', idempotencyKey: sendKey });
  assert.equal(sent.via, 'own');
  const resent = await call('droid_send', { session: sid, prompt: 'Reply with exactly: OK2', idempotencyKey: sendKey });
  assert.deepEqual(resent, sent, 'retried send is not sent twice');
  s = await settle(sid, sent.nextSeq);
  assert.equal((await call('droid_result', { session: sid })).content.trim(), 'OK2');
  const diff = await call('droid_result', { session: sid, include: ['diff'] });
  assert.equal(typeof diff.content, 'string');
  const found = await call('droid_find', { query: sid.slice(0, 8) });
  assert.equal(found.sessions[0]?.sessions[0]?.run, 'idle', 'find shows our run state');
  await call('droid_cancel', { session: sid, scope: 'session' });

  if (resumeId) {
    assert.match(await call('droid_send', { session: resumeId, prompt: 'x', idempotencyKey: randomUUID() }, true), /allowLocalResume/);
    const resumed = await call('droid_send', {
      session: resumeId,
      prompt: 'Reply with exactly: RESUMED',
      idempotencyKey: randomUUID(),
      allowLocalResume: true,
    });
    assert.equal(resumed.via, 'local-resume');
    await settle(resumeId, resumed.nextSeq);
    assert.equal((await call('droid_result', { session: resumeId })).content.trim(), 'RESUMED');
    await call('droid_cancel', { session: resumeId, scope: 'session' });
  }

  console.log('SMOKE OK');
} finally {
  await client.close();
}

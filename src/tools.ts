import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AnswerSessionElicitationRequestBody } from '@factory/droid-sdk/api';
import { z } from 'zod';
import {
  filterRecords,
  findSession,
  groupCatalog,
  isSessionId,
  isSubagent,
  readTranscript,
  readTranscriptTail,
  repoRoot,
  scanSessions,
  searchContent,
  type SessionRecord,
  type TranscriptEntry,
  type Workstream,
} from './catalog.ts';
import { allowedDecisions, autonomyCap, checkCwd, Refused, resolveAutonomy, type Autonomy } from './config.ts';
import { loadCatalog, type ModelCatalog } from './models.ts';
import type { Rest } from './rest.ts';
import { routeSend, type Target } from './route.ts';
import { preview, type KeyStore, type RunEvent, type Runs } from './runs.ts';
import { EFFORTS, startOnly, toRestSettings, validateSettings } from './settings.ts';

export type Ctx = {
  sessionsRoot: string;
  roots: string[];
  runs: Runs;
  keys: KeyStore;
  rest?: Rest;
  env?: NodeJS.ProcessEnv;
  catalog?: () => Promise<ModelCatalog>;
};

export const LIMIT_BYTES = 8192;
export const DEFAULT_WAIT_MS = 25_000;
export const MAX_WAIT_MS = 50_000;
const EVENT_TEXT_MAX = 4000;
// Leaves room for JSON escaping so a default page stays near the 8 KB result budget.
const DEFAULT_RESULT_BYTES = 6000;

export function clampWait(waitMs?: number): number {
  if (waitMs === undefined || Number.isNaN(waitMs)) return DEFAULT_WAIT_MS;
  return Math.max(0, Math.min(MAX_WAIT_MS, waitMs));
}

export function pageBytes(text: string, offset = 0, maxBytes = LIMIT_BYTES) {
  const buf = Buffer.from(text, 'utf8');
  const continuation = (i: number) => i < buf.length && (buf[i] & 0xc0) === 0x80;
  let start = Math.max(0, Math.min(offset, buf.length));
  while (continuation(start)) start++;
  let end = Math.min(buf.length, start + Math.max(1, maxBytes));
  while (end > start && continuation(end)) end--;
  if (end === start && start < buf.length) {
    end = start + 1;
    while (continuation(end)) end++;
  }
  return {
    text: buf.subarray(start, end).toString('utf8'),
    offset: start,
    nextOffset: end < buf.length ? end : undefined,
    totalBytes: buf.length,
  };
}

function size(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

function fit<T>(items: T[], build: (items: T[]) => unknown, limit = LIMIT_BYTES): unknown {
  let n = items.length;
  let value = build(items);
  while (n > 1 && size(value) > limit) {
    n = n > 8 ? Math.floor(n * 0.8) : n - 1;
    value = build(items.slice(0, n));
  }
  return value;
}

function reply(value: unknown) {
  let text = JSON.stringify(value);
  if (Buffer.byteLength(text) > 4 * 65_536) {
    text = JSON.stringify({ truncated: true, preview: text.slice(0, LIMIT_BYTES / 2) });
  }
  return { content: [{ type: 'text' as const, text }] };
}

function failure(err: unknown) {
  const msg = preview((err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').trim(), 1000);
  return { isError: true, content: [{ type: 'text' as const, text: msg }] };
}

function handle<A>(fn: (args: A) => Promise<unknown>) {
  return async (args: A) => {
    try {
      return reply(await fn(args));
    } catch (err) {
      return failure(err);
    }
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const iso = (ms: number) => new Date(ms).toISOString();

function clip(text: string): { text: string; truncated?: true } {
  return text.length > EVENT_TEXT_MAX ? { text: preview(text, EVENT_TEXT_MAX), truncated: true } : { text };
}

const HIDDEN_TAGS = new Set(['mission-v2', 'subagent', 'mission-v2-subagent']);

const AUTONOMY = z.enum(['off', 'low', 'medium', 'high']);
const effort = z.enum(EFFORTS).optional();
const toolIds = z.array(z.string()).optional();
const runSettings = {
  model: z.string().optional().describe('Model id from droid_models'),
  reasoningEffort: effort.describe('Must be one the model supports'),
  specModel: z.string().optional().describe('Model for spec mode (defaults to model)'),
  specReasoningEffort: effort,
  useSpec: z.boolean().optional().describe('Switch to spec mode: plan before editing'),
  mission: z.boolean().optional().describe('Switch to mission mode (multi-agent); needs autonomy "high"'),
  workerModel: z.string().optional().describe('Mission worker model (needs mission)'),
  workerReasoningEffort: effort,
  validatorModel: z.string().optional().describe('Mission validator model (needs mission)'),
  validatorReasoningEffort: effort,
  tags: z.array(z.string()).optional().describe('Tag names to add to the session'),
  worktree: z
    .union([z.boolean(), z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9._/-]*$/)])
    .optional()
    .describe('Start in a git worktree; a string names the branch (start only)'),
  onlyTools: toolIds.describe('Use only these tool ids or MCP:<server>[/<tool>] selectors'),
  addTools: toolIds.describe('Add these tool ids or selectors'),
  removeTools: toolIds.describe('Remove these tool ids or selectors'),
  appendSystemPrompt: z.string().optional().describe('Text appended to the system prompt (start only)'),
  fork: z.string().optional().describe('Fork this session id instead of starting fresh (start only)'),
};
const MODEL_HELP =
  "Pick a model with droid_models: a built-in id (claude-opus-5-5), a BYOK custom id from ~/.factory/settings.json (custom:<provider>:<model>), a tier alias (anthropic-latest-premium) or a version wildcard (claude-opus-*). reasoningEffort must be one the model supports. mission needs autonomy 'high'. Unknown models and invalid combinations are refused before anything runs.";
const USAGE =
  'Pass any id as model/specModel/workerModel/validatorModel to droid_start or droid_send; custom ids are BYOK models from ~/.factory/settings.json customModels';

const nonEmpty = (list: string[]) => (list.length ? list : undefined);

function entry(r: SessionRecord, runs: Runs) {
  return {
    id: r.id,
    title: r.title,
    cwd: r.cwd,
    updated: iso(r.updatedAt),
    role: r.workstream?.role ?? (isSubagent(r) ? 'subagent' : undefined),
    parentId: r.parentId,
    archived: r.archived || undefined,
    tags: r.tags.filter((t) => !HIDDEN_TAGS.has(t)),
    run: runs.get(r.id)?.state,
  };
}

// A closed run is still followed through its own event log, but a new send treats it as a local session again.
async function resolveTarget(ctx: Ctx, id: string, opts: { sending?: boolean } = {}): Promise<Target> {
  const run = ctx.runs.get(id);
  if (run && !(opts.sending && run.state === 'closed')) return { kind: 'own', run };
  if (!isSessionId(id)) throw new Refused(`invalid session id: ${id}`);
  const record = await findSession(ctx.sessionsRoot, id);
  return record ? { kind: 'local', record } : { kind: 'unknown', id };
}

function viaRest(ctx: Ctx, target: Target): Rest | undefined {
  if (!ctx.rest) return undefined;
  if (target.kind === 'unknown' || (target.kind === 'local' && target.record.workstream)) return ctx.rest;
  return undefined;
}

function needRest(ctx: Ctx, what: string): Rest {
  if (!ctx.rest) throw new Error(`${what} for sessions this server did not start needs FACTORY_API_KEY`);
  return ctx.rest;
}

function gitDiff(cwd: string): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile('git', ['-C', cwd, 'diff', 'HEAD'], { maxBuffer: 64 * 1024 * 1024, timeout: 20_000 }, (err, stdout, stderr) =>
      err ? reject(new Error(`git diff failed in ${cwd}: ${stderr.split('\n')[0] || err.message}`)) : resolve(stdout),
    ),
  );
}

function lastAssistantText(entries: TranscriptEntry[]): string {
  const lastUser = entries.findLastIndex((e) => e.role === 'user');
  const after = entries.slice(lastUser + 1).filter((e) => e.role === 'assistant');
  if (after.length) return after.map((e) => e.text).join('\n\n');
  return entries.findLast((e) => e.role === 'assistant')?.text ?? '';
}

async function resultText(ctx: Ctx, target: Target): Promise<string> {
  if (target.kind === 'own') {
    return target.run.lastResult ?? target.run.events.findLast((e) => e.kind === 'assistant')?.text ?? '';
  }
  if (target.kind === 'local') {
    return lastAssistantText(await readTranscriptTail(target.record.file, (e) => e.some((x) => x.role === 'user')));
  }
  const { messages } = await needRest(ctx, 'reading results').messages(target.id, { role: 'assistant', limit: 100 });
  return messages.sort((a, b) => a.createdAt - b.createdAt).at(-1)?.text ?? '';
}

function summarizeChildren(children: Awaited<ReturnType<Rest['children']>>, local: Set<string>) {
  const statuses: Record<string, number> = {};
  for (const c of children) statuses[c.status] = (statuses[c.status] ?? 0) + 1;
  return {
    statuses,
    attention: children.filter((c) => c.attention).map((c) => ({ id: c.sessionId, title: c.title, kind: c.attention!.kind })),
    elsewhereTotal: children.filter((c) => !local.has(c.sessionId)).length,
    elsewhere: children
      .filter((c) => !local.has(c.sessionId))
      .slice(0, 10)
      .map((c) => ({ id: c.sessionId, title: c.title, status: c.status, computer: c.computer })),
  };
}

export function registerTools(server: McpServer, ctx: Ctx): void {
  const { runs } = ctx;
  const catalog = ctx.catalog ?? (() => loadCatalog());

  server.registerTool(
    'droid_find',
    {
      description:
        "Find the user's Factory Droid sessions on this machine, grouped into workstreams (orchestrator + agents) and standalone sessions by repo. Paged with cursor.",
      inputSchema: {
        query: z.string().optional().describe('Match title, id prefix or cwd; with content=true, search transcripts instead'),
        content: z.boolean().optional(),
        scope: z.enum(['workstreams', 'sessions', 'all']).optional(),
        cwd: z.string().optional(),
        includeArchived: z.boolean().optional(),
        includeSubagents: z.boolean().optional(),
        limit: z.number().int().min(1).max(200).optional(),
        cursor: z.string().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    handle(async (a) => {
      let records = await scanSessions(ctx.sessionsRoot);
      let query = a.query;
      if (a.content && a.query) {
        const ids = new Set(await searchContent(ctx.sessionsRoot, a.query));
        records = records.filter((r) => ids.has(r.id));
        query = undefined;
      }
      const filtered = filterRecords(records, {
        query,
        cwd: a.cwd,
        includeArchived: a.includeArchived,
        includeSubagents: a.includeSubagents,
      });
      const catalog = groupCatalog(filtered, { repoOf: repoRoot });
      const scope = a.scope ?? 'all';
      type Item = { ws?: Workstream; repo?: string; r: SessionRecord };
      const items: Item[] = [];
      if (scope !== 'sessions') {
        for (const w of catalog.workstreams) {
          for (const r of w.orchestrator ? [w.orchestrator, ...w.agents] : w.agents) items.push({ ws: w, r });
        }
      }
      if (scope !== 'workstreams') {
        for (const g of catalog.standalone) for (const r of g.sessions) items.push({ repo: g.repo, r });
      }
      const start = a.cursor === undefined ? 0 : Number.parseInt(a.cursor, 10);
      if (!Number.isInteger(start) || start < 0) throw new Error(`invalid cursor: ${a.cursor}`);
      const page = items.slice(start, start + (a.limit ?? 40));
      const orchestrators = new Map(records.filter((r) => r.workstream?.role === 'orchestrator').map((r) => [r.id, r]));

      const children = new Map<string, unknown>();
      if (ctx.rest) {
        const rest = ctx.rest;
        const local = new Set(records.map((r) => r.id));
        const ids = [...new Set(page.filter((i) => i.ws).map((i) => i.ws!.id))];
        await Promise.all(
          ids.map(async (id) => {
            try {
              children.set(id, summarizeChildren(await rest.children(id), local));
            } catch (err) {
              children.set(id, { error: err instanceof Error ? err.message : String(err) });
            }
          }),
        );
      }

      const build = (slice: Item[]) => {
        const workstreams: Array<Record<string, unknown> & { id: string; agents: unknown[] }> = [];
        const sessions: Array<{ repo: string; sessions: unknown[] }> = [];
        for (const it of slice) {
          const e = entry(it.r, runs);
          if (it.ws) {
            let w = workstreams.at(-1);
            if (w?.id !== it.ws.id) {
              w = {
                id: it.ws.id,
                title: it.ws.title ?? orchestrators.get(it.ws.id)?.title,
                missingOrchestrator: orchestrators.has(it.ws.id) ? undefined : true,
                agents: [],
                children: children.get(it.ws.id),
              };
              workstreams.push(w);
            }
            if (it.r.workstream?.role === 'orchestrator') w.orchestrator = e;
            else w.agents.push(e);
          } else {
            let g = sessions.at(-1);
            if (!g || g.repo !== it.repo) {
              g = { repo: it.repo!, sessions: [] };
              sessions.push(g);
            }
            g.sessions.push(e);
          }
        }
        const next = start + slice.length;
        return { workstreams, sessions, total: items.length, nextCursor: next < items.length ? String(next) : undefined };
      };
      return fit(page, build);
    }),
  );

  server.registerTool(
    'droid_models',
    {
      description:
        'List the models droid can run: built-in ids with their reasoning efforts, BYOK custom models from settings, tier aliases and version wildcards. filter matches id, name or provider.',
      inputSchema: {
        filter: z.string().optional(),
        include: z.array(z.enum(['builtin', 'custom', 'aliases'])).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    handle(async (a) => {
      const c = await catalog();
      const include = new Set(a.include?.length ? a.include : ['builtin', 'custom', 'aliases']);
      const q = a.filter?.toLowerCase();
      const hit = (...fields: Array<string | undefined>) => !q || fields.some((f) => f?.toLowerCase().includes(q));
      return {
        defaultModel: c.defaultModel,
        builtin: include.has('builtin') ? c.builtin.filter((b) => hit(b.id, b.name)) : undefined,
        custom: include.has('custom') ? c.custom.filter((m) => hit(m.id, m.displayName, m.provider)) : undefined,
        aliases: include.has('aliases') ? c.aliases.filter((x) => hit(x)) : undefined,
        wildcards: include.has('aliases') ? c.wildcards.filter((x) => hit(x)) : undefined,
        usage: USAGE,
      };
    }),
  );

  server.registerTool(
    'droid_start',
    {
      description: `Start a new Droid session in cwd (must be inside the allowed roots) and send it the first prompt. Retrying with the same idempotencyKey returns the same session. ${MODEL_HELP}`,
      inputSchema: {
        cwd: z.string(),
        prompt: z.string().min(1),
        autonomy: AUTONOMY.optional(),
        idempotencyKey: z.string().min(1).max(200),
        ...runSettings,
      },
    },
    handle(async (a) => {
      const { sessionId } = await ctx.keys.once(`start:${a.idempotencyKey}`, async () => {
        const cwd = checkCwd(a.cwd, ctx.roots);
        const autonomy = resolveAutonomy(a.autonomy, ctx.env);
        if (a.fork !== undefined) {
          if (!isSessionId(a.fork)) throw new Refused(`invalid session id: ${a.fork}`);
          if (a.appendSystemPrompt !== undefined) throw new Refused('appendSystemPrompt cannot be combined with fork');
          const live = runs.get(a.fork);
          if (live && live.state !== 'closed') throw new Refused('fork source is open in this server; close it first');
          if (!(await findSession(ctx.sessionsRoot, a.fork))) throw new Refused(`fork source ${a.fork} is not on this machine`);
        }
        validateSettings(a, autonomy, await catalog());
        const run = await runs.start({ cwd, prompt: a.prompt, autonomy, settings: a });
        return { sessionId: run.id };
      });
      return { sessionId, state: runs.get(sessionId)?.state ?? 'unknown' };
    }),
  );

  server.registerTool(
    'droid_send',
    {
      description: `Send a message into a session as the user. Sessions this server started take it directly; others need FACTORY_API_KEY (REST) or, for idle standalone local sessions only, allowLocalResume. mode 'interrupt' stops the running turn first. Settings and autonomy change the session before this prompt; settings a route cannot apply come back in \`ignored\`. ${MODEL_HELP}`,
      inputSchema: {
        session: z.string(),
        prompt: z.string().min(1),
        idempotencyKey: z.string().min(1).max(200),
        mode: z.enum(['queue', 'interrupt']).optional(),
        allowLocalResume: z.boolean().optional(),
        autonomy: AUTONOMY.optional(),
        ...runSettings,
      },
    },
    handle(async (a) => {
      const mode = a.mode ?? 'queue';
      return ctx.keys.once(`send:${a.session}:${a.idempotencyKey}`, async () => {
        const target = await resolveTarget(ctx, a.session, { sending: true });
        const route = routeSend(target, {
          restEnabled: Boolean(ctx.rest),
          allowLocalResume: a.allowLocalResume ?? false,
          now: Date.now(),
          cap: autonomyCap(ctx.env),
        });
        if ('refused' in route) throw new Refused(`refused: ${route.refused}`);
        const autonomy: Autonomy | undefined = a.autonomy && resolveAutonomy(a.autonomy, ctx.env);
        const current =
          target.kind === 'own' ? target.run.session.settings.autonomyLevel : target.kind === 'local' ? target.record.autonomy : undefined;
        validateSettings(a, autonomy ?? (route.via === 'rest' ? undefined : current), await catalog());
        const change = { settings: a, autonomy };
        if (route.via === 'own' && target.kind === 'own') {
          const seq = await runs.send(target.run, a.prompt, mode, change);
          return { via: 'own', sessionId: target.run.id, status: target.run.state, nextSeq: seq, ignored: nonEmpty(startOnly(a)) };
        }
        if (route.via === 'local-resume' && target.kind === 'local') {
          const run = await runs.resume(target.record, checkCwd(target.record.cwd, ctx.roots), a.prompt, change);
          return { via: 'local-resume', sessionId: run.id, status: run.state, nextSeq: 1, ignored: nonEmpty(startOnly(a)) };
        }
        const rest = needRest(ctx, 'sending');
        const { sessionSettings, ignored } = toRestSettings(a);
        if (autonomy) sessionSettings.autonomyLevel = autonomy;
        const applied = Object.keys(sessionSettings);
        if (applied.length) await rest.update(a.session, sessionSettings);
        if (mode === 'interrupt') await rest.interrupt(a.session);
        const sent = await rest.send(a.session, a.prompt);
        return {
          via: 'rest',
          sessionId: a.session,
          messageId: sent.messageId,
          status: sent.status,
          applied: nonEmpty(applied),
          ignored: nonEmpty(ignored),
        };
      });
    }),
  );

  server.registerTool(
    'droid_wait',
    {
      description:
        'Follow a session: returns new events after afterSeq, waiting up to waitMs (max 50000) for something to happen. Without afterSeq, returns the latest events at once. Use nextSeq as the next afterSeq.',
      inputSchema: {
        session: z.string(),
        afterSeq: z.number().int().min(0).optional(),
        waitMs: z.number().int().optional(),
        maxEvents: z.number().int().min(1).max(200).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    handle(async (a) => {
      const waitMs = clampWait(a.waitMs);
      const max = a.maxEvents ?? 50;
      const target = await resolveTarget(ctx, a.session);

      if (target.kind === 'own') {
        const run = target.run;
        const waited = a.afterSeq === undefined ? undefined : await runs.wait(run, a.afterSeq, waitMs);
        const events = waited ? waited.events.slice(0, max) : run.events.slice(-max);
        const lastSeq = run.events.at(-1)?.seq ?? 0;
        return fit(events, (ev: RunEvent[]) => ({
          state: run.state,
          gap: waited?.gap || undefined,
          events: ev.map((e) => ({ ...e, ...clip(e.text) })),
          nextSeq: ev.at(-1)?.seq ?? a.afterSeq ?? lastSeq,
          attention: runs.pendingRequests(run),
        }));
      }

      const rest = viaRest(ctx, target);
      if (rest) {
        const deadline = Date.now() + waitMs;
        const initial = await rest.status(a.session);
        const after = a.afterSeq;
        let s = initial;
        const changed = () =>
          after === undefined || s.messageCount > after || s.elicitations.length > 0 || s.status !== initial.status;
        while (!changed() && Date.now() + 2000 <= deadline) {
          await sleep(2000);
          s = await rest.status(a.session);
        }
        let events: Array<{ seq: number; kind: string; text: string; truncated?: true }> = [];
        let gap = false;
        const unread = after === undefined ? Math.min(max, s.messageCount) : s.messageCount - after;
        if (unread > 0) {
          // Unverified against the live API: assumes getMessages returns the newest `limit` messages.
          const { messages } = await rest.messages(a.session, { limit: 100 });
          const ordered = messages.sort((x, y) => x.createdAt - y.createdAt);
          const firstSeq = s.messageCount - ordered.length + 1;
          const from = after === undefined ? s.messageCount - unread + 1 : after + 1;
          gap = from < firstSeq;
          events = ordered
            .map((m, i) => ({ seq: m.seq ?? firstSeq + i, m }))
            .filter((x) => x.seq >= from)
            .slice(0, max)
            .map(({ seq, m }) => ({ seq, kind: m.role === 'assistant' ? 'assistant' : m.role === 'tool' ? 'tool' : 'user', ...clip(m.text) }));
        }
        return fit(events, (ev) => ({
          state: s.status,
          events: ev,
          gap: gap || undefined,
          nextSeq: ev.at(-1)?.seq ?? after ?? s.messageCount,
          attention: s.elicitations,
        }));
      }

      if (target.kind === 'unknown') throw new Error(`session ${a.session} is not on this machine; following it needs FACTORY_API_KEY`);
      const record = target.record;
      const deadline = Date.now() + waitMs;
      let entries: TranscriptEntry[];
      let end: number | undefined;
      if (a.afterSeq !== undefined) {
        ({ entries, end } = await readTranscript(record.file, a.afterSeq));
        while (entries.length === 0 && Date.now() + 1000 <= deadline) {
          await sleep(1000);
          if ((await stat(record.file)).size > end) ({ entries, end } = await readTranscript(record.file, end));
        }
        if (entries.length > max) {
          entries = entries.slice(0, max);
          end = undefined;
        }
      } else {
        entries = (await readTranscriptTail(record.file, (e) => e.length >= max)).slice(-max);
      }
      const updated = iso((await stat(record.file)).mtimeMs);
      return fit(entries, (ev) => ({
        state: 'local',
        updated,
        events: ev.map((e) => ({ seq: e.seq, kind: e.role, ...clip(e.text) })),
        nextSeq: end !== undefined && ev.length === entries.length ? end : (ev.at(-1)?.seq ?? a.afterSeq ?? 0),
        attention: null,
      }));
    }),
  );

  server.registerTool(
    'droid_respond',
    {
      description:
        'Answer a pending permission prompt (decision = one of the offered option values, optional comment) or AskUser question set (answers, one per question), or cancel it.',
      inputSchema: {
        session: z.string(),
        requestId: z.string(),
        decision: z.string().optional(),
        comment: z.string().optional(),
        answers: z.array(z.string()).optional(),
        cancel: z.boolean().optional(),
      },
    },
    handle(async (a) => {
      const target = await resolveTarget(ctx, a.session);
      if (target.kind === 'own') {
        runs.respond(target.run, a.requestId, a);
        return { sessionId: a.session, requestId: a.requestId, state: target.run.state };
      }
      const rest = needRest(ctx, 'answering prompts');
      const pending = (await rest.elicitations(a.session)).find((e) => e.requestId === a.requestId);
      if (!pending) throw new Error(`no pending request ${a.requestId}`);
      let body: AnswerSessionElicitationRequestBody;
      if (pending.type === 'permission') {
        const options = allowedDecisions(pending.options ?? [], autonomyCap(ctx.env));
        if (a.cancel) body = { selectedOption: 'cancel' };
        else if (!a.decision || !options.includes(a.decision)) {
          throw new Error(`decision must be one of: ${options.join(', ')}`);
        } else {
          body = { selectedOption: a.decision as 'proceed_once', comment: a.comment };
        }
      } else if (a.cancel) {
        body = { cancelled: true };
      } else {
        const questions = pending.questions ?? [];
        const answers = a.answers ?? [];
        if (answers.length !== questions.length) {
          throw new Error(`answers must have exactly ${questions.length} entries, one per question`);
        }
        body = { answers: questions.map((q, i) => ({ index: q.index, question: q.question, answer: answers[i] })) };
      }
      await rest.answer(a.session, a.requestId, body);
      return { sessionId: a.session, requestId: a.requestId, via: 'rest' };
    }),
  );

  server.registerTool(
    'droid_cancel',
    {
      description:
        "Cancel a session's running turn (scope 'turn'), or close a session this server started (scope 'session').",
      inputSchema: { session: z.string(), scope: z.enum(['turn', 'session']) },
    },
    handle(async (a) => {
      const target = await resolveTarget(ctx, a.session);
      if (target.kind === 'own') {
        await runs.cancel(target.run, a.scope);
        return { sessionId: a.session, state: target.run.state };
      }
      if (a.scope === 'session') throw new Error("only sessions this server started can be closed; use scope 'turn'");
      await needRest(ctx, 'cancelling').interrupt(a.session);
      return { sessionId: a.session, via: 'rest', interrupted: true };
    }),
  );

  server.registerTool(
    'droid_result',
    {
      description:
        "Read a session's latest result text and/or the git diff in its cwd, paged by byte offset (use nextOffset to continue).",
      inputSchema: {
        session: z.string(),
        include: z.array(z.enum(['text', 'diff'])).optional(),
        offset: z.number().int().min(0).optional(),
        maxBytes: z.number().int().min(1).max(32768).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    handle(async (a) => {
      const include = a.include?.length ? [...new Set(a.include)] : ['text'];
      const target = await resolveTarget(ctx, a.session);
      const parts: string[] = [];
      for (const part of include) {
        let body: string;
        if (part === 'text') {
          body = await resultText(ctx, target);
        } else {
          const cwd = target.kind === 'own' ? target.run.cwd : target.kind === 'local' ? target.record.cwd : undefined;
          if (!cwd) throw new Error('diff needs a session whose working directory is on this machine');
          body = await gitDiff(checkCwd(cwd, ctx.roots));
        }
        parts.push(include.length > 1 ? `## ${part}\n${body}` : body);
      }
      const page = pageBytes(parts.join('\n\n'), a.offset ?? 0, a.maxBytes ?? DEFAULT_RESULT_BYTES);
      return {
        sessionId: a.session,
        content: page.text,
        offset: page.offset,
        nextOffset: page.nextOffset,
        totalBytes: page.totalBytes,
      };
    }),
  );
}

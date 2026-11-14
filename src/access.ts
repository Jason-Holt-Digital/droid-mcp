import { stat } from 'node:fs/promises';
import type { AnswerSessionElicitationRequestBody } from '@factory/droid-sdk/api';
import { findSession, isSessionId, readTranscript, readTranscriptTail, type SessionRecord, type TranscriptEntry } from './catalog.ts';
import { offlineError, type Computer } from './computers.ts';
import { allowedDecisions, API_KEY_FIX, autonomyCap, checkCwd, INTERNAL_FIX, Refused, ToolError, type Autonomy } from './config.ts';
import type { ModelCatalog } from './models.ts';
import type { Rest } from './rest.ts';
import type { Route, Target } from './route.ts';
import { preview, type Decision, type OwnRun } from './runs.ts';
import { startOnly, toRestSettings, validateSettings, type RunSettings } from './settings.ts';
import type { Ctx } from './tools.ts';

const EVENT_TEXT_MAX = 4000;
const SESSION_ID_FIX = 'Pass a session id from droid_sessions.';

export type FollowEvent = { seq: number; kind: string; text: string; truncated?: true };
// droid_wait fits the events into its byte budget, then builds the reply from what is left with page().
export type FollowPage = { events: FollowEvent[]; page: (events: FollowEvent[]) => Record<string, unknown> };

export type Access = {
  kind: 'own' | 'rest' | 'local';
  sessionId: string;
  computerId?: string;
  follow(afterSeq: number | undefined, waitMs: number, max: number): Promise<FollowPage>;
  respond(requestId: string, answer: Decision): Promise<Record<string, unknown>>;
  interrupt(): Promise<Record<string, unknown>>;
  close(): Promise<Record<string, unknown>>;
  result(): Promise<string>;
  cwd(): string | undefined;
};

export function checkSessionId(id: string): void {
  if (!isSessionId(id)) throw new Refused('invalid', `invalid session id: ${id}`, SESSION_ID_FIX);
}

type Where = { computerId?: string; remote: boolean };

// Fails fast on an offline computer, whether it was named or remembered from droid_sessions.
// Runs this server owns are SDK processes on this machine, whatever computer is named or remembered.
export async function locate(ctx: Ctx, session: string, computer?: string, sending = false): Promise<Where> {
  const run = ctx.runs.get(session);
  if (run && !(sending && run.state === 'closed')) return { remote: false };
  if (computer !== undefined) {
    // A failed computer list is Refused so droid_send's idempotency key is not left pending.
    const c = await ctx.computers.require(computer).catch((err) => {
      if (err instanceof Refused) throw err;
      const message = `could not list computers: ${err instanceof Error ? err.message : String(err)}`;
      throw err instanceof ToolError ? new Refused(err.code, message, err.fix) : new Refused('internal', message, INTERNAL_FIX);
    });
    return c.thisMachine ? { remote: false } : { computerId: c.id, remote: true };
  }
  const remembered = ctx.sessionComputers?.get(session);
  if (!remembered) return { remote: false };
  let c: Computer | undefined;
  try {
    c = (await ctx.computers.list()).find((x) => x.id === remembered);
  } catch {
    c = undefined;
  }
  if (c?.state === 'offline') throw offlineError(c);
  return c?.thisMachine ? { remote: false } : { computerId: remembered, remote: true };
}

// A closed run is still followed through its own event log, but a new send treats it as a local session again.
export async function resolveTarget(ctx: Ctx, id: string, opts: { sending?: boolean; where?: Where } = {}): Promise<Target> {
  const run = ctx.runs.get(id);
  if (run && !(opts.sending && run.state === 'closed')) return { kind: 'own', run };
  checkSessionId(id);
  if (opts.where?.remote) return { kind: 'unknown', id };
  const record = await findSession(ctx.sessionsRoot, id);
  return record ? { kind: 'local', record } : { kind: 'unknown', id };
}

function needRest(ctx: Ctx, what: string): Rest {
  if (!ctx.rest) throw new ToolError('needs_api_key', `${what} for sessions this server did not start needs FACTORY_API_KEY`, API_KEY_FIX);
  return ctx.rest;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function clip(text: string): { text: string; truncated?: true } {
  return text.length > EVENT_TEXT_MAX ? { text: preview(text, EVENT_TEXT_MAX), truncated: true } : { text };
}

function lastAssistantText(entries: TranscriptEntry[]): string {
  const lastUser = entries.findLastIndex((e) => e.role === 'user');
  const after = entries.slice(lastUser + 1).filter((e) => e.role === 'assistant');
  if (after.length) return after.map((e) => e.text).join('\n\n');
  return entries.findLast((e) => e.role === 'assistant')?.text ?? '';
}

function own(ctx: Ctx, run: OwnRun): Access {
  const { runs } = ctx;
  const state = () => ({ sessionId: run.id, state: run.state });
  return {
    kind: 'own',
    sessionId: run.id,
    async follow(afterSeq, waitMs, max) {
      const waited = afterSeq === undefined ? undefined : await runs.wait(run, afterSeq, waitMs);
      const events = (waited ? waited.events.slice(0, max) : run.events.slice(-max)).map((e) => ({ ...e, ...clip(e.text) }));
      const lastSeq = run.events.at(-1)?.seq ?? 0;
      return {
        events,
        page: (ev) => ({
          state: run.state,
          gap: waited?.gap || undefined,
          events: ev,
          nextSeq: ev.at(-1)?.seq ?? afterSeq ?? lastSeq,
          attention: runs.pendingRequests(run),
        }),
      };
    },
    async respond(requestId, answer) {
      runs.respond(run, requestId, answer);
      return { sessionId: run.id, requestId, state: run.state };
    },
    async interrupt() {
      await runs.cancel(run, 'turn');
      return state();
    },
    async close() {
      await runs.cancel(run, 'session');
      return state();
    },
    result: async () => run.lastResult ?? run.events.findLast((e) => e.kind === 'assistant')?.text ?? '',
    cwd: () => run.cwd,
  };
}

async function followRest(rest: Rest, id: string, computerId: string | undefined, after: number | undefined, waitMs: number, max: number): Promise<FollowPage> {
  const deadline = Date.now() + waitMs;
  const initial = await rest.status(id, computerId);
  let s = initial;
  const changed = () => after === undefined || s.messageCount > after || s.elicitations.length > 0 || s.status !== initial.status;
  while (!changed() && Date.now() + 2000 <= deadline) {
    await sleep(2000);
    s = await rest.status(id, computerId);
  }
  let events: FollowEvent[] = [];
  let gap = false;
  const unread = after === undefined ? Math.min(max, s.messageCount) : s.messageCount - after;
  if (unread > 0) {
    // Unverified against the live API: assumes getMessages returns the newest `limit` messages.
    const { messages } = await rest.messages(id, { limit: 100, computerId });
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
  return {
    events,
    page: (ev) => ({
      state: s.status,
      events: ev,
      gap: gap || undefined,
      nextSeq: ev.at(-1)?.seq ?? after ?? s.messageCount,
      attention: s.elicitations,
    }),
  };
}

function remote(ctx: Ctx, sessionId: string, computerId?: string): Access {
  return {
    kind: 'rest',
    sessionId,
    computerId,
    async follow(afterSeq, waitMs, max) {
      if (!ctx.rest) {
        throw new ToolError('needs_api_key', `session ${sessionId} is not on this machine; following it needs FACTORY_API_KEY`, API_KEY_FIX);
      }
      return followRest(ctx.rest, sessionId, computerId, afterSeq, waitMs, max);
    },
    async respond(requestId, a) {
      const rest = needRest(ctx, 'answering prompts');
      const pending = (await rest.elicitations(sessionId)).find((e) => e.requestId === requestId);
      if (!pending) throw new ToolError('not_found', `no pending request ${requestId}`, 'Call droid_wait to see the pending requests and their ids.');
      let body: AnswerSessionElicitationRequestBody;
      if (pending.type === 'permission') {
        const options = allowedDecisions(pending.options ?? [], autonomyCap(ctx.env));
        if (a.cancel) body = { selectedOption: 'cancel' };
        else if (!a.decision || !options.includes(a.decision)) {
          throw new ToolError('invalid', `decision must be one of: ${options.join(', ')}`, 'Pass one of those options as decision, or cancel: true.');
        } else {
          body = { selectedOption: a.decision as 'proceed_once', comment: a.comment };
        }
      } else if (a.cancel) {
        body = { cancelled: true };
      } else {
        const questions = pending.questions ?? [];
        const answers = a.answers ?? [];
        if (answers.length !== questions.length) {
          throw new ToolError('invalid', `answers must have exactly ${questions.length} entries, one per question`, 'Pass one answer per question, in order.');
        }
        body = { answers: questions.map((q, i) => ({ index: q.index, question: q.question, answer: answers[i] })) };
      }
      await rest.answer(sessionId, requestId, body);
      return { sessionId, requestId, via: 'rest' };
    },
    async interrupt() {
      await needRest(ctx, 'interrupting').interrupt(sessionId);
      return { sessionId, via: 'rest', interrupted: true };
    },
    async close() {
      throw new ToolError('invalid', 'only sessions this server started can be closed', 'Use droid_interrupt to stop its running turn.');
    },
    async result() {
      const { messages } = await needRest(ctx, 'reading results').messages(sessionId, { role: 'assistant', limit: 100, computerId });
      return messages.sort((a, b) => a.createdAt - b.createdAt).at(-1)?.text ?? '';
    },
    cwd: () => undefined,
  };
}

async function followTranscript(record: SessionRecord, afterSeq: number | undefined, waitMs: number, max: number): Promise<FollowPage> {
  const deadline = Date.now() + waitMs;
  let entries: TranscriptEntry[];
  let end: number | undefined;
  if (afterSeq !== undefined) {
    ({ entries, end } = await readTranscript(record.file, afterSeq));
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
  const updated = new Date((await stat(record.file)).mtimeMs).toISOString();
  return {
    events: entries.map((e) => ({ seq: e.seq, kind: e.role, ...clip(e.text) })),
    page: (ev) => ({
      state: 'local',
      updated,
      events: ev,
      nextSeq: end !== undefined && ev.length === entries.length ? end : (ev.at(-1)?.seq ?? afterSeq ?? 0),
      attention: null,
    }),
  };
}

// Prompts and interrupts on a local session go over REST; a workstream session is followed there too when a key exists.
function local(ctx: Ctx, record: SessionRecord): Access {
  return {
    ...remote(ctx, record.id),
    kind: 'local',
    follow: (afterSeq, waitMs, max) =>
      ctx.rest && record.workstream ? followRest(ctx.rest, record.id, undefined, afterSeq, waitMs, max) : followTranscript(record, afterSeq, waitMs, max),
    result: async () => lastAssistantText(await readTranscriptTail(record.file, (e) => e.some((x) => x.role === 'user'))),
    cwd: () => record.cwd,
  };
}

function adapt(ctx: Ctx, target: Target, computerId?: string): Access {
  if (target.kind === 'own') return own(ctx, target.run);
  if (target.kind === 'local') return local(ctx, target.record);
  return remote(ctx, target.id, computerId);
}

export async function openSession(ctx: Ctx, session: string, computer: string | undefined): Promise<Access> {
  const where = await locate(ctx, session, computer);
  return adapt(ctx, await resolveTarget(ctx, session, { where }), where.computerId);
}

export function resultText(ctx: Ctx, target: Target, computerId?: string): Promise<string> {
  return adapt(ctx, target, computerId).result();
}

const nonEmpty = (list: string[]) => (list.length ? list : undefined);

export type SendArgs = {
  session: string;
  prompt: string;
  mode: 'queue' | 'interrupt';
  settings: RunSettings;
  autonomy?: Autonomy;
  computerId?: string;
  catalog: ModelCatalog;
};

export async function sendTo(ctx: Ctx, target: Target, route: Exclude<Route, { refused: Refused }>, a: SendArgs): Promise<Record<string, unknown>> {
  const { runs } = ctx;
  const current = target.kind === 'own' ? target.run.session.settings.autonomyLevel : target.kind === 'local' ? target.record.autonomy : undefined;
  validateSettings(a.settings, a.autonomy ?? (route.via === 'rest' ? undefined : current), a.catalog);
  const change = { settings: a.settings, autonomy: a.autonomy };
  if (route.via === 'own' && target.kind === 'own') {
    const seq = await runs.send(target.run, a.prompt, a.mode, change);
    return { via: 'own', sessionId: target.run.id, status: target.run.state, nextSeq: seq, ignored: nonEmpty(startOnly(a.settings)) };
  }
  if (route.via === 'local-resume' && target.kind === 'local') {
    const run = await runs.resume(target.record, checkCwd(target.record.cwd, ctx.roots), a.prompt, change);
    return { via: 'local-resume', sessionId: run.id, status: run.state, nextSeq: 1, ignored: nonEmpty(startOnly(a.settings)) };
  }
  const rest = needRest(ctx, 'sending');
  const { sessionSettings, ignored } = toRestSettings(a.settings);
  if (a.autonomy) sessionSettings.autonomyLevel = a.autonomy;
  const applied = Object.keys(sessionSettings);
  if (applied.length) await rest.update(a.session, sessionSettings);
  if (a.mode === 'interrupt') await rest.interrupt(a.session);
  const sent = await rest.send(a.session, a.prompt, a.computerId);
  return {
    via: 'rest',
    sessionId: a.session,
    messageId: sent.messageId,
    status: sent.status,
    applied: nonEmpty(applied),
    ignored: nonEmpty(ignored),
  };
}

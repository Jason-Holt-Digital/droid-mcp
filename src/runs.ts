import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  createSession,
  isDroidConnectionEnded,
  ProcessTransport,
  resumeSession,
  type AutonomyLevel,
  type CreateSessionOptions,
  type DroidSession,
  type DroidStreamMessage,
} from '@factory/droid-sdk/node';
import type { SessionRecord } from './catalog.ts';
import { allowedDecisions, exceedsCap, Refused, ToolError, type Autonomy } from './config.ts';
import { addTags, toUpdate, type RunSettings, type SettingsUpdate } from './settings.ts';

export type Question = { index: number; question: string; options: string[] };
export type RunEvent = {
  seq: number;
  at: number;
  kind: 'user' | 'assistant' | 'tool' | 'permission' | 'ask_user' | 'result' | 'error' | 'state';
  text: string;
  requestId?: string;
  options?: string[];
  questions?: Question[];
};
type Pending = {
  kind: 'permission' | 'ask_user';
  resolve: (value: unknown) => void;
  expires: number;
  timer: NodeJS.Timeout;
  options?: string[];
  questions?: Question[];
};
export type RunState = 'working' | 'needs_you' | 'idle' | 'dead' | 'closed';

const NEXT: Record<RunState, RunState[]> = {
  working: ['needs_you', 'idle', 'dead', 'closed'],
  needs_you: ['working', 'dead', 'closed'],
  idle: ['working', 'dead', 'closed'],
  dead: ['working', 'closed'],
  closed: [],
};

export function move(run: { state: RunState }, to: RunState): void {
  if (!NEXT[run.state].includes(to)) {
    throw new ToolError('internal', `illegal session state change from ${run.state} to ${to}`, 'Report this as a droid-mcp bug.');
  }
  run.state = to;
}
export type OwnRun = {
  id: string;
  cwd: string;
  repo: string;
  session: DroidSession;
  state: RunState;
  events: RunEvent[];
  nextSeq: number;
  pending: Map<string, Pending>;
  lastResult?: string;
  turn?: Promise<void>;
  // Serializes send and cancel so two interrupting sends can't both start a turn.
  lock: Promise<unknown>;
  waiters: Set<() => void>;
  close: () => Promise<void>;
  autoClose: boolean;
  idleTimer?: NodeJS.Timeout;
  // When this server finished closing the session; unset while the process is still stopping.
  closedAt?: number;
};
export type Decision = { decision?: string; comment?: string; answers?: string[]; cancel?: boolean };

type PermissionHandler = NonNullable<CreateSessionOptions['permissionHandler']>;
type AskUserHandler = NonNullable<CreateSessionOptions['askUserHandler']>;
type Handlers = { permissionHandler: PermissionHandler; askUserHandler: AskUserHandler };
type Connection = { apiKey: string; execArgs?: string[] } | { transport: ProcessTransport };
type Opened = { session: DroidSession; close: () => Promise<void> };
type Create = (connection: Connection, handlers: Handlers) => Promise<Opened>;
export type Change = { settings?: RunSettings; autonomy?: Autonomy };

const PENDING_MS = 30 * 60 * 1000;
const IDLE_MS = 30 * 60 * 1000;
const INTERRUPT_GRACE_MS = 15_000;
const MAX_EVENTS = 1000;
const WAKE_KINDS = new Set<RunEvent['kind']>(['assistant', 'permission', 'ask_user', 'error', 'state']);
const ENDED_ERRORS = new Set(['DroidConnectionEndedError', 'ProcessExitError']);

// The SDK reports a dead transport as a synthesized `error` session notification carrying the error's name.
function connectionEnded(notification: Record<string, unknown>): boolean {
  const n = notification as { params?: { notification?: { error?: { name?: string } } } };
  return ENDED_ERRORS.has(n.params?.notification?.error?.name ?? '');
}

export function preview(text: string, max = 400): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function worktreeArgs(worktree: RunSettings['worktree']): string[] | undefined {
  if (worktree === true) return ['--worktree'];
  return typeof worktree === 'string' ? ['--worktree', worktree] : undefined;
}

function opened(session: DroidSession): Opened {
  return { session, close: () => session.close() };
}

// SDK 0.11 types omit restrictToolIds and additionalToolIds from updateSettings, but droid applies them.
function update(session: DroidSession, u: SettingsUpdate): Promise<unknown> {
  return session.updateSettings(u as unknown as Parameters<DroidSession['updateSettings']>[0]);
}

// tags merge with the session's own, since updateSettings replaces the whole list.
function changeFor(session: DroidSession, { settings = {}, autonomy }: Change): SettingsUpdate | undefined {
  const u: SettingsUpdate = { ...toUpdate(settings) };
  if (autonomy) u.autonomyLevel = autonomy;
  if (settings.tags?.length) u.tags = addTags(session.settings.tags, settings.tags);
  return Object.keys(u).length ? u : undefined;
}

function cancelValue(kind: Pending['kind']): unknown {
  return kind === 'permission' ? 'cancel' : { cancelled: true, answers: [] };
}

function toEvent(m: DroidStreamMessage): Pick<RunEvent, 'kind' | 'text'> | undefined {
  switch (m.type) {
    case 'assistant':
      return m.text ? { kind: 'assistant', text: m.text } : undefined;
    case 'user': {
      const content: unknown = m.message.content;
      const text = Array.isArray(content)
        ? content
            .filter((b) => b?.type === 'text')
            .map((b) => String(b.text))
            .join('\n')
        : '';
      return text ? { kind: 'user', text: preview(text) } : undefined;
    }
    case 'tool_call':
      return { kind: 'tool', text: preview(`${m.name} ${JSON.stringify(m.input)}`) };
    case 'tool_result': {
      const body = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      return { kind: 'tool', text: preview(`${m.toolName} ${m.isError ? 'error' : 'ok'}: ${body}`) };
    }
    case 'error':
      return { kind: 'error', text: preview(m.message) };
    case 'result': {
      const failure = m.subtype === 'success' ? '' : `[${m.subtype}${m.error ? `: ${m.error.message}` : ''}] `;
      return { kind: 'result', text: failure + m.text };
    }
    default:
      return undefined;
  }
}

type OpenOptions = {
  cwd: string;
  prompt: string;
  execArgs?: string[];
  create: Create;
  settingsFor?: (session: DroidSession) => SettingsUpdate | undefined;
  autoClose?: boolean;
};

export class Runs {
  readonly runs = new Map<string, OwnRun>();
  private readonly reserved: string[] = [];
  private readonly apiKey: string | undefined;
  private readonly repoOf: (cwd: string) => string;
  private readonly maxRunning: number;
  private readonly cap: Autonomy;
  private readonly opening = new Set<Promise<unknown>>();
  private readonly resumeSession: typeof resumeSession;
  private readonly idleMs: number;
  private closing = false;

  constructor(opts: {
    apiKey?: string;
    repoOf: (cwd: string) => string;
    maxRunning?: number;
    cap?: Autonomy;
    resumeSession?: typeof resumeSession;
    idleMs?: number;
  }) {
    this.apiKey = opts.apiKey;
    this.repoOf = opts.repoOf;
    this.maxRunning = opts.maxRunning ?? 3;
    this.cap = opts.cap ?? 'high';
    this.resumeSession = opts.resumeSession ?? resumeSession;
    this.idleMs = opts.idleMs ?? IDLE_MS;
  }

  get(id: string): OwnRun | undefined {
    return this.runs.get(id);
  }

  async start(opts: { cwd: string; prompt: string; autonomy: Autonomy; settings?: RunSettings }): Promise<OwnRun> {
    const s = opts.settings ?? {};
    const tags = [{ name: 'droid-mcp' }, ...(s.tags ?? []).map((name) => ({ name }))];
    const fork = s.fork;
    const create = fork
      ? async (connection: Connection, handlers: Handlers): Promise<Opened> => {
          const source = await this.resumeSession(fork, { ...connection, ...handlers });
          try {
            const session = await source.fork({ tags });
            return {
              session,
              close: async () => {
                await session.close().catch(() => {});
                await source.close();
              },
            };
          } catch (err) {
            await source.close().catch(() => {});
            throw err;
          }
        }
      : async (connection: Connection, handlers: Handlers) =>
          opened(
            await createSession({
              cwd: opts.cwd,
              ...connection,
              ...handlers,
              tags,
              autonomyLevel: opts.autonomy as AutonomyLevel,
              systemPrompt: s.appendSystemPrompt ? { type: 'preset', preset: 'droid', append: s.appendSystemPrompt } : undefined,
            }),
          );
    const u: SettingsUpdate = { ...toUpdate(s), ...(fork ? { autonomyLevel: opts.autonomy } : {}) };
    return this.open({
      cwd: opts.cwd,
      prompt: opts.prompt,
      execArgs: worktreeArgs(s.worktree),
      create,
      settingsFor: () => (Object.keys(u).length ? u : undefined),
      autoClose: true,
    });
  }

  async resume(record: SessionRecord, cwd: string, prompt: string, change: Change = {}): Promise<OwnRun> {
    // A run of ours that is still shutting down holds the session; load it only once that process is gone.
    await this.runs.get(record.id)?.lock;
    return this.open({
      cwd,
      prompt,
      create: (connection, handlers) => this.resumeWithinCap(record.id, connection, handlers),
      settingsFor: (session) => changeFor(session, change),
      autoClose: this.runs.get(record.id)?.autoClose,
    });
  }

  private async resumeWithinCap(id: string, connection: Connection, handlers: Handlers): Promise<Opened> {
    const session = await this.resumeSession(id, { ...connection, ...handlers });
    const level = session.settings.autonomyLevel;
    if (level === undefined || exceedsCap(level, this.cap)) {
      await session.close().catch(() => {});
      throw new Refused(
        'invalid',
        `session autonomy '${level ?? 'unknown'}' exceeds the cap '${this.cap}'`,
        'Start a new session within the cap with droid_start.',
      );
    }
    return opened(session);
  }

  send(run: OwnRun, prompt: string, mode: 'queue' | 'interrupt', change: Change = {}): Promise<number> {
    return this.serial(run, async () => {
      if (run.state === 'closed') throw new Refused('invalid', 'session is closed', 'Start a new session with droid_start.');
      if (run.state === 'dead') {
        await this.revive(run);
      } else if (run.turn) {
        if (mode === 'queue') throw new Refused('busy', 'a turn is running', 'Wait for it with droid_wait, or send with mode "interrupt".');
        if (!(await this.cancelTurn(run))) {
          throw new Refused(
            'busy',
            'the running turn did not stop after the interrupt; nothing was sent',
            'Wait for the turn with droid_wait, then send again.',
          );
        }
      }
      this.admit(run.repo, run);
      const u = changeFor(run.session, change);
      if (u) await update(run.session, u);
      return this.begin(run, prompt);
    });
  }

  private async revive(run: OwnRun): Promise<void> {
    this.admit(run.repo, run);
    this.reserved.push(run.repo);
    try {
      await run.turn;
      await run.close();
      const { session, close } = await this.connect(
        run.cwd,
        undefined,
        (c, h) => this.resumeWithinCap(run.id, c, h),
        () => run,
      );
      run.session = session;
      run.close = close;
      this.watch(run);
    } catch (err) {
      if (err instanceof ToolError) throw err;
      throw new Refused(
        'internal',
        `the droid process behind this session ended, and resuming it failed: ${message(err)}`,
        'Retry droid_send; if it fails again, start a new session with droid_start.',
      );
    } finally {
      this.reserved.splice(this.reserved.indexOf(run.repo), 1);
    }
  }

  private serial<T>(run: OwnRun, fn: () => Promise<T>): Promise<T> {
    const next = run.lock.then(fn, fn);
    run.lock = next.catch(() => {});
    return next;
  }

  // Returns once something the caller would act on arrives; tool and echo events ride along with it.
  async wait(run: OwnRun, afterSeq: number, waitMs: number): Promise<{ events: RunEvent[]; gap: boolean }> {
    const fresh = () => run.events.filter((e) => e.seq > afterSeq);
    const deadline = Date.now() + waitMs;
    while (run.state !== 'closed' && run.state !== 'dead' && !fresh().some((e) => WAKE_KINDS.has(e.kind)) && Date.now() < deadline) {
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          run.waiters.delete(done);
          resolve();
        };
        const timer = setTimeout(done, deadline - Date.now());
        run.waiters.add(done);
      });
    }
    const events = fresh();
    return { events, gap: (run.events[0]?.seq ?? 1) > afterSeq + 1 };
  }

  pendingRequests(run: OwnRun) {
    return [...run.pending].map(([requestId, p]) => ({
      requestId,
      kind: p.kind,
      options: p.options,
      questions: p.questions,
      expires: new Date(p.expires).toISOString(),
    }));
  }

  respond(run: OwnRun, requestId: string, d: Decision): void {
    const p = run.pending.get(requestId);
    if (!p) throw new ToolError('not_found', `no pending request ${requestId}`, 'Call droid_wait to see the pending requests and their ids.');
    let value: unknown;
    if (d.cancel) {
      value = cancelValue(p.kind);
    } else if (p.kind === 'permission') {
      const options = p.options ?? [];
      if (!d.decision || !options.includes(d.decision)) {
        throw new ToolError('invalid', `decision must be one of: ${options.join(', ')}`, 'Pass one of those options as decision, or cancel: true.');
      }
      value = d.comment ? { selectedOption: d.decision, comment: d.comment } : d.decision;
    } else {
      const questions = p.questions ?? [];
      if (!d.answers || d.answers.length !== questions.length) {
        throw new ToolError('invalid', `answers must have exactly ${questions.length} entries, one per question`, 'Pass one answer per question, in order.');
      }
      const answers = d.answers;
      value = { answers: questions.map((q, i) => ({ index: q.index, question: q.question, answer: answers[i] })) };
    }
    this.settle(run, requestId, value, 'answered');
  }

  cancel(run: OwnRun, scope: 'turn' | 'session'): Promise<void> {
    return this.serial(run, async () => {
      if (run.state === 'closed') return;
      const stopped = await this.cancelTurn(run);
      if (scope === 'session') {
        await this.shut(run, 'closed');
      } else if (!stopped) {
        throw new ToolError(
          'busy',
          `the turn did not stop within ${INTERRUPT_GRACE_MS / 1000} s of the interrupt`,
          'Check it with droid_wait, and cancel again if it is still running.',
        );
      }
    });
  }

  private async shut(run: OwnRun, note: string): Promise<void> {
    this.to(run, 'closed');
    await run.close();
    run.closedAt = Date.now();
    this.push(run, { kind: 'state', text: note });
  }

  // Leaving idle clears the timer, so a timer that is still the run's own means the run has stayed idle.
  private to(run: OwnRun, state: RunState): void {
    move(run, state);
    clearTimeout(run.idleTimer);
    run.idleTimer = undefined;
    if (state !== 'idle' || !run.autoClose) return;
    const timer: NodeJS.Timeout = setTimeout(
      () =>
        void this.serial(run, async () => {
          if (run.idleTimer === timer) await this.shut(run, `closed after ${this.idleMs / 60_000} min idle`);
        }),
      this.idleMs,
    );
    timer.unref();
    run.idleTimer = timer;
  }

  async closeAll(): Promise<void> {
    this.closing = true;
    await Promise.allSettled(this.opening);
    await Promise.all([...this.runs.values()].map((r) => this.cancel(r, 'session').catch(() => {})));
  }

  private async cancelTurn(run: OwnRun): Promise<boolean> {
    for (const [id, p] of run.pending) this.settle(run, id, cancelValue(p.kind), 'cancelled');
    const turn = run.turn;
    if (!turn) return true;
    let timer: NodeJS.Timeout | undefined;
    void run.session.interrupt().catch(() => {});
    const stopped = await Promise.race([
      turn.then(() => true),
      new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(false), INTERRUPT_GRACE_MS))),
    ]);
    clearTimeout(timer);
    return stopped;
  }

  private admit(repo: string, except?: OwnRun): void {
    if (this.closing) throw new Refused('busy', 'server is shutting down', 'Retry once the server has restarted.');
    const active = [...this.runs.values()].filter((r) => r !== except && (r.state === 'working' || r.state === 'needs_you'));
    if (active.length + this.reserved.length >= this.maxRunning) {
      throw new Refused('busy', `${this.maxRunning} turns are already running`, 'Wait for a running turn to finish, then retry.');
    }
    if (active.some((r) => r.repo === repo) || this.reserved.includes(repo)) {
      throw new Refused('busy', `another session is already running in ${repo}`, "Wait for that session's turn to finish, then retry.");
    }
  }

  private async open(opts: OpenOptions): Promise<OwnRun> {
    const repo = this.repoOf(opts.cwd);
    this.admit(repo);
    this.reserved.push(repo);
    const opened = this.openReserved(opts, repo);
    this.opening.add(opened);
    try {
      const run = await opened;
      if (this.closing) {
        await this.cancel(run, 'session');
        throw new Error('server is shutting down');
      }
      return run;
    } finally {
      this.opening.delete(opened);
    }
  }

  private async openReserved({ cwd, prompt, execArgs, create, settingsFor, autoClose = false }: OpenOptions, repo: string): Promise<OwnRun> {
    try {
      let run: OwnRun | undefined;
      const { session, close } = await this.connect(cwd, execArgs, create, () => run);
      try {
        const u = settingsFor?.(session);
        if (u) await update(session, u);
      } catch (err) {
        await close();
        throw err;
      }
      run = {
        id: session.id,
        cwd,
        repo,
        session,
        state: 'idle',
        events: [],
        nextSeq: 1,
        pending: new Map(),
        lock: Promise.resolve(),
        waiters: new Set(),
        close,
        autoClose,
      };
      this.runs.set(run.id, run);
      this.reserved.splice(this.reserved.indexOf(repo), 1);
      this.watch(run);
      this.begin(run, prompt);
      return run;
    } catch (err) {
      const i = this.reserved.indexOf(repo);
      if (i >= 0) this.reserved.splice(i, 1);
      throw err;
    }
  }

  private async connect(cwd: string, execArgs: string[] | undefined, create: Create, get: () => OwnRun | undefined): Promise<Opened> {
    let transport: ProcessTransport | undefined;
    try {
      let connection: Connection;
      if (this.apiKey) {
        connection = { apiKey: this.apiKey, execArgs };
      } else {
        transport = new ProcessTransport({ cwd, droidExecExtraArgs: execArgs, env: { FACTORY_UPSTREAM_CLIENT_TYPE: 'sdk' } });
        await transport.connect();
        connection = { transport };
      }
      const { session, close } = await create(connection, this.handlers(get));
      const t = transport;
      return {
        session,
        close: async () => {
          await close().catch(() => {});
          await t?.close().catch(() => {});
        },
      };
    } catch (err) {
      await transport?.close().catch(() => {});
      throw err;
    }
  }

  private watch(run: OwnRun): void {
    const session = run.session;
    session.onNotification(
      (n) => {
        if (run.session === session && connectionEnded(n)) this.die(run);
      },
      { type: 'error' },
    );
  }

  private die(run: OwnRun): void {
    if (run.state === 'dead' || run.state === 'closed') return;
    this.to(run, 'dead');
    for (const [id, p] of run.pending) this.settle(run, id, cancelValue(p.kind), 'cancelled (droid process ended)');
    this.push(run, { kind: 'state', text: 'dead' });
  }

  private handlers(get: () => OwnRun | undefined): Handlers {
    return {
      permissionHandler: (params) => {
        const text = params.toolUses.map((t) => `${t.toolUse.name} ${JSON.stringify(t.toolUse.input)}`).join('; ');
        const options = allowedDecisions(
          params.options.map((o) => o.value),
          this.cap,
        );
        return this.park(get(), 'permission', text, { options }) as ReturnType<PermissionHandler>;
      },
      askUserHandler: (params) => {
        const questions = params.questions.map(({ index, question, options }) => ({ index, question, options }));
        return this.park(get(), 'ask_user', questions.map((q) => q.question).join(' | '), { questions }) as ReturnType<AskUserHandler>;
      },
    };
  }

  private park(run: OwnRun | undefined, kind: Pending['kind'], text: string, extra: { options?: string[]; questions?: Question[] }): Promise<unknown> {
    if (run?.state !== 'working' && run?.state !== 'needs_you') return Promise.resolve(cancelValue(kind));
    const requestId = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.settle(run, requestId, cancelValue(kind), 'auto-cancelled after 30 min'), PENDING_MS);
      timer.unref();
      run.pending.set(requestId, { kind, resolve, expires: Date.now() + PENDING_MS, timer, ...extra });
      if (run.state === 'working') this.to(run, 'needs_you');
      this.push(run, { kind, text: preview(text), requestId, ...extra });
    });
  }

  private settle(run: OwnRun, requestId: string, value: unknown, note: string): void {
    const p = run.pending.get(requestId);
    if (!p) return;
    clearTimeout(p.timer);
    run.pending.delete(requestId);
    p.resolve(value);
    if (run.pending.size === 0 && run.state === 'needs_you') this.to(run, 'working');
    this.push(run, { kind: 'state', text: `${note} ${requestId}`, requestId });
  }

  private begin(run: OwnRun, prompt: string): number {
    this.to(run, 'working');
    const seq = this.push(run, { kind: 'user', text: preview(prompt) });
    const turn: Promise<void> = this.drain(run, prompt).finally(() => {
      if (run.turn === turn) run.turn = undefined;
    });
    run.turn = turn;
    return seq;
  }

  private async drain(run: OwnRun, prompt: string): Promise<void> {
    try {
      for await (const m of run.session.stream(prompt)) {
        if (m.type === 'result') run.lastResult = m.text;
        const e = toEvent(m);
        if (e && !(e.kind === 'user' && e.text === preview(prompt))) this.push(run, e);
      }
    } catch (err) {
      this.push(run, { kind: 'error', text: preview(message(err)) });
      if (isDroidConnectionEnded(err)) this.die(run);
    } finally {
      for (const [id, p] of run.pending) this.settle(run, id, cancelValue(p.kind), 'turn ended');
      if (run.state === 'working') {
        this.to(run, 'idle');
        this.push(run, { kind: 'state', text: 'idle' });
      }
    }
  }

  private push(run: OwnRun, e: Omit<RunEvent, 'seq' | 'at'>): number {
    const seq = run.nextSeq++;
    run.events.push({ ...e, seq, at: Date.now() });
    if (run.events.length > MAX_EVENTS) run.events.splice(0, run.events.length - MAX_EVENTS);
    for (const w of run.waiters) w();
    return seq;
  }
}

export async function writeAtomic(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const fh = await open(tmp, 'w', 0o600);
  try {
    await fh.writeFile(text);
    await fh.sync();
  } finally {
    await fh.close();
  }
  await rename(tmp, path);
}

// fp fingerprints the request, so a key reused for a different request is refused instead of replaying another result.
type KeyEntry = { at: number; fp?: string; result?: unknown; pending?: true };
const KEY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Key order does not matter; undefined fields are dropped, as JSON drops them.
function fingerprint(request: Record<string, unknown>): string {
  const sorted = Object.fromEntries(Object.entries(request).sort(([a], [b]) => a.localeCompare(b)));
  return createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
}

const reused = () =>
  new Refused('invalid', 'this idempotencyKey was already used for a different request', 'Pass a new idempotencyKey, or omit it to always act anew.');

// Write-ahead: a key is marked pending before the action runs and stays pending if the action fails after it may
// have had an effect, so a retry refuses instead of repeating it. Each save merges with the file on disk, so
// several server processes can share it.
export class KeyStore {
  private readonly path: string;
  private readonly data: Record<string, KeyEntry> = {};
  private readonly dropped = new Set<string>();
  private saving: Promise<unknown> = Promise.resolve();
  private readonly inflight = new Map<string, { fp: string; p: Promise<unknown> }>();

  constructor(path: string) {
    this.path = path;
  }

  async once<T>(key: string, request: Record<string, unknown>, fn: () => Promise<T>): Promise<T> {
    const fp = fingerprint(request);
    const running = this.inflight.get(key);
    if (running) {
      if (running.fp !== fp) throw reused();
      return running.p as Promise<T>;
    }
    const p = (async () => {
      const hit = this.data[key] ?? (await this.read())[key];
      if (hit?.pending) {
        throw new ToolError(
          'invalid',
          'an earlier attempt with this idempotencyKey did not finish and may have taken effect',
          'Check droid_find for its session before retrying with a new idempotencyKey.',
        );
      }
      if (hit) {
        if (hit.fp !== fp) throw reused();
        return hit.result as T;
      }
      this.data[key] = { at: Date.now(), fp, pending: true };
      try {
        await this.save();
      } catch (err) {
        this.drop(key);
        throw err;
      }
      try {
        const result = await fn();
        this.data[key] = { at: Date.now(), fp, result };
        return result;
      } catch (err) {
        if (err instanceof Refused) this.drop(key);
        throw err;
      } finally {
        await this.save();
      }
    })().finally(() => this.inflight.delete(key));
    this.inflight.set(key, { fp, p });
    return p;
  }

  private drop(key: string): void {
    delete this.data[key];
    this.dropped.add(key);
  }

  flush(): Promise<unknown> {
    return this.saving;
  }

  private async read(): Promise<Record<string, KeyEntry>> {
    let text: string;
    try {
      text = await readFile(this.path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw new Error(`cannot read ${this.path}: ${(err as Error).message}`);
    }
    try {
      return JSON.parse(text).keys ?? {};
    } catch (err) {
      throw new Error(`cannot parse ${this.path}: ${(err as Error).message}`);
    }
  }

  private save(): Promise<void> {
    const write = async () => {
      const merged = { ...(await this.read()), ...this.data };
      for (const k of this.dropped) if (!(k in this.data)) delete merged[k];
      const cutoff = Date.now() - KEY_TTL_MS;
      for (const [k, v] of Object.entries(merged)) if (v.at < cutoff) delete merged[k];
      await writeAtomic(this.path, JSON.stringify({ keys: merged }));
    };
    const next = this.saving.then(write, write);
    this.saving = next.catch(() => {});
    return next;
  }
}

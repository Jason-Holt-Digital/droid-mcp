import { z } from 'zod';
import { resultText } from './access.ts';
import { isSessionId } from './catalog.ts';
import { ToolError } from './config.ts';
import type { DroidEvent, EventInput, EventKind } from './events.ts';
import type { Target } from './route.ts';
import { preview } from './runs.ts';
import type { Ctx } from './tools.ts';

const RING_LIMIT = 60;
const RING_WINDOW_MS = 60_000;
// Factory can still report a session as running for a moment after its Stop hook fires.
const STOP_RETRY_MS = 1000;
const STOP_RETRIES = 5;
const SEEN_MAX = 1000;
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

const RingBody = z.object({
  session_id: z.string().max(200).refine(isSessionId, 'invalid session id'),
  hook_event_name: z.string().max(100),
  notification_type: z.string().max(100).optional(),
});
type Ring = z.infer<typeof RingBody>;

export function parseRing(json: unknown): Ring {
  const r = RingBody.safeParse(json);
  if (!r.success) {
    throw new Error(`invalid ring: ${r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ')}`);
  }
  return r.data;
}

export async function recordEvent(ctx: Ctx, input: EventInput, forward = true): Promise<DroidEvent> {
  let computer: string | undefined;
  if (input.computerId) {
    try {
      computer = (await ctx.computers.list()).find((c) => c.id === input.computerId)?.name;
    } catch {
      computer = undefined;
    }
  }
  if (input.computerId && computer !== undefined) ctx.sessionComputers?.set(input.sessionId, input.computerId);
  const event = ctx.events.add(input, {
    computer: computer ?? input.host ?? 'unknown',
    forward: forward && Boolean(ctx.forwarder?.enabled) && ctx.subscriptions.has(input.sessionId),
  });
  if (event.forwarded) void ctx.forwarder?.send(event);
  return event;
}

const NOTIFICATIONS = new Map<string | undefined, EventKind>([
  ['permission_prompt', 'permission'],
  ['elicitation_dialog', 'question'],
]);

function claim(r: Ring): EventKind | undefined {
  if (r.hook_event_name === 'Stop') return 'finished';
  if (r.hook_event_name === 'SessionEnd') return 'ended';
  if (r.hook_event_name === 'Notification') return NOTIFICATIONS.get(r.notification_type);
  return undefined;
}

type Prompt = { kind: 'permission' | 'question'; text: string };
type View = { busy: boolean; prompt?: Prompt; target: Target; computerId?: string; title?: string; cwd?: string; tags?: string[] };

function stopEvent(text: string): Pick<EventInput, 'kind' | 'text'> {
  const lines = text.split('\n');
  const i = lines.findIndex((l) => l.trimStart().startsWith('QUESTION:'));
  if (i >= 0) return { kind: 'question', text: lines.slice(i).join('\n').trim().slice(0, 1000) };
  return { kind: 'finished', text: text.trim().slice(-300) };
}

export function seenKey(computer: string | string[] | undefined, address: string | undefined): string {
  if (typeof computer === 'string' && /^[A-Za-z0-9._-]{1,100}$/.test(computer)) return computer;
  return address !== undefined && LOOPBACK.has(address) ? 'this-machine' : `addr:${address ?? 'unknown'}`;
}

export class Doorbell {
  #ctx: Ctx;
  #limit: number;
  #retryMs: number;
  #log: (msg: string) => void;
  #hits = new Map<string, { start: number; count: number }>();
  #pending = new Set<Promise<void>>();
  #seen = new Map<string, number>();

  constructor(ctx: Ctx, opts: { limit?: number; retryMs?: number; log?: (msg: string) => void } = {}) {
    this.#ctx = ctx;
    this.#limit = opts.limit ?? RING_LIMIT;
    this.#retryMs = opts.retryMs ?? STOP_RETRY_MS;
    this.#log = opts.log ?? ((msg) => console.error(msg));
  }

  allow(address: string, now = Date.now()): boolean {
    const hit = this.#hits.get(address);
    if (hit && now - hit.start < RING_WINDOW_MS) return ++hit.count <= this.#limit;
    if (this.#hits.size >= 1000) for (const [k, v] of this.#hits) if (now - v.start >= RING_WINDOW_MS) this.#hits.delete(k);
    this.#hits.set(address, { start: now, count: 1 });
    return true;
  }

  // Rings are unauthenticated, so the keys are caller-chosen; only the newest SEEN_MAX are kept.
  ring(r: Ring, from: { computer?: string | string[]; address?: string } = {}): void {
    const key = seenKey(from.computer, from.address);
    this.#seen.delete(key);
    if (this.#seen.size >= SEEN_MAX) this.#seen.delete(this.#seen.keys().next().value!);
    this.#seen.set(key, Date.now());
    const p: Promise<void> = this.#handle(r)
      .catch((err) => this.#log(`droid-mcp: ${r.hook_event_name} ring for ${r.session_id} failed: ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => this.#pending.delete(p));
    this.#pending.add(p);
  }

  seenAt(key: string): number | undefined {
    return this.#seen.get(key);
  }

  seenAll(): ReadonlyMap<string, number> {
    return new Map(this.#seen);
  }

  async idle(): Promise<void> {
    while (this.#pending.size) await Promise.all(this.#pending);
  }

  async #handle(r: Ring): Promise<void> {
    const ctx = this.#ctx;
    const kind = claim(r);
    if (!kind) return;
    const sessionId = r.session_id;
    if (!ctx.subscriptions.has(sessionId)) {
      await recordEvent(ctx, { sessionId, kind }, false);
      return;
    }
    const run = ctx.runs.get(sessionId);
    const rest = ctx.rest;
    let look: () => Promise<View | undefined>;
    if (run) {
      look = async () => {
        const [requestId, p] = [...run.pending][0] ?? [];
        const text = run.events.findLast((e) => e.requestId === requestId)?.text ?? '';
        return {
          busy: run.state === 'working' || run.state === 'needs_you',
          prompt: p && { kind: p.kind === 'permission' ? 'permission' : 'question', text },
          target: { kind: 'own', run },
          cwd: run.cwd,
        };
      };
    } else if (rest) {
      look = async () => {
        let s: Awaited<ReturnType<typeof rest.status>>;
        try {
          s = await rest.status(sessionId);
        } catch (err) {
          if (err instanceof ToolError && err.code === 'not_found') return undefined;
          throw err;
        }
        const e = s.elicitations[0];
        return {
          busy: s.status === 'running' || s.status === 'pending',
          prompt:
            e &&
            (e.type === 'permission'
              ? { kind: 'permission', text: e.summary ?? '' }
              : { kind: 'question', text: (e.questions ?? []).map((q) => q.question).join(' | ') }),
          target: { kind: 'unknown', id: sessionId },
          computerId: s.computerId,
          title: s.title,
          tags: s.tags,
        };
      };
    } else {
      this.#log(`droid-mcp: ${r.hook_event_name} ring for ${sessionId} not verified: FACTORY_API_KEY is not set and this server does not run the session`);
      await recordEvent(ctx, { sessionId, kind }, false);
      return;
    }

    let view = await look();
    let event: Pick<EventInput, 'kind' | 'text'> | undefined;
    if (r.hook_event_name === 'SessionEnd') {
      event = view && { kind: 'ended' };
    } else if (r.hook_event_name === 'Notification') {
      event = view?.prompt && { kind: view.prompt.kind, text: preview(view.prompt.text, 1000) };
    } else {
      for (let i = 0; view?.busy && i < STOP_RETRIES; i++) {
        await new Promise((resolve) => setTimeout(resolve, this.#retryMs));
        view = await look();
      }
      if (view && !view.busy) event = stopEvent(await resultText(ctx, view.target, view.computerId));
    }
    if (!view || !event) return;
    await recordEvent(ctx, {
      sessionId,
      ...event,
      computerId: view.computerId,
      host: run ? await ctx.computers.thisName() : undefined,
      title: view.title,
      cwd: view.cwd,
      tags: view.tags,
    });
  }
}

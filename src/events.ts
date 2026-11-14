import { z } from 'zod';
import { isSessionId } from './catalog.ts';

export const EVENT_KINDS = ['finished', 'question', 'permission', 'ended'] as const;
export type EventKind = (typeof EVENT_KINDS)[number];
export type DroidEvent = {
  seq: number;
  at: number;
  computer: string;
  sessionId: string;
  kind: EventKind;
  title?: string;
  text?: string;
  cwd?: string;
  tags?: string[];
  forwarded: boolean;
  // For a forwarded event: whether the webhook answered 2xx. 'sending' until it answers or times out.
  delivery?: 'sending' | 'delivered' | 'failed';
};

export const DEBOUNCE_MS = 30_000;
const FORWARD_TIMEOUT_MS = 8000;

const EventBody = z.object({
  computerId: z.string().max(200).optional(),
  host: z.string().max(100).optional(),
  sessionId: z.string().max(200).refine(isSessionId, 'invalid session id'),
  kind: z.enum(EVENT_KINDS),
  title: z.string().max(200).optional(),
  text: z.string().max(1000).optional(),
  cwd: z.string().max(500).optional(),
  tags: z.array(z.string().max(100)).max(20).optional(),
});
export type EventInput = z.infer<typeof EventBody>;

export function parseEventBody(json: unknown): EventInput {
  const r = EventBody.safeParse(json);
  if (!r.success) {
    throw new Error(`invalid event: ${r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ')}`);
  }
  return r.data;
}

export class EventLog {
  #events: DroidEvent[] = [];
  #next = 1;
  #max: number;
  #lastForward = new Map<string, number>();

  constructor(max = 500) {
    this.#max = max;
  }

  add(input: EventInput, opts: { computer: string; forward: boolean; now?: number }): DroidEvent {
    const now = opts.now ?? Date.now();
    const key = `${input.sessionId}:${input.kind}`;
    const last = this.#lastForward.get(key);
    const forwarded = opts.forward && (last === undefined || now - last >= DEBOUNCE_MS);
    if (forwarded) {
      this.#lastForward.set(key, now);
      if (this.#lastForward.size > this.#max) {
        for (const [k, at] of this.#lastForward) if (now - at >= DEBOUNCE_MS) this.#lastForward.delete(k);
      }
    }
    const event: DroidEvent = {
      seq: this.#next++,
      at: now,
      computer: opts.computer,
      sessionId: input.sessionId,
      kind: input.kind,
      title: input.title,
      text: input.text,
      cwd: input.cwd,
      tags: input.tags,
      forwarded,
    };
    this.#events.push(event);
    if (this.#events.length > this.#max) this.#events.splice(0, this.#events.length - this.#max);
    return event;
  }

  // Without `after`, returns the latest `limit` events.
  since(after: number | undefined, limit: number, kinds?: readonly EventKind[]): { events: DroidEvent[]; nextAfter: number; missed: boolean } {
    const newest = this.#next - 1;
    const want = (e: DroidEvent) => !kinds?.length || kinds.includes(e.kind);
    if (after === undefined) {
      return { events: this.#events.filter(want).slice(-limit), nextAfter: newest, missed: false };
    }
    // seq restarts at 1 with the server, so a cursor ahead of the log predates a restart.
    const stale = after > newest;
    if (stale) after = 0;
    const oldest = this.#events[0]?.seq ?? this.#next;
    const events: DroidEvent[] = [];
    for (const e of this.#events) {
      if (e.seq <= after || !want(e)) continue;
      events.push(e);
      if (events.length === limit) break;
    }
    return {
      events,
      nextAfter: events.length === limit ? events[events.length - 1].seq : Math.max(after, newest),
      missed: stale || after < oldest - 1,
    };
  }
}

export function forwardBody(e: DroidEvent) {
  return {
    source: 'droid-mcp',
    seq: e.seq,
    at: new Date(e.at).toISOString(),
    computer: e.computer,
    sessionId: e.sessionId,
    kind: e.kind,
    title: e.title,
    text: e.text,
    cwd: e.cwd,
  };
}

export class Forwarder {
  #url?: string;
  #key?: string;
  #fetch: typeof fetch;
  #log: (msg: string) => void;
  #timeoutMs: number;

  constructor(opts: { url?: string; key?: string; fetch?: typeof fetch; log?: (msg: string) => void; timeoutMs?: number }) {
    this.#url = opts.url || undefined;
    this.#key = opts.key || undefined;
    this.#fetch = opts.fetch ?? globalThis.fetch;
    this.#log = opts.log ?? ((msg) => console.error(msg));
    this.#timeoutMs = opts.timeoutMs ?? FORWARD_TIMEOUT_MS;
  }

  get enabled(): boolean {
    return Boolean(this.#url && this.#key);
  }

  #where(): string {
    try {
      const u = new URL(this.#url!);
      return `${u.origin}${u.pathname}`;
    } catch {
      return 'the webhook';
    }
  }

  async send(e: DroidEvent): Promise<boolean> {
    if (!this.#url || !this.#key) return false;
    try {
      const res = await this.#fetch(this.#url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: `Bearer ${this.#key}`, 'X-Automation-Key': this.#key },
        body: JSON.stringify(forwardBody(e)),
        signal: AbortSignal.timeout(this.#timeoutMs),
        redirect: 'error',
      });
      if (res.ok) return true;
      this.#log(`droid-mcp: forwarding event ${e.seq} to ${this.#where()} failed: HTTP ${res.status}`);
    } catch (err) {
      const msg = (err instanceof Error ? err.message : String(err)).split(this.#key).join('<key>').split(this.#url).join('<url>');
      this.#log(`droid-mcp: forwarding event ${e.seq} to ${this.#where()} failed: ${msg}`);
    }
    return false;
  }
}

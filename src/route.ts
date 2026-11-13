import { isSubagent, type SessionRecord } from './catalog.ts';
import { exceedsCap, type Autonomy } from './config.ts';
import type { OwnRun } from './runs.ts';

export type Target = { kind: 'own'; run: OwnRun } | { kind: 'local'; record: SessionRecord } | { kind: 'unknown'; id: string };
export type Route = { via: 'own' } | { via: 'rest' } | { via: 'local-resume' } | { refused: string };

export const RECENT_MS = 30 * 60 * 1000;

export function routeSend(
  target: Target,
  opts: { restEnabled: boolean; allowLocalResume: boolean; now: number; cap: Autonomy },
): Route {
  if (target.kind === 'own') return { via: 'own' };
  if (opts.restEnabled) return { via: 'rest' };
  if (target.kind === 'unknown') {
    return { refused: `session ${target.id} is not on this machine; sending to it needs FACTORY_API_KEY` };
  }
  const r = target.record;
  if (r.workstream) return { refused: 'workstream sessions need FACTORY_API_KEY; never loaded locally' };
  if (!opts.allowLocalResume) {
    return { refused: 'sending to a local session without FACTORY_API_KEY resumes it in a new droid process; pass allowLocalResume: true to allow that' };
  }
  if (!r.classified) return { refused: 'session settings are unreadable, so it may be a workstream session; not loading it locally' };
  if (r.archived) return { refused: 'session is archived' };
  if (isSubagent(r)) return { refused: 'session is a subagent; send to its parent instead' };
  if (opts.now - r.updatedAt < RECENT_MS) {
    return { refused: 'session was active in the last 30 minutes and may be open in another droid; refusing to load it twice' };
  }
  if (r.autonomy === undefined || exceedsCap(r.autonomy, opts.cap)) {
    return { refused: `session autonomy '${r.autonomy ?? 'unknown'}' exceeds the cap '${opts.cap}'` };
  }
  return { via: 'local-resume' };
}

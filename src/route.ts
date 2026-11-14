import { isSubagent, type SessionRecord } from './catalog.ts';
import { API_KEY_FIX, exceedsCap, Refused, type Autonomy } from './config.ts';
import type { OwnRun } from './runs.ts';

export type Target = { kind: 'own'; run: OwnRun } | { kind: 'local'; record: SessionRecord } | { kind: 'unknown'; id: string };
export type Route = { via: 'own' } | { via: 'rest' } | { via: 'local-resume' } | { refused: Refused };

export const RECENT_MS = 30 * 60 * 1000;

export function routeSend(target: Target, opts: { restEnabled: boolean; allowLocalResume: boolean; now: number; cap: Autonomy }): Route {
  if (target.kind === 'own') return { via: 'own' };
  if (opts.restEnabled) return { via: 'rest' };
  const refuse = (code: Refused['code'], message: string, fix: string) => ({ refused: new Refused(code, message, fix) });
  if (target.kind === 'unknown') {
    return refuse('needs_api_key', `session ${target.id} is not on this machine; sending to it needs FACTORY_API_KEY`, API_KEY_FIX);
  }
  const r = target.record;
  if (r.workstream) return refuse('needs_api_key', 'workstream sessions need FACTORY_API_KEY; never loaded locally', API_KEY_FIX);
  if (!opts.allowLocalResume) {
    return refuse(
      'invalid',
      'sending to a local session without FACTORY_API_KEY resumes it in a new droid process',
      'Pass allowLocalResume: true to allow that.',
    );
  }
  if (!r.classified) {
    return refuse('needs_api_key', 'session settings are unreadable, so it may be a workstream session; not loading it locally', API_KEY_FIX);
  }
  if (r.archived) return refuse('invalid', 'session is archived', 'Start a new session with droid_start.');
  if (isSubagent(r)) return refuse('invalid', 'session is a subagent', 'Send to its parent session instead.');
  if (opts.now - r.updatedAt < RECENT_MS) {
    return refuse(
      'busy',
      'session was active in the last 30 minutes and may be open in another droid; refusing to load it twice',
      'Retry after it has been idle for 30 minutes.',
    );
  }
  if (r.autonomy === undefined || exceedsCap(r.autonomy, opts.cap)) {
    return refuse(
      'invalid',
      `session autonomy '${r.autonomy ?? 'unknown'}' exceeds the cap '${opts.cap}'`,
      'Start a new session within the cap with droid_start.',
    );
  }
  return { via: 'local-resume' };
}

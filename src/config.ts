import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

export type Autonomy = 'off' | 'low' | 'medium' | 'high';

// An error raised before any side effect, so an idempotency key that hit it can safely be retried.
export class Refused extends Error {}
const LEVELS: Autonomy[] = ['off', 'low', 'medium', 'high'];

export function allowedRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.DROID_MCP_ROOTS ?? join(homedir(), 'repos')).split(':').filter(Boolean);
}

export function checkCwd(cwd: string, roots: string[]): string {
  let real: string;
  try {
    real = realpathSync(resolve(cwd));
  } catch {
    throw new Refused(`cwd does not exist: ${cwd}`);
  }
  for (const root of roots) {
    let r: string;
    try {
      r = realpathSync(resolve(root));
    } catch {
      continue;
    }
    if (real === r || real.startsWith(r + sep)) return real;
  }
  throw new Refused(`cwd ${cwd} is outside the allowed roots (${roots.join(':')})`);
}

export function autonomyCap(env: NodeJS.ProcessEnv = process.env): Autonomy {
  const v = env.DROID_MCP_MAX_AUTONOMY;
  if (!v) return 'high';
  return LEVELS.includes(v as Autonomy) ? (v as Autonomy) : 'off';
}

export function exceedsCap(level: string, cap: Autonomy): boolean {
  const i = LEVELS.indexOf(level as Autonomy);
  return i < 0 || i > LEVELS.indexOf(cap);
}

export function resolveAutonomy(requested: Autonomy | undefined, env: NodeJS.ProcessEnv = process.env): Autonomy {
  const level = requested ?? 'off';
  const cap = autonomyCap(env);
  if (exceedsCap(level, cap)) {
    throw new Refused(`autonomy '${level}' exceeds the cap '${cap}' (DROID_MCP_MAX_AUTONOMY)`);
  }
  return level;
}

export async function lookupApiKey(env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  if (env.FACTORY_API_KEY) return env.FACTORY_API_KEY;
  if (process.platform !== 'darwin') return undefined;
  try {
    const { stdout } = await promisify(execFile)('security', ['find-generic-password', '-s', 'droid-mcp', '-a', 'FACTORY_API_KEY', '-w']);
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

// A prompt answer must not widen permissions: "always" options persist approvals beyond this request, and auto-run or
// new-session options are offered only when they name a level within the cap.
export function allowedDecisions(options: string[], cap: Autonomy): string[] {
  return options.filter((o) => {
    if (o === 'proceed_edit' || o === 'proceed_auto_run' || o === 'proceed_new_session' || o.startsWith('proceed_always')) return false;
    const level = /^proceed_(?:auto_run|new_session)_(low|medium|high)$/.exec(o)?.[1];
    return level === undefined || !exceedsCap(level, cap);
  });
}

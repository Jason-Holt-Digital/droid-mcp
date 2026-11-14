import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

export type Autonomy = 'off' | 'low' | 'medium' | 'high';

type ErrorCode = 'computer_offline' | 'needs_api_key' | 'outside_roots' | 'busy' | 'not_found' | 'invalid' | 'internal';

export class ToolError extends Error {
  readonly code: ErrorCode;
  readonly fix: string;

  constructor(code: ErrorCode, message: string, fix: string) {
    super(message);
    this.code = code;
    this.fix = fix;
  }
}

// An error raised before any side effect, so an idempotency key that hit it can safely be retried.
export class Refused extends ToolError {}

export const API_KEY_FIX = "Set FACTORY_API_KEY in the server's environment, or use a session this server started.";
const LEVELS: Autonomy[] = ['off', 'low', 'medium', 'high'];

export function allowedRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.DROID_MCP_ROOTS ?? join(homedir(), 'repos')).split(':').filter(Boolean);
}

export function checkCwd(cwd: string, roots: string[]): string {
  let real: string;
  try {
    real = realpathSync(resolve(cwd));
  } catch {
    throw new Refused('outside_roots', `cwd does not exist: ${cwd}`, 'Pass an existing directory inside the allowed roots.');
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
  throw new Refused('outside_roots', `cwd ${cwd} is outside the allowed roots (${roots.join(':')})`, 'Pass a cwd inside one of the allowed roots.');
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
    throw new Refused('invalid', `autonomy '${level}' exceeds the cap '${cap}' (DROID_MCP_MAX_AUTONOMY)`, `Pass autonomy '${cap}' or lower.`);
  }
  return level;
}

export function lookupApiKey(env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  return lookupSecret('FACTORY_API_KEY', 'FACTORY_API_KEY', env);
}

// The environment wins; on macOS the Keychain service 'droid-mcp' is the fallback.
export async function lookupSecret(envName: string, account: string, env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  if (env[envName]) return env[envName];
  if (process.platform !== 'darwin') return undefined;
  try {
    const { stdout } = await promisify(execFile)('security', ['find-generic-password', '-s', 'droid-mcp', '-a', account, '-w']);
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

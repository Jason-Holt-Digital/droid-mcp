import { Refused } from './config.ts';
import type { Rest } from './rest.ts';

export const DEFAULT_SOURCE = 'Jason-Holt-Digital/droid-mcp';
export const SETUP_TAG = 'droid-mcp-setup';
const SOURCE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(#[A-Za-z0-9_./-]+)?$/;
// Brackets stay allowed for IPv6 hosts; the url is single-quoted in the printf.
const URL_CHARS = /^https?:\/\/[A-Za-z0-9._~:/%@+=,[\]-]+$/;
const COMPUTER_ID = /^[A-Za-z0-9-]+$/;
const DETAIL_MAX = 300;

export type Job = { state: 'working' | 'done' | 'failed'; sessionId?: string; detail: string; at: number };
export type SetupRest = Pick<Rest, 'create' | 'send' | 'status' | 'messages' | 'answer' | 'interrupt' | 'archive'>;

export const pluginSource = (env: NodeJS.ProcessEnv) => env.DROID_MCP_PLUGIN_SOURCE || DEFAULT_SOURCE;

export function installCommands(source: string): string[] {
  const [repo, ref] = source.split('#');
  const marketplace = repo.split('/')[1] + (ref ? `@${ref}` : '');
  return [`droid plugin marketplace add ${source}`, `droid plugin install droid-mcp@${marketplace} --scope user`];
}

export function setupCommands(source: string, url: string, computerId: string): string[] {
  return [...installCommands(source), `printf 'url = "%s"\\nheader = "x-droid-mcp-computer: %s"\\n' '${url}' '${computerId}' > ~/.factory/droid-mcp.curlrc`];
}

export function validateSetup(source: string, url: string, computerId?: string): void {
  if (!SOURCE.test(source)) throw new Refused('invalid', `invalid plugin source: ${source}`, 'Set DROID_MCP_PLUGIN_SOURCE to owner/repo or owner/repo#ref.');
  if (!URL_CHARS.test(url) || !URL.canParse(url)) {
    throw new Refused('invalid', `invalid events url: ${url}`, 'Pass an http(s) URL without quotes, spaces or shell metacharacters.');
  }
  if (computerId !== undefined && !COMPUTER_ID.test(computerId)) {
    throw new Refused('invalid', `invalid computer id: ${computerId}`, 'Pass a computer id from droid_computers.');
  }
}

function prompt(commands: string[]): string {
  return [
    'Run these shell commands exactly as written, one Execute call each, in this order. Do not change, combine or add commands.',
    'When all of them succeed, reply with exactly SETUP-OK. If one fails, stop and reply with its error output.',
    '',
    ...commands.map((c, i) => `${i + 1}. ${c}`),
  ].join('\n');
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Setup {
  #rest: SetupRest;
  #pollMs: number;
  #timeoutMs: number;
  #now: () => number;
  #jobs = new Map<string, Job>();

  constructor(opts: { rest: SetupRest; pollMs?: number; timeoutMs?: number; now?: () => number }) {
    this.#rest = opts.rest;
    this.#pollMs = opts.pollMs ?? 2000;
    this.#timeoutMs = opts.timeoutMs ?? 4 * 60_000;
    this.#now = opts.now ?? Date.now;
  }

  get(computerId: string): Job | undefined {
    return this.#jobs.get(computerId);
  }

  // Resolves once the session exists and has the prompt; the rest of the job runs in the background.
  async start(computerId: string, commands: string[]): Promise<Job> {
    const current = this.#jobs.get(computerId);
    if (current?.state === 'working') return current;
    const job: Job = { state: 'working', detail: 'creating the setup session', at: this.#now() };
    this.#jobs.set(computerId, job);
    try {
      job.sessionId = await this.#rest.create(computerId, {
        model: 'claude-haiku-4-5-20251001',
        autonomyLevel: 'off',
        interactionMode: 'auto',
        tags: [{ name: SETUP_TAG }],
      });
      await this.#rest.send(job.sessionId, prompt(commands), computerId);
      job.detail = 'waiting for the Droid to run the setup commands';
    } catch (err) {
      await this.#finish(job, 'failed', message(err));
      return job;
    }
    void this.#watch(job, job.sessionId, computerId, commands);
    return job;
  }

  async #watch(job: Job, sessionId: string, computerId: string, commands: string[]): Promise<void> {
    const rest = this.#rest;
    const deadline = this.#now() + this.#timeoutMs;
    let approved = 0;
    try {
      while (this.#now() < deadline) {
        const s = await rest.status(sessionId, computerId);
        for (const e of s.elicitations) {
          if (e.type !== 'permission') {
            await rest.answer(sessionId, e.requestId, { cancelled: true });
            return await this.#finish(job, 'failed', 'the Droid asked a question instead of running the setup commands');
          }
          const asked = e.commands ?? [];
          const next = commands.slice(approved, approved + asked.length);
          const odd = (e.tools ?? []).find((t) => t !== 'Execute') ?? asked.find((c, i) => c.trim() !== next[i]);
          if (odd !== undefined || asked.length === 0) {
            await rest.answer(sessionId, e.requestId, { selectedOption: 'cancel' });
            return await this.#finish(job, 'failed', `refused an unexpected command: ${(odd ?? e.summary ?? 'no command').slice(0, DETAIL_MAX)}`);
          }
          await rest.answer(sessionId, e.requestId, { selectedOption: 'proceed_once' });
          approved += asked.length;
        }
        if (s.status === 'idle' && s.elicitations.length === 0) {
          const { messages } = await rest.messages(sessionId, { role: 'assistant', limit: 5, computerId });
          const last = messages.sort((a, b) => b.createdAt - a.createdAt)[0]?.text;
          // Idle with no reply yet means the turn has not started.
          if (last !== undefined) {
            // Approval only let the commands run; success is a reply whose last line is the bare marker.
            const ok = last.trim().split('\n').at(-1)?.trim() === 'SETUP-OK';
            if (approved === commands.length && ok) return await this.#finish(job, 'done', 'plugin installed and curlrc written');
            const detail = ok ? `replied SETUP-OK after ${approved} of ${commands.length} commands` : last;
            return await this.#finish(job, 'failed', detail.slice(0, DETAIL_MAX) || 'the Droid stopped without SETUP-OK');
          }
        }
        await sleep(this.#pollMs);
      }
      await this.#finish(job, 'failed', `timed out after ${Math.round(this.#timeoutMs / 1000)} s`);
    } catch (err) {
      await this.#finish(job, 'failed', message(err));
    }
  }

  async #finish(job: Job, state: 'done' | 'failed', detail: string): Promise<void> {
    Object.assign(job, { state, detail, at: this.#now() });
    if (!job.sessionId) return;
    // A failed job may still have a command running there; stop it before archiving.
    if (state === 'failed') await this.#rest.interrupt(job.sessionId).catch(() => {});
    await this.#rest.archive(job.sessionId).catch(() => {});
  }
}

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { resumeSession } from '@factory/droid-sdk/node';
import { scanSessions, type SessionRecord } from '../src/catalog.ts';
import { parseCustomModels, parseHelp, type ModelCatalog } from '../src/models.ts';
import type { Elicitation } from '../src/rest.ts';
import type { SetupRest } from '../src/setup.ts';

export const FIXTURES = fileURLToPath(new URL('./fixtures/sessions', import.meta.url));

// Skip reason when a command is missing locally. In CI (CI is set) the test runs anyway and fails loudly instead of skipping.
export function needs(cmd: string, args: string[]): string | false {
  if (process.env.CI) return false;
  return spawnSync(cmd, args).error ? `${cmd} not found` : false;
}

export const IDS = {
  liveOrchestrator: '8ddbc264-6932-58f2-a1e8-323e4207e00d',
  liveAgentNewer: '1d7f7142-c851-594a-b695-21038179bfe9',
  liveAgentOlder: 'db9ee7c9-3692-55b6-818a-55dee2d3eb9d',
  archivedOrchestrator: 'a11ff0aa-7866-5530-969f-0ec4491f2224',
  archivedAgentPayment: 'c054d97f-7788-5d18-959e-2cc8ed8a06fa',
  archivedAgentResearch: '0c20addc-ecf3-5dd9-802f-3f04a94e686a',
  missingOrchestrator: '0b691f38-3cb1-510d-ba50-881858f88438',
  orphanAgentA: '9265b020-d83e-5497-86c6-b4669e4879c5',
  orphanAgentB: '97a62cfa-b4ce-547c-8c4a-f155826afb71',
  subagent: 'cf1f5525-259e-574a-b439-3f74668b4e04',
  subagentParent: '900cb9e9-c0e2-5b47-983c-21e67cf0b317',
  missionSubagent: '5ea448f1-be74-5504-86fa-4b05d771c0a0',
  archivedScratch: '10cfe397-bd88-59d2-b89c-c4f79d45bae6',
  liveStandalone: 'aa763cb7-e4cc-5b2b-bced-3ba81a5cfe24',
  archivedService: '07484013-afa4-57cb-82c0-16cbd16d6c2a',
};

const UPDATED = {
  [IDS.liveOrchestrator]: 1000,
  [IDS.liveAgentNewer]: 3000,
  [IDS.liveAgentOlder]: 2000,
  [IDS.archivedOrchestrator]: 500,
  [IDS.archivedAgentPayment]: 400,
  [IDS.archivedAgentResearch]: 9000,
  [IDS.orphanAgentA]: 10_000,
  [IDS.orphanAgentB]: 10_001,
  [IDS.subagent]: 200,
  [IDS.subagentParent]: 100,
  [IDS.missionSubagent]: 300,
  [IDS.archivedScratch]: 50,
  [IDS.liveStandalone]: 8000,
  [IDS.archivedService]: 7000,
};

export async function fixtureRecords(): Promise<SessionRecord[]> {
  const records = await scanSessions(FIXTURES);
  return records.map((r) => ({ ...r, updatedAt: UPDATED[r.id] ?? r.updatedAt }));
}

export type ApiCall = { method: string; path: string; query: URLSearchParams; body: any; signal: AbortSignal };

// Routes Factory API requests to a handler; a returned plain value becomes a JSON 200, undefined a 404.
export function fakeApi(route: (call: ApiCall) => unknown) {
  const calls: ApiCall[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    const text = await req.text();
    const call = { method: req.method, path: url.pathname, query: url.searchParams, body: text ? JSON.parse(text) : undefined, signal: req.signal };
    calls.push(call);
    const out = await route(call);
    if (out instanceof Response) return out;
    if (out === undefined) return Response.json({ status: 404, title: 'Not Found' }, { status: 404 });
    return Response.json(out);
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

export const HELP = readFileSync(new URL('./fixtures/exec-help.txt', import.meta.url), 'utf8');
export const SECRET = 'sk-test-must-not-leak';
export const SETTINGS = {
  customModels: [
    {
      id: 'custom:my-proxy:opus-5-5',
      displayName: 'My proxy: Opus 5.5',
      model: 'claude-opus-5-5',
      provider: 'anthropic',
      baseUrl: 'http://localhost:8080/v1/anthropic?token=abc',
      apiKey: SECRET,
      apiKeyHelper: `echo ${SECRET}`,
      headers: { Authorization: `Bearer ${SECRET}` },
      supportedReasoningEfforts: ['low', 'high'],
      defaultReasoningEffort: 'high',
      maxContextLimit: 200000,
    },
    { displayName: 'no id' },
  ],
};
export const catalog = (): ModelCatalog => ({ ...parseHelp(HELP), custom: parseCustomModels(SETTINGS) });

export type FakeDroid = {
  options: { permissionHandler?: (params: unknown) => Promise<unknown> };
  prompts: string[];
  closed: boolean;
  finish: () => void;
  exit: () => void;
};

// A resumeSession stand-in whose sessions never spawn droid; exit() fires the SDK's dead-transport notification.
// fork() returns the same session, so a fork made through it is driven by the same FakeDroid.
export function fakeResume(fail?: Error) {
  const made: FakeDroid[] = [];
  const resume = async (id: string, options: FakeDroid['options']) => {
    if (fail) throw fail;
    let listener: ((n: Record<string, unknown>) => void) | undefined;
    let end: (err?: Error) => void = () => {};
    const f: FakeDroid & { session: unknown } = {
      options,
      prompts: [],
      closed: false,
      finish: () => end(),
      exit: () => {
        listener?.({ params: { notification: { type: 'error', errorType: 'ProcessExitError', error: { name: 'ProcessExitError', message: 'exited' } } } });
        end(new Error('droid process exited'));
      },
      session: {
        id,
        settings: { autonomyLevel: 'off', tags: [] },
        onNotification: (cb: typeof listener, filter: { type: string }) => {
          if (filter.type === 'error') listener = cb;
          return () => {};
        },
        stream: async function* (prompt: string) {
          f.prompts.push(prompt);
          const err = await new Promise<Error | undefined>((resolve) => (end = resolve));
          if (err) throw err;
          yield* [];
        },
        interrupt: async () => end(),
        close: async () => {
          f.closed = true;
        },
        updateSettings: async () => ({}),
        fork: async () => f.session,
      },
    };
    made.push(f);
    return f.session;
  };
  return { resume: resume as unknown as typeof resumeSession, made };
}

type Step = { status: string; elicitations?: Elicitation[] };

// A Rest stand-in for Setup: status() walks the steps and then repeats the last one.
export function fakeSetupRest(steps: Step[], reply?: string) {
  const calls = {
    created: [] as unknown[],
    sent: [] as string[],
    answers: [] as Array<{ requestId: string; body: unknown }>,
    interrupted: [] as string[],
    archived: [] as string[],
  };
  let i = 0;
  const rest: SetupRest = {
    create: async (computerId, settings) => {
      calls.created.push({ computerId, settings });
      return 'setup-session';
    },
    send: async (_id, text) => {
      calls.sent.push(text);
      return { messageId: 'm1', status: 'running' };
    },
    status: async () => {
      const step = steps[Math.min(i++, steps.length - 1)];
      return { status: step.status, elicitations: step.elicitations ?? [] } as unknown as Awaited<ReturnType<SetupRest['status']>>;
    },
    messages: async () => ({
      messages:
        reply === undefined
          ? []
          : [
              { id: 'a1', role: 'assistant', text: reply, createdAt: 2, seq: 2 },
              { id: 'a0', role: 'assistant', text: 'older', createdAt: 1, seq: 1 },
            ],
      nextCursor: undefined,
    }),
    answer: async (_id, requestId, body) => {
      calls.answers.push({ requestId, body });
    },
    interrupt: async (id) => {
      calls.interrupted.push(id);
    },
    archive: async (id) => {
      calls.archived.push(id);
    },
  };
  return { rest, calls };
}

export const permission = (requestId: string, ...commands: string[]): Elicitation => ({
  requestId,
  type: 'permission',
  options: ['proceed_once', 'cancel'],
  tools: commands.map(() => 'Execute'),
  commands,
});

import {
  answerSessionElicitation,
  createFactoryClient,
  createSession,
  getComputer,
  getMessages,
  getSession,
  interruptSession,
  listChildSessions,
  listComputers,
  listSessionElicitations,
  listSessions,
  postMessage,
  updateSession,
  type AnswerSessionElicitationRequestBody,
  type Client,
  type CreateSessionRequestBody,
} from '@factory/droid-sdk/api';
import type { RemoteSession } from './catalog.ts';
import { ToolError, type ErrorCode } from './config.ts';
import type { RawComputer } from './computers.ts';
import type { RestSessionSettings } from './settings.ts';

type ApiResult<T> = { data?: T; error?: unknown; response?: Response };
export type HttpMethod = Parameters<Client['request']>[0]['method'];
export type RestRequest = { path: Record<string, unknown>; query: Record<string, unknown>; body?: unknown };

const KEY_FIX = 'Check that FACTORY_API_KEY is valid and its account can use the Factory sessions API.';
const BY_STATUS = new Map<number, [ErrorCode, string]>([
  [401, ['needs_api_key', KEY_FIX]],
  [403, ['needs_api_key', KEY_FIX]],
  [404, ['not_found', 'Check the id with droid_sessions or droid_status.']],
  [409, ['busy', 'Check the session with droid_wait, then retry.']],
]);

function unwrap<T>(r: ApiResult<T>, op: string): T {
  if (r.error !== undefined || r.data === undefined) {
    const e = (r.error ?? {}) as { status?: number; title?: string; detail?: string };
    const status = e.status ?? r.response?.status ?? 'error';
    const title = e.title ?? r.response?.statusText ?? 'request failed';
    const message = `Factory API ${op} ${status} ${title}${e.detail ? `: ${e.detail}` : ''}`;
    const known = typeof status === 'number' ? BY_STATUS.get(status) : undefined;
    throw known ? new ToolError(known[0], message, known[1]) : new Error(message);
  }
  return r.data;
}

function textOf(content: Array<{ type: string; text?: string }>): string {
  return content.flatMap((b) => (b.type === 'text' && typeof b.text === 'string' ? [b.text] : [])).join('\n');
}

export type Elicitation = {
  requestId: string;
  type: 'permission' | 'ask-user' | string;
  options?: string[];
  tools?: string[];
  commands?: string[];
  questions?: Array<{ index: number; question: string; options: string[] }>;
  summary?: string;
};

export type Rest = ReturnType<typeof createRest>;

export function createRest(opts: { apiKey: string; fetch?: typeof fetch; baseUrl?: string }) {
  const client = createFactoryClient({ apiKey: opts.apiKey, fetch: opts.fetch, baseUrl: opts.baseUrl });

  async function elicitations(sessionId: string): Promise<Elicitation[]> {
    const data = unwrap(await listSessionElicitations({ client, path: { sessionId } }), 'elicitations');
    return data.elicitations.map((e) =>
      e.type === 'permission'
        ? {
            requestId: e.requestId,
            type: e.type,
            options: e.options.map((o) => o.value),
            tools: e.toolUses.map((t) => t.toolUse.name),
            commands: e.toolUses.flatMap((t) => {
              const command = (t.toolUse.input as { command?: unknown }).command;
              return t.toolUse.name === 'Execute' && typeof command === 'string' ? [command] : [];
            }),
            summary: e.toolUses
              .map((t) => `${t.toolUse.name} ${JSON.stringify(t.toolUse.input)}`)
              .join('; ')
              .slice(0, 400),
          }
        : {
            requestId: e.requestId,
            type: e.type,
            questions: e.questions.map(({ index, question, options }) => ({ index, question, options })),
          },
    );
  }

  return {
    async computers(opts: { signal?: AbortSignal } = {}): Promise<RawComputer[]> {
      const data = unwrap(await listComputers({ client, signal: opts.signal }), 'listComputers');
      return data.computers.map((c) => ({
        id: c.id,
        name: c.name,
        providerType: c.providerType,
        status: c.status,
        providerStatus: c.providerStatus ?? undefined,
        lastSeenAt: c.lastSeenAt,
      }));
    },

    async computer(computerId: string) {
      const c = unwrap(await getComputer({ client, path: { computerId } }), 'getComputer');
      return { providerType: c.providerType, relayClientUrl: c.relayClientUrl };
    },

    // Raw requests carry no security by default, so the bearer scheme is named to send the key.
    async call(method: HttpMethod, url: string, req: RestRequest): Promise<unknown> {
      const r = await client.request({ method, url, ...req, security: [{ type: 'http', scheme: 'bearer' }] });
      return unwrap({ ...r, data: r.data ?? null }, `${method} ${url}`);
    },

    async sessions(
      computerId: string,
      opts: { limit?: number; cursor?: string; signal?: AbortSignal } = {},
    ): Promise<{ sessions: RemoteSession[]; nextCursor?: string }> {
      const data = unwrap(
        await listSessions({ client, query: { limit: opts.limit ?? 100, cursor: opts.cursor, computerId }, signal: opts.signal }),
        'listSessions',
      );
      return {
        sessions: data.sessions.map((s) => ({
          sessionId: s.sessionId,
          parentId: s.parent_session_id,
          title: s.title,
          status: s.status,
          createdAt: s.createdAt,
          updatedAt: s.updatedAt,
          computerId: s.computerId ?? computerId,
          messageCount: s.messageCount,
          tags: s.tags ?? s.sessionSettings?.tags ?? [],
          archived: Boolean(s.sessionSettings?.archivedAt),
        })),
        nextCursor: data.pagination?.nextCursor ?? undefined,
      };
    },

    async create(computerId: string, sessionSettings: NonNullable<CreateSessionRequestBody['sessionSettings']>): Promise<string> {
      return unwrap(await createSession({ client, body: { computerId, sessionSettings } }), 'createSession').sessionId;
    },

    async archive(sessionId: string) {
      unwrap(await updateSession({ client, path: { sessionId }, body: { sessionSettings: { archivedAt: new Date().toISOString() } } }), 'archive');
    },

    async send(sessionId: string, text: string, computerId?: string) {
      const data = unwrap(await postMessage({ client, path: { sessionId }, body: { text, computerId } }), 'postMessage');
      return { messageId: data.messageId, status: data.status };
    },

    async update(sessionId: string, sessionSettings: RestSessionSettings) {
      unwrap(await updateSession({ client, path: { sessionId }, body: { sessionSettings } }), 'updateSession');
    },

    async status(sessionId: string, computerId?: string) {
      const [s, pending] = await Promise.all([
        getSession({ client, path: { sessionId }, query: computerId ? { computerId } : undefined }).then((r) => unwrap(r, 'getSession')),
        elicitations(sessionId),
      ]);
      return {
        sessionId: s.sessionId,
        title: s.title,
        status: s.status,
        messageCount: s.messageCount,
        updatedAt: s.updatedAt,
        computerId: s.computerId,
        tags: (s.tags ?? s.sessionSettings?.tags ?? []).map((t) => t.name),
        elicitations: pending,
      };
    },

    async messages(sessionId: string, query: { limit?: number; cursor?: string; role?: 'user' | 'assistant' | 'tool'; computerId?: string } = {}) {
      const data = unwrap(await getMessages({ client, path: { sessionId }, query }), 'getMessages');
      return {
        messages: data.messages.map((m) => ({
          id: m.id,
          role: m.role,
          text: textOf(m.content as Array<{ type: string; text?: string }>),
          createdAt: m.createdAt,
          seq: m.seq,
        })),
        nextCursor: data.pagination?.nextCursor ?? undefined,
      };
    },

    elicitations,

    async answer(sessionId: string, requestId: string, body: AnswerSessionElicitationRequestBody) {
      unwrap(await answerSessionElicitation({ client, path: { sessionId, requestId }, body }), 'answerElicitation');
    },

    async interrupt(sessionId: string) {
      unwrap(await interruptSession({ client, path: { sessionId } }), 'interrupt');
    },

    async children(sessionId: string) {
      const data = unwrap(await listChildSessions({ client, path: { sessionId }, query: { includeAttention: true } }), 'children');
      return data.sessions.map((c) => ({
        sessionId: c.sessionId,
        title: c.title,
        status: c.status,
        updatedAt: c.updatedAt,
        tags: (c.tags ?? []).map((t) => t.name),
        attention: c.attention ?? null,
        computer: c.computer?.name ?? c.computerId ?? null,
      }));
    },
  };
}

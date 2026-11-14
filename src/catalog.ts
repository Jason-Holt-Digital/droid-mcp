import { execFile } from 'node:child_process';
import { createReadStream, existsSync } from 'node:fs';
import { open, readdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, join, sep } from 'node:path';

export type Listing = {
  id: string;
  title: string;
  cwd?: string;
  createdAt?: number;
  updatedAt: number;
  tags: string[];
  workstream?: { id: string; role: 'orchestrator' | 'agent' };
  parentId?: string;
  archived: boolean;
  computer?: string;
  status?: string;
};
export type SessionRecord = Listing & {
  cwd: string;
  file: string;
  autonomy?: string;
  // False when settings.json could not be read, so whether this is a workstream session is unknown.
  classified: boolean;
  hostId?: string;
};
export type Workstream<T extends Listing = SessionRecord> = { id: string; title?: string; orchestrator?: T; agents: T[] };
// Local sessions group by repo; remote ones have no cwd, so they group by computer.
export type RepoGroup<T extends Listing = SessionRecord> = { repo?: string; computer?: string; sessions: T[] };
export type Catalog<T extends Listing = SessionRecord> = { workstreams: Workstream<T>[]; standalone: RepoGroup<T>[] };
export type TranscriptEntry = { seq: number; role: 'user' | 'assistant'; text: string };

export type Tag = { name: string; metadata?: Record<string, string> };
export type RemoteSession = {
  sessionId: string;
  parentId?: string;
  title?: string;
  status: string;
  createdAt: number;
  updatedAt: number;
  computerId?: string;
  messageCount: number;
  tags: Tag[];
  archived: boolean;
};

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9-]*$/;

export function isSessionId(id: string): boolean {
  return SESSION_ID.test(id);
}

export function isSubagent(r: Listing): boolean {
  if (r.workstream) return false;
  return r.parentId !== undefined || r.tags.includes('subagent') || r.tags.includes('mission-v2-subagent');
}

async function readFirstLine(file: string): Promise<string> {
  const fh = await open(file, 'r');
  try {
    const chunks: Buffer[] = [];
    let pos = 0;
    while (pos < 1 << 20) {
      const buf = Buffer.alloc(64 * 1024);
      const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
      if (bytesRead === 0) break;
      const nl = buf.subarray(0, bytesRead).indexOf(10);
      if (nl >= 0) {
        chunks.push(buf.subarray(0, nl));
        break;
      }
      chunks.push(buf.subarray(0, bytesRead));
      pos += bytesRead;
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    await fh.close();
  }
}

type Settings = { tags?: Tag[]; archivedAt?: string; autonomyLevel?: string };

async function readSettings(file: string): Promise<Settings | undefined> {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return undefined;
  }
}

export async function readRecord(file: string): Promise<SessionRecord | undefined> {
  const [line, st, parsed] = await Promise.all([readFirstLine(file), stat(file), readSettings(file.replace(/\.jsonl$/, '.settings.json'))]);
  const settings: Settings = parsed ?? {};
  let h: Record<string, unknown>;
  try {
    h = JSON.parse(line);
  } catch {
    return undefined;
  }
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
  const id = str(h.id) ?? basename(file, '.jsonl');
  const tags = Array.isArray(settings.tags) ? settings.tags : [];
  const { workstream, parentId } = classifyTags(id, tags, str(h.callingSessionId));
  return {
    id,
    title: str(h.title) ?? '',
    cwd: str(h.cwd) ?? '',
    file,
    createdAt: st.birthtimeMs || undefined,
    updatedAt: st.mtimeMs,
    tags: tags.map((t) => t.name),
    workstream,
    parentId,
    archived: Boolean(settings.archivedAt),
    autonomy: settings.autonomyLevel,
    classified: parsed !== undefined && Array.isArray(settings.tags ?? []),
    hostId: str(h.hostId),
  };
}

export function classifyTags(id: string, tags: Tag[], callingSessionId?: string): Pick<Listing, 'workstream' | 'parentId'> {
  const mv2 = tags.find((t) => t.name === 'mission-v2')?.metadata;
  const workstream =
    mv2?.kind === 'orchestrator'
      ? { id: mv2.missionId ?? id, role: 'orchestrator' as const }
      : mv2?.kind === 'agent' && mv2.missionId
        ? { id: mv2.missionId, role: 'agent' as const }
        : undefined;
  const parentId = workstream ? undefined : (callingSessionId ?? tags.find((t) => t.name === 'subagent')?.metadata?.callingSessionId);
  return { workstream, parentId };
}

export function remoteListing(s: RemoteSession, computer: string): Listing {
  return {
    id: s.sessionId,
    title: s.title ?? '',
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    tags: s.tags.map((t) => t.name),
    ...classifyTags(s.sessionId, s.tags, s.parentId),
    archived: s.archived,
    computer,
    status: s.status,
  };
}

async function sessionDirs(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => join(root, e.name));
  } catch {
    return [];
  }
}

export async function scanSessions(root: string): Promise<SessionRecord[]> {
  const dirs = await sessionDirs(root);
  const listed = await Promise.all(
    dirs.map(async (d) => (await readdir(d).catch(() => [] as string[])).filter((n) => n.endsWith('.jsonl')).map((n) => join(d, n))),
  );
  const files = listed.flat();
  const out: SessionRecord[] = [];
  for (let i = 0; i < files.length; i += 128) {
    const batch = await Promise.all(files.slice(i, i + 128).map((f) => readRecord(f).catch(() => undefined)));
    for (const r of batch) if (r) out.push(r);
  }
  return out;
}

export async function findSession(root: string, id: string): Promise<SessionRecord | undefined> {
  if (!isSessionId(id)) return undefined;
  for (const d of await sessionDirs(root)) {
    const file = join(d, `${id}.jsonl`);
    if (existsSync(file)) return readRecord(file);
  }
  return undefined;
}

export function repoRoot(cwd: string): string {
  let dir = cwd;
  let root = cwd;
  while (dir) {
    if (existsSync(join(dir, '.git'))) {
      root = dir;
      break;
    }
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return root;
}

export function groupCatalog<T extends Listing>(records: T[], opts: { repoOf?: (cwd: string) => string } = {}): Catalog<T> {
  const repoOf = opts.repoOf ?? ((cwd: string) => cwd);
  const byWorkstream = new Map<string, Workstream<T>>();
  const byGroup = new Map<string, RepoGroup<T>>();
  for (const r of records) {
    if (r.workstream) {
      let w = byWorkstream.get(r.workstream.id);
      if (!w) byWorkstream.set(r.workstream.id, (w = { id: r.workstream.id, agents: [] }));
      if (r.workstream.role === 'orchestrator') {
        w.orchestrator = r;
        w.title = r.title;
      } else {
        w.agents.push(r);
      }
    } else {
      const repo = r.cwd === undefined ? undefined : repoOf(r.cwd);
      const computer = r.computer ?? 'unknown';
      const key = repo === undefined ? `computer:${computer}` : `repo:${repo}`;
      const group = byGroup.get(key);
      if (group) group.sessions.push(r);
      else byGroup.set(key, repo === undefined ? { computer, sessions: [r] } : { repo, sessions: [r] });
    }
  }
  const newest = (a: T, b: T) => b.updatedAt - a.updatedAt;
  const latest = (w: Workstream<T>) => Math.max(w.orchestrator?.updatedAt ?? 0, ...w.agents.map((a) => a.updatedAt));
  const workstreams = [...byWorkstream.values()];
  for (const w of workstreams) w.agents.sort(newest);
  workstreams.sort((a, b) => Number(Boolean(b.orchestrator)) - Number(Boolean(a.orchestrator)) || latest(b) - latest(a));
  const standalone = [...byGroup.values()];
  for (const g of standalone) g.sessions.sort(newest);
  standalone.sort((a, b) => b.sessions[0].updatedAt - a.sessions[0].updatedAt);
  return { workstreams, standalone };
}

export type FilterOptions = { query?: string; cwd?: string; includeArchived?: boolean; includeSubagents?: boolean };

export function filterRecords<T extends Listing>(records: T[], opts: FilterOptions): T[] {
  const q = opts.query?.trim().toLowerCase();
  const matches = (r: T) => !q || r.title.toLowerCase().includes(q) || r.id.startsWith(q) || Boolean(r.cwd?.toLowerCase().includes(q));
  const matchedWorkstreams = new Set(records.flatMap((r) => (r.workstream?.role === 'orchestrator' && matches(r) ? [r.workstream.id] : [])));
  const cwd = opts.cwd?.replace(/\/+$/, '');
  return records.filter(
    (r) =>
      (opts.includeArchived || !r.archived) &&
      (opts.includeSubagents || !isSubagent(r)) &&
      (!cwd || (r.cwd !== undefined && (r.cwd === cwd || r.cwd.startsWith(cwd + sep)))) &&
      (matches(r) || (r.workstream !== undefined && matchedWorkstreams.has(r.workstream.id))),
  );
}

export function searchContent(root: string, query: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    execFile('rg', ['-l', '-F', '--max-count', '1', '-g', '*.jsonl', '--', query, root], { timeout: 40_000, maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => {
      if (err && (err as { code?: unknown }).code !== 1) {
        reject(new Error(err.killed ? 'content search timed out after 40 s' : `content search failed: ${err.message}`));
        return;
      }
      const ids = new Set(
        stdout
          .split('\n')
          .filter(Boolean)
          .map((p) => basename(p, '.jsonl')),
      );
      resolve([...ids]);
    });
  });
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b): b is { type: 'text'; text: string } => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n');
}

function parseEntry(line: string, seq: number): TranscriptEntry | undefined {
  if (!line.includes('"type":"message"')) return undefined;
  try {
    const e = JSON.parse(line);
    const role = e.message?.role;
    if (role !== 'user' && role !== 'assistant') return undefined;
    const text = textOf(e.message.content);
    return text ? { seq, role, text } : undefined;
  } catch {
    return undefined;
  }
}

// seq is the byte offset just past the entry's line: pass it back as `from` to read only what came after.
export async function readTranscript(file: string, from = 0): Promise<{ entries: TranscriptEntry[]; end: number }> {
  const entries: TranscriptEntry[] = [];
  let lineStart = from;
  let pending: Buffer[] = [];
  for await (const chunk of createReadStream(file, { start: from }) as AsyncIterable<Buffer>) {
    let i = 0;
    for (let nl = chunk.indexOf(10); nl >= 0; nl = chunk.indexOf(10, i)) {
      pending.push(chunk.subarray(i, nl));
      const line = Buffer.concat(pending);
      lineStart += line.length + 1;
      const entry = parseEntry(line.toString('utf8'), lineStart);
      if (entry) entries.push(entry);
      pending = [];
      i = nl + 1;
    }
    if (i < chunk.length) pending.push(chunk.subarray(i));
  }
  return { entries, end: lineStart };
}

const TAIL_START = 4 << 20;
const TAIL_MAX = 64 << 20;

export async function readTranscriptTail(file: string, want: (entries: TranscriptEntry[]) => boolean): Promise<TranscriptEntry[]> {
  const { size } = await stat(file);
  for (let window = TAIL_START; ; window *= 2) {
    const from = Math.max(0, size - window);
    const { entries } = await readTranscript(file, from);
    // A window that starts mid-line yields an unparseable first line, which parseEntry skips.
    if (from === 0 || window >= TAIL_MAX || want(entries)) return entries;
  }
}

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Refused } from './config.ts';

export type Reasoning = { supported: string[]; default: string };
export type BuiltinModel = { id: string; name: string; isDefault: boolean; deprecated?: true; reasoning?: Reasoning };
export type CustomModel = {
  id: string;
  displayName?: string;
  model?: string;
  provider?: string;
  baseUrlHost?: string;
  supportedReasoningEfforts?: string[];
  defaultReasoningEffort?: string;
  maxContextLimit?: number;
};
export type Help = { defaultModel?: string; builtin: BuiltinModel[]; aliases: string[]; wildcards: string[] };
export type ModelCatalog = Help & { custom: CustomModel[] };

const DEPRECATED = ' [Deprecated]';

function block(lines: string[], heading: string): string[] {
  const start = lines.findIndex((l) => l.trim() === heading);
  if (start < 0) return [];
  const end = lines.findIndex((l, i) => i > start && l.trim() === '');
  return lines.slice(start + 1, end < 0 ? undefined : end);
}

export function parseHelp(text: string): Help {
  const lines = text.split('\n');
  const reasoning = new Map<string, Reasoning>();
  for (const l of block(lines, 'Model details:')) {
    const m = /^\s+- (.+?): supports reasoning: \w+; supported: \[(.*)\]; default: (\S+)/.exec(l);
    if (m) reasoning.set(m[1].replace(DEPRECATED, ''), { supported: m[2].split(/,\s*/).filter(Boolean), default: m[3] });
  }
  const builtin: BuiltinModel[] = [];
  for (const l of block(lines, 'Available Models:')) {
    const m = /^\s+(\S+)\s{2,}(.+?)\s*$/.exec(l);
    if (!m) continue;
    const isDefault = m[2].endsWith(' (default)');
    let name = m[2].replace(/ \(default\)$/, '');
    const deprecated = name.endsWith(DEPRECATED);
    name = name.replace(DEPRECATED, '');
    builtin.push({ id: m[1], name, isDefault, ...(deprecated && { deprecated: true as const }), reasoning: reasoning.get(name) });
  }
  const pinning = block(lines, 'Pinning the Latest Model:');
  const aliases = pinning.flatMap((l) => {
    const m = /^\s+(\S+)-\{([^}]+)\}\s*$/.exec(l);
    return m ? m[2].split(',').map((tier) => `${m[1]}-${tier.trim()}`) : [];
  });
  const wildcards = pinning.flatMap((l) => {
    const listed = /A version wildcard pins one model line instead:\s*(.+)$/.exec(l)?.[1].split(/,\s*/) ?? [];
    return [...listed, ...[...l.matchAll(/\(use (\S+?)\)/g)].map((m) => m[1])];
  });
  const defaultModel = builtin.find((b) => b.isDefault)?.id ?? /-m, --model <id>.*\(default: ([^)]+)\)/.exec(text)?.[1];
  return { defaultModel, builtin, aliases, wildcards };
}

export function parseCustomModels(settings: unknown): CustomModel[] {
  const list = (settings as { customModels?: unknown } | null)?.customModels;
  if (!Array.isArray(list)) return [];
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
  const host = (v: unknown) => {
    try {
      return typeof v === 'string' ? new URL(v).host : undefined;
    } catch {
      return undefined;
    }
  };
  return list.flatMap((e: Record<string, unknown> | null) => {
    if (typeof e?.id !== 'string') return [];
    const efforts = e.supportedReasoningEfforts;
    return [
      {
        id: e.id,
        displayName: str(e.displayName),
        model: str(e.model),
        provider: str(e.provider),
        baseUrlHost: host(e.baseUrl),
        supportedReasoningEfforts: Array.isArray(efforts) && efforts.every((x) => typeof x === 'string') ? efforts : undefined,
        defaultReasoningEffort: str(e.defaultReasoningEffort),
        maxContextLimit: typeof e.maxContextLimit === 'number' ? e.maxContextLimit : undefined,
      },
    ];
  });
}

const HELP_TTL_MS = 60_000;
let helpCache: { at: number; droidPath: string; help: Promise<Help> } | undefined;

function loadHelp(droidPath: string): Promise<Help> {
  if (helpCache && helpCache.droidPath === droidPath && Date.now() - helpCache.at < HELP_TTL_MS) return helpCache.help;
  const help = promisify(execFile)(droidPath, ['exec', '--help'], { timeout: 15_000, maxBuffer: 8 * 1024 * 1024 }).then(({ stdout }) =>
    parseHelp(stdout),
  );
  const entry = { at: Date.now(), droidPath, help };
  helpCache = entry;
  help.catch(() => {
    if (helpCache === entry) helpCache = undefined;
  });
  return help;
}

export async function loadCatalog(
  opts: { droidPath?: string; settingsPath?: string } = {},
): Promise<ModelCatalog> {
  const settingsPath = opts.settingsPath ?? join(homedir(), '.factory', 'settings.json');
  const [help, settings] = await Promise.all([
    loadHelp(opts.droidPath ?? 'droid'),
    readFile(settingsPath, 'utf8').then(JSON.parse, (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return undefined;
      throw new Error(`cannot read ${settingsPath}: ${err.message}`);
    }),
  ]);
  return { ...help, custom: parseCustomModels(settings) };
}

function tokens(id: string): string[] {
  return id.toLowerCase().split(/[-:.]/).filter(Boolean);
}

function closeMatches(id: string, known: string[]): string[] {
  const want = new Set(tokens(id));
  return known
    .map((k) => ({ k, score: tokens(k).filter((t) => want.has(t)).length }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.k.length - b.k.length)
    .slice(0, 5)
    .map((x) => x.k);
}

export function checkModel(id: string, catalog: ModelCatalog): void {
  const known = [...catalog.builtin.map((b) => b.id), ...catalog.custom.map((c) => c.id), ...catalog.aliases, ...catalog.wildcards];
  if (known.includes(id)) return;
  const close = closeMatches(id, known);
  throw new Refused(
    `unknown model '${id}'; ${close.length ? `close matches: ${close.join(', ')}` : 'no close matches'} (call droid_models for the full list)`,
  );
}

export function checkEffort(effort: string, modelId: string, catalog: ModelCatalog): void {
  const supported =
    catalog.builtin.find((b) => b.id === modelId)?.reasoning?.supported ??
    catalog.custom.find((c) => c.id === modelId)?.supportedReasoningEfforts;
  if (supported?.length && !supported.includes(effort)) {
    throw new Refused(`reasoning effort '${effort}' is not supported by ${modelId}; supported: ${supported.join(', ')}`);
  }
}

import { readFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { Refused } from './config.ts';
import type { Rest } from './rest.ts';

export type ComputerState = 'online' | 'paused' | 'offline';
export type Computer = {
  id: string;
  name: string;
  kind: 'own' | 'cloud';
  state: ComputerState;
  lastSeenAt?: number;
  providerStatus?: string;
  thisMachine: boolean;
};
export type RawComputer = {
  id: string;
  name: string;
  providerType: string;
  status?: string;
  providerStatus?: string | null;
  lastSeenAt?: number;
};

export const ONLINE_WINDOW_MS = 5 * 60_000; // >2x the slowest heartbeat gap measured (~150 s)
export const CACHE_MS = 30_000;
const LIST_TIMEOUT_MS = 8000;

export const isoSeconds = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

// The API's `status` stays 'active' for a dead daemon, so liveness comes from the heartbeat or the sandbox state.
export function classifyComputer(raw: RawComputer, now: number, thisId?: string): Computer {
  const kind = raw.providerType === 'byom' ? 'own' : 'cloud';
  const providerStatus = raw.providerStatus ?? undefined;
  let state: ComputerState;
  if (kind === 'cloud' && (raw.providerType === 'e2b' || providerStatus !== undefined)) {
    state = providerStatus === 'running' ? 'online' : providerStatus === 'paused' || providerStatus === 'snapshotting' ? 'paused' : 'offline';
  } else {
    state = raw.lastSeenAt !== undefined && now - raw.lastSeenAt <= ONLINE_WINDOW_MS ? 'online' : 'offline';
  }
  return { id: raw.id, name: raw.name, kind, state, lastSeenAt: raw.lastSeenAt, providerStatus, thisMachine: raw.id === thisId };
}

export function pickComputer(list: Computer[], nameOrId: string): Computer {
  const byId = list.find((c) => c.id === nameOrId);
  if (byId) return byId;
  const wanted = nameOrId.toLowerCase();
  const named = list.filter((c) => c.name.toLowerCase() === wanted);
  if (named.length === 1) return named[0];
  if (named.length > 1) {
    throw new Refused(
      'invalid',
      `computer name ${nameOrId} is ambiguous; pass one of these ids: ${named.map((c) => `${c.id} (${c.state})`).join(', ')}`,
      'Pass the computer id instead of its name.',
    );
  }
  throw new Refused(
    'not_found',
    `no computer named ${nameOrId}; known computers: ${list.map((c) => c.name).join(', ') || 'none'}`,
    'Pass a computer name or id from droid_status.',
  );
}

export function offlineError(c: Computer): Refused {
  const seen = c.lastSeenAt === undefined ? 'never seen' : `daemon last seen ${isoSeconds(c.lastSeenAt)}`;
  return new Refused('computer_offline', `computer ${c.name} is offline (${seen})`, 'Start its daemon, or pick another computer from droid_status.');
}

export class Computers {
  readonly rest?: Rest;
  #file: string;
  #now: () => number;
  #hostname: string;
  #thisId?: Promise<string | undefined>;
  #cache?: { at: number; list: Computer[] };
  #loading?: Promise<Computer[]>;

  constructor(opts: { rest?: Rest; file: string; now?: () => number; hostname?: string }) {
    this.rest = opts.rest;
    this.#file = opts.file;
    this.#now = opts.now ?? Date.now;
    this.#hostname = opts.hostname ?? hostname().replace(/\.local$/, '');
  }

  thisId(): Promise<string | undefined> {
    this.#thisId ??= readFile(this.#file, 'utf8')
      .then((text) => {
        const id = JSON.parse(text)?.computerId;
        return typeof id === 'string' && id ? id : undefined;
      })
      .catch(() => undefined);
    return this.#thisId;
  }

  async list(fresh = false): Promise<Computer[]> {
    if (!fresh && this.#cache && this.#now() - this.#cache.at < CACHE_MS) return this.#cache.list;
    if (!this.#loading) {
      this.#loading = this.#load().finally(() => {
        this.#loading = undefined;
      });
    }
    return this.#loading;
  }

  async #load(): Promise<Computer[]> {
    const thisId = await this.thisId();
    let list: Computer[];
    if (this.rest) {
      const raw = await this.rest.computers({ signal: AbortSignal.timeout(LIST_TIMEOUT_MS) });
      const now = this.#now();
      list = raw.map((c) => classifyComputer(c, now, thisId));
    } else {
      list = [{ id: thisId ?? 'this-machine', name: this.#hostname, kind: 'own', state: 'online', thisMachine: true }];
    }
    this.#cache = { at: this.#now(), list };
    return list;
  }

  async thisName(): Promise<string> {
    try {
      return (await this.list()).find((c) => c.thisMachine)?.name ?? this.#hostname;
    } catch {
      return this.#hostname;
    }
  }

  async resolve(nameOrId: string): Promise<Computer> {
    return pickComputer(await this.list(), nameOrId);
  }

  // Paused cloud computers pass: Factory may resume one that is named explicitly.
  async require(nameOrId: string): Promise<Computer> {
    const c = await this.resolve(nameOrId);
    if (c.state === 'offline') throw offlineError(c);
    return c;
  }
}

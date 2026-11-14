import { readFileSync, statSync } from 'node:fs';
import { isSessionId } from './catalog.ts';
import { writeAtomic } from './runs.ts';

export class Subscriptions {
  #path: string;
  #log: (msg: string) => void;
  #ids = new Set<string>();
  #mtime: number | undefined;
  #saving: Promise<unknown> = Promise.resolve();

  constructor(path: string, log: (msg: string) => void = (msg) => console.error(msg)) {
    this.#path = path;
    this.#log = log;
    this.#reload();
  }

  #reload(): void {
    const mtime = statSync(this.#path, { throwIfNoEntry: false })?.mtimeMs;
    if (mtime === this.#mtime) return;
    this.#mtime = mtime;
    this.#ids = new Set();
    try {
      const { sessions } = JSON.parse(readFileSync(this.#path, 'utf8'));
      if (!Array.isArray(sessions)) throw new Error('expected {"sessions": [...]}');
      this.#ids = new Set(sessions.filter((s) => typeof s === 'string' && isSessionId(s)));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.#log(`droid-mcp: ignoring ${this.#path}, starting with no subscriptions: ${(err as Error).message}`);
      }
    }
  }

  has(id: string): boolean {
    this.#reload();
    return this.#ids.has(id);
  }

  set(id: string, subscribed: boolean): Promise<void> {
    const write = () => {
      this.#reload();
      if (subscribed) this.#ids.add(id);
      else this.#ids.delete(id);
      return writeAtomic(this.#path, JSON.stringify({ sessions: [...this.#ids] }));
    };
    const next = this.#saving.then(write, write);
    this.#saving = next.catch(() => {});
    return next;
  }

  flush(): Promise<unknown> {
    return this.#saving;
  }
}

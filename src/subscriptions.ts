import { readFileSync } from 'node:fs';
import { isSessionId } from './catalog.ts';
import { writeAtomic } from './runs.ts';

export class Subscriptions {
  #path: string;
  #log: (msg: string) => void;
  #ids = new Set<string>();
  // The file text last read, or the read error; unchanged means nothing to reparse or log.
  #seen: string | undefined;
  #saving: Promise<unknown> = Promise.resolve();

  constructor(path: string, log: (msg: string) => void = (msg) => console.error(msg)) {
    this.#path = path;
    this.#log = log;
    this.#reload();
  }

  // Read on every use: the file is tiny, and no stat stamp (mtime, inode, size) reliably tells two quick atomic saves apart.
  #reload(): void {
    let text: string | undefined;
    let error: Error | undefined;
    try {
      text = readFileSync(this.#path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') error = err as Error;
    }
    const seen = error ? `\0${error.message}` : text;
    if (seen === this.#seen) return;
    this.#seen = seen;
    this.#ids = new Set();
    try {
      if (error) throw error;
      if (text === undefined) return;
      const { sessions } = JSON.parse(text);
      if (!Array.isArray(sessions)) throw new Error('expected {"sessions": [...]}');
      this.#ids = new Set(sessions.filter((s) => typeof s === 'string' && isSessionId(s)));
    } catch (err) {
      this.#log(`droid-mcp: ignoring ${this.#path}, starting with no subscriptions: ${(err as Error).message}`);
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

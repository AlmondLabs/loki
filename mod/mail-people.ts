import type { MailPerson } from "../core/frame-types.ts";
import { readJson, writeJsonAtomic } from "./json-file.ts";

/** One person as the file keeps them: the name they last showed, how many messages they were on, and the newest one's time. */
interface Seen {
  name: string;
  count: number;
  last: number;
}

export interface MailPeopleOptions {
  file: string;
  now?: () => Date;
  defer?: (write: () => void) => void;
}

const KEEP = 2000;
export const PEOPLE_SHOWN = 300;
const HALF_LIFE_MS = 30 * 24 * 3600 * 1000;
const WRITE_AFTER_MS = 2000;

export class MailPeople {
  private readonly opts: MailPeopleOptions;
  private data: Map<string, Map<string, Seen>> | null = null;
  private pending = false;

  constructor(opts: MailPeopleOptions) {
    this.opts = opts;
  }

  saw(accountId: string, people: readonly MailPerson[], at: number, own: readonly string[]): void {
    const mine = new Set(own.map((a) => a.toLowerCase()));
    const data = this.load();
    const book = data.get(accountId) ?? new Map<string, Seen>();
    data.set(accountId, book);
    let changed = false;
    for (const p of people) {
      if (mine.has(p.address)) continue;
      const known = book.get(p.address);
      if (known && known.last >= at) {
        if (!known.name && p.name) {
          known.name = p.name;
          changed = true;
        }
        continue;
      }
      book.set(p.address, { name: p.name || known?.name || "", count: (known?.count ?? 0) + 1, last: at });
      changed = true;
    }
    if (!changed) return;
    trim(book);
    this.schedule();
  }

  top(accountId: string, n = PEOPLE_SHOWN): MailPerson[] {
    const book = this.load().get(accountId);
    if (!book) return [];
    const now = (this.opts.now?.() ?? new Date()).getTime();
    return [...book]
      .map(([address, s]) => ({ address, name: s.name, score: s.count * 0.5 ** (Math.max(0, now - s.last) / HALF_LIFE_MS) }))
      .sort((a, b) => b.score - a.score || a.address.localeCompare(b.address))
      .slice(0, n)
      .map(({ name, address }) => ({ name, address }));
  }

  forget(accountId: string): void {
    if (this.load().delete(accountId)) this.schedule();
  }

  flush(): void {
    this.pending = false;
    if (!this.data) return;
    const accounts = Object.fromEntries([...this.data].map(([id, book]) => [id, Object.fromEntries(book)]));
    writeJsonAtomic(this.opts.file, { version: 1, accounts }, { mode: 0o600 });
  }

  private schedule(): void {
    if (this.pending) return;
    this.pending = true;
    const defer =
      this.opts.defer ??
      ((write: () => void) => {
        setTimeout(write, WRITE_AFTER_MS).unref();
      });
    defer(() => this.flush());
  }

  private load(): Map<string, Map<string, Seen>> {
    if (this.data) return this.data;
    const raw = readJson(this.opts.file);
    const accounts = typeof raw === "object" && raw !== null ? (raw as { accounts?: unknown }).accounts : null;
    const data = new Map<string, Map<string, Seen>>();
    if (typeof accounts === "object" && accounts !== null)
      for (const [id, book] of Object.entries(accounts)) {
        if (typeof book !== "object" || book === null) continue;
        const kept = new Map<string, Seen>();
        for (const [address, v] of Object.entries(book as Record<string, unknown>)) {
          const s = typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
          if (typeof s.count === "number" && typeof s.last === "number")
            kept.set(address, { name: typeof s.name === "string" ? s.name : "", count: s.count, last: s.last });
        }
        data.set(id, kept);
      }
    this.data = data;
    return data;
  }
}

function trim(book: Map<string, Seen>): void {
  if (book.size <= KEEP) return;
  const least = [...book].sort((a, b) => a[1].count - b[1].count || a[1].last - b[1].last);
  for (const [address] of least.slice(0, book.size - KEEP)) book.delete(address);
}

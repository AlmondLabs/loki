import type { MailPerson } from "../core/frame-types.ts";
import { readJson, writeJsonAtomic } from "./json-file.ts";

/**
 * The people each Gmail account has mail with (plan 076), for the recipients line's suggestions: everyone in the From,
 * To and Cc of the mail loki already reads, and whoever the person sends to from loki. It is built from headers only,
 * kept in one file on the account's Mac (`state/mail-people.json`), and holds names and addresses, never a token or a
 * word of the mail. Google Contacts would need a second permission; this needs none.
 */

/** One person as the file keeps them: the name they last showed, how many messages they were on, and the newest one's time. */
interface Seen {
  name: string;
  count: number;
  last: number;
}

/** What MailPeople is built from; the clock and the deferred write are injected so tests own them. */
export interface MailPeopleOptions {
  file: string;
  now?: () => Date;
  /** Run a write a moment later, so a batch of threads costs one write; a timer when not given. */
  defer?: (write: () => void) => void;
}

/** The most people kept for one account: the least seen go first past it. */
const KEEP = 2000;
/** How many people the recipients line is given at once. */
export const PEOPLE_SHOWN = 300;
/** Being on a message counts half as much after this long, so the people the person writes with now come first. */
const HALF_LIFE_MS = 30 * 24 * 3600 * 1000;
/** How long a write waits for more of a batch. */
const WRITE_AFTER_MS = 2000;

/** An address header's people, by name and bare address, lower case; a name in quotes keeps what is inside them. */
export function headerPeople(header: string): MailPerson[] {
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  let angle = false;
  for (const ch of header) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === "<") angle = true;
    else if (!quoted && ch === ">") angle = false;
    if (ch === "," && !quoted && !angle) {
      parts.push(current);
      current = "";
    } else current += ch;
  }
  parts.push(current);
  return parts.flatMap((p) => {
    const text = p.replace(/\s+/g, " ").trim();
    const angled = [...text.matchAll(/<([^<>]+)>/g)].at(-1);
    const address = (angled?.[1] ?? text).trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+$/.test(address)) return [];
    const name = angled ? text.slice(0, angled.index).replace(/"/g, "").trim() : "";
    return [{ name: name.toLowerCase() === address ? "" : name, address }];
  });
}

/** The people each account has mail with, ranked by how often and how lately. */
export class MailPeople {
  private readonly opts: MailPeopleOptions;
  private data: Map<string, Map<string, Seen>> | null = null;
  private pending = false;

  constructor(opts: MailPeopleOptions) {
    this.opts = opts;
  }

  /**
   * People seen on one message of an account at a time (ms): each is counted once per newer message, so reading the same
   * thread again counts nobody twice. The person's own addresses are left out.
   */
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

  /** The account's people, the most often and most lately on its mail first. */
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

  /** Forget an account's people, when it is disconnected. */
  forget(accountId: string): void {
    if (this.load().delete(accountId)) this.schedule();
  }

  /** Write what is waiting now. */
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

/** Keep the KEEP people seen most, dropping the least often and longest ago first. */
function trim(book: Map<string, Seen>): void {
  if (book.size <= KEEP) return;
  const least = [...book].sort((a, b) => a[1].count - b[1].count || a[1].last - b[1].last);
  for (const [address] of least.slice(0, book.size - KEEP)) book.delete(address);
}

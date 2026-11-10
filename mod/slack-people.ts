import type { SlackPerson } from "../core/frame-types.ts";
import type { SlackClient, SlackUser } from "./slack.ts";

/**
 * The people in each Slack workspace the person can mention in a reply (plan 082). The reply box suggests them as the
 * person types `@`, and a pick writes their handle (`@ravi.kumar`), which reads as itself in the box and on the phone.
 * When the reply is sent, each `@handle` that names someone in the workspace becomes Slack's mention (`<@U123>`), so
 * Slack tells them; one that names no one stays as typed.
 */

/** An @handle in text: at the start or after anything but a word character, `@` or `.`, so an email address is not one. */
const HANDLE = /(^|[^\w@.])@([a-z0-9][a-z0-9._-]*)/gi;

/** How long a workspace's people are kept before they are read again, so someone who just joined can be mentioned. */
const PEOPLE_TTL_MS = 60 * 60_000;

/** The most pages of people read, 200 a page; a workspace larger than this is searched among the first 10,000. */
const MAX_PAGES = 50;

/** How many people a search gives. */
const SEARCH_LIMIT = 8;

/**
 * Each @handle in the escaped text whose handle is in `mentions` (handle → Slack id), turned into Slack's mention. A
 * handle followed by a full stop or other punctuation is still found: a trailing `.`, `-` or `_` is tried without.
 */
export function withMentions(text: string, mentions: ReadonlyMap<string, string>): string {
  if (mentions.size === 0) return text;
  return text.replace(HANDLE, (whole, before: string, handle: string) => {
    const known = knownHandle(handle, mentions);
    if (!known) return whole;
    return `${before}<@${known.id}>${handle.slice(known.handle.length)}`;
  });
}

/** The longest start of `handle` that is in `mentions`, dropping trailing punctuation one character at a time. */
function knownHandle(handle: string, mentions: ReadonlyMap<string, string>): { handle: string; id: string } | null {
  for (let h = handle.toLowerCase(); h; h = h.slice(0, -1)) {
    const id = mentions.get(h);
    if (id) return { handle: h, id };
    if (!/[._-]$/.test(h)) return null;
  }
  return null;
}

/** Whether text holds an @handle, as `withMentions` reads them. */
export function hasHandles(text: string): boolean {
  return [...text.matchAll(HANDLE)].length > 0;
}

/** How well a person's handle and names match a query: 0 best, null not at all. */
function rank(p: SlackPerson, q: string): number | null {
  const handle = p.handle.toLowerCase();
  const name = p.name.toLowerCase();
  if (handle === q || name === q) return 0;
  if (handle.startsWith(q) || name.startsWith(q)) return 1;
  if (name.split(/\s+/).some((w) => w.startsWith(q)) || handle.split(/[._-]/).some((w) => w.startsWith(q))) return 2;
  if (handle.includes(q) || name.includes(q)) return 3;
  return null;
}

/** The people whose handle or name holds `query`, best matches first, then by name; an empty query matches no one. */
export function searchPeople(people: readonly SlackPerson[], query: string, limit = SEARCH_LIMIT): SlackPerson[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const ranked: Array<{ p: SlackPerson; r: number }> = [];
  for (const p of people) {
    const r = rank(p, q);
    if (r !== null) ranked.push({ p, r });
  }
  ranked.sort((a, b) => a.r - b.r || a.p.name.localeCompare(b.p.name));
  return ranked.slice(0, limit).map((x) => x.p);
}

/** A workspace member as a person to mention; a bot, or someone with no handle, is no one to mention. */
function personOf(u: SlackUser): SlackPerson | null {
  if (u.is_bot || !u.name) return null;
  return { id: u.id, handle: u.name, name: u.display_name || u.real_name || u.name, avatar: u.image || null };
}

/** Reads a workspace's people; the account's Slack client in loki, a fake in tests. */
type PeopleClient = Pick<SlackClient, "usersList">;

/** Each workspace's people, read once an hour at most and only when a reply asks. */
export class SlackPeople {
  private readonly client: (accountId: string) => PeopleClient;
  private readonly now: () => number;
  private readonly read = new Map<string, { at: number; people: Promise<SlackPerson[]> }>();

  constructor(opts: { client: (accountId: string) => PeopleClient; now?: () => number }) {
    this.client = opts.client;
    this.now = opts.now ?? Date.now;
  }

  /** The people in the account's workspace whose handle or name holds `query`, for the reply box's suggestions. */
  async search(accountId: string, query: string): Promise<SlackPerson[]> {
    return searchPeople(await this.people(accountId), query);
  }

  /** Each handle in the workspace to its Slack id, read only when `text` holds an @handle, for sending. */
  async mentions(accountId: string, text: string): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (!hasHandles(text)) return out;
    for (const p of await this.people(accountId)) out.set(p.handle.toLowerCase(), p.id);
    return out;
  }

  /** The workspace's people, read again once they are an hour old; a read that fails is tried again next time. */
  private people(accountId: string): Promise<SlackPerson[]> {
    const had = this.read.get(accountId);
    if (had && this.now() - had.at < PEOPLE_TTL_MS) return had.people;
    const people = this.readAll(accountId).catch((err: unknown) => {
      this.read.delete(accountId);
      throw err;
    });
    this.read.set(accountId, { at: this.now(), people });
    return people;
  }

  private async readAll(accountId: string): Promise<SlackPerson[]> {
    const client = this.client(accountId);
    const out: SlackPerson[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      // Each page names the next, so they are read one after another.
      const r = await client.usersList(cursor);
      for (const u of r.users) {
        const p = personOf(u);
        if (p) out.push(p);
      }
      cursor = r.next_cursor;
      if (!cursor) break;
    }
    return out;
  }
}

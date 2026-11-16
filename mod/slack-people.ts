import type { SlackPerson } from "../core/frame-types.ts";
import type { SlackClient, SlackUser } from "./slack.ts";

const PEOPLE_TTL_MS = 60 * 60_000;

const MAX_PAGES = 50;

const SEARCH_LIMIT = 8;

export interface SlackMember extends SlackPerson {
  real_name: string;
  display_name: string;
}

const namesOf = (p: SlackPerson): string[] => {
  const extra = "real_name" in p && "display_name" in p ? [String(p.real_name), String(p.display_name)] : [];
  return [...new Set([p.name, ...extra].map((n) => n.toLowerCase()).filter(Boolean))];
};

function rank(p: SlackPerson, q: string): number | null {
  const handle = p.handle.toLowerCase();
  const names = namesOf(p);
  if (handle === q || names.includes(q)) return 0;
  if (handle.startsWith(q) || names.some((n) => n.startsWith(q))) return 1;
  if (names.some((n) => n.split(/\s+/).some((w) => w.startsWith(q))) || handle.split(/[._-]/).some((w) => w.startsWith(q))) return 2;
  if (handle.includes(q) || names.some((n) => n.includes(q))) return 3;
  return null;
}

export function searchPeople<P extends SlackPerson>(people: readonly P[], query: string, limit = SEARCH_LIMIT): P[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const ranked: Array<{ p: P; r: number }> = [];
  for (const p of people) {
    const r = rank(p, q);
    if (r !== null) ranked.push({ p, r });
  }
  ranked.sort((a, b) => a.r - b.r || a.p.name.localeCompare(b.p.name));
  return ranked.slice(0, limit).map((x) => x.p);
}

function memberOf(u: SlackUser): SlackMember | null {
  if (u.is_bot || !u.name) return null;
  return {
    id: u.id,
    handle: u.name,
    name: u.display_name || u.real_name || u.name,
    avatar: u.image || null,
    real_name: u.real_name,
    display_name: u.display_name,
  };
}

const personOf = (m: SlackMember): SlackPerson => ({ id: m.id, handle: m.handle, name: m.name, avatar: m.avatar });

type PeopleClient = Pick<SlackClient, "usersList">;

export class SlackPeople {
  private readonly client: (accountId: string) => PeopleClient;
  private readonly now: () => number;
  private readonly read = new Map<string, { at: number; people: Promise<SlackMember[]> }>();

  constructor(opts: { client: (accountId: string) => PeopleClient; now?: () => number }) {
    this.client = opts.client;
    this.now = opts.now ?? Date.now;
  }

  async search(accountId: string, query: string): Promise<SlackPerson[]> {
    return searchPeople(await this.people(accountId), query).map(personOf);
  }

  members(accountId: string): Promise<SlackMember[]> {
    return this.people(accountId);
  }

  private people(accountId: string): Promise<SlackMember[]> {
    const had = this.read.get(accountId);
    if (had && this.now() - had.at < PEOPLE_TTL_MS) return had.people;
    const people = this.readAll(accountId).catch((err: unknown) => {
      this.read.delete(accountId);
      throw err;
    });
    this.read.set(accountId, { at: this.now(), people });
    return people;
  }

  private async readAll(accountId: string): Promise<SlackMember[]> {
    const client = this.client(accountId);
    const out: SlackMember[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const r = await client.usersList(cursor);
      for (const u of r.users) {
        const p = memberOf(u);
        if (p) out.push(p);
      }
      cursor = r.next_cursor;
      if (!cursor) break;
    }
    return out;
  }
}

const MEMBERS_TTL_MS = 5 * 60_000;

type MembersClient = Pick<SlackClient, "conversationsMembers">;

export class ChannelMembers {
  private readonly client: (accountId: string) => MembersClient;
  private readonly now: () => number;
  private readonly read = new Map<string, { at: number; members: Promise<Set<string>> }>();

  constructor(opts: { client: (accountId: string) => MembersClient; now?: () => number }) {
    this.client = opts.client;
    this.now = opts.now ?? Date.now;
  }

  of(accountId: string, channel: string): Promise<Set<string>> {
    const key = `${accountId}\n${channel}`;
    const had = this.read.get(key);
    if (had && this.now() - had.at < MEMBERS_TTL_MS) return had.members;
    const members = this.readAll(accountId, channel).catch((err: unknown) => {
      this.read.delete(key);
      throw err;
    });
    this.read.set(key, { at: this.now(), members });
    return members;
  }

  private async readAll(accountId: string, channel: string): Promise<Set<string>> {
    const client = this.client(accountId);
    const ids = new Set<string>();
    let cursor: string | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const r = await client.conversationsMembers(channel, cursor);
      for (const id of r.members) ids.add(id);
      cursor = r.next_cursor;
      if (!cursor) break;
    }
    return ids;
  }
}

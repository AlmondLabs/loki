import type { GoogleContactSource } from "../core/frame-types.ts";
import type { Accounts } from "./accounts.ts";
import type { GoogleApp } from "./google-app.ts";
import { GoogleAuth } from "./google-auth.ts";

/**
 * A thin client for Google's People API for one Gmail account (plan 2026-11-14-1530, U2, KTD4): it searches the
 * account's saved contacts, its other contacts (people it has mailed) and, on a Workspace account, its organisation's
 * directory, so an agent's `@Ana` finds the address Gmail's own `@` would. It only reads, under the read-only scopes
 * the account granted at sign-in, through the account's shared sign-in (mod/google-auth.ts).
 */

const API = "https://people.googleapis.com/v1";
/** The most results Google gives a contacts or other contacts search in one call. */
const PAGE_SIZE = "30";
/** What each person is read with: other contacts answer only names and addresses, the rest a title too. */
const CONTACT_FIELDS = "names,emailAddresses,organizations";
const OTHER_FIELDS = "names,emailAddresses";

/** Someone found in one of the account's places: the name Google shows, every address, and their title when known. */
export interface GoogleContact {
  name: string;
  addresses: string[];
  title: string | null;
  source: GoogleContactSource;
}

/** What GooglePeople is built from; fetch and the clock are injected so tests own them. */
export interface GooglePeopleOptions {
  accounts: Accounts;
  account_id: string;
  /** The account's sign-in, shared with its Gmail client and Google tools; one of its own is made when left out. */
  auth?: GoogleAuth;
  /** The app to refresh with when the account was signed in with the shared one (SHARED_GOOGLE_APP). */
  sharedApp?: GoogleApp;
  fetch?: typeof fetch;
  now?: () => Date;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const list = (v: unknown): unknown[] => (Array.isArray(v) ? (v as unknown[]) : []);
const rec = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {});

/** A People API person as loki reads it, or null when it has no address to write to. */
function contactOf(v: unknown, source: GoogleContactSource): GoogleContact | null {
  const p = rec(v);
  const addresses = list(p.emailAddresses)
    .map((e) => str(rec(e).value).trim().toLowerCase())
    .filter(Boolean);
  if (addresses.length === 0) return null;
  const name = list(p.names)
    .map((n) => str(rec(n).displayName).trim())
    .find(Boolean);
  const title = list(p.organizations)
    .map((o) => str(rec(o).title).trim())
    .find(Boolean);
  return { name: name ?? "", addresses: [...new Set(addresses)], title: title ?? null, source };
}

/** One Gmail account's People API searches. */
export class GooglePeople {
  private readonly auth: GoogleAuth;
  /** The searches already warmed for this client, since Google answers a cold one from a stale cache. */
  private readonly warmed = new Set<GoogleContactSource>();

  constructor(opts: GooglePeopleOptions) {
    this.auth = opts.auth ?? new GoogleAuth(opts);
  }

  /** The account's saved contacts whose names or addresses start with `query`. */
  searchContacts(query: string): Promise<GoogleContact[]> {
    return this.search("contacts", "/people:searchContacts", CONTACT_FIELDS, query, (r) => list(r.results).map((x) => rec(x).person));
  }

  /** The people the account has mailed without saving them, whose names or addresses start with `query`. */
  searchOtherContacts(query: string): Promise<GoogleContact[]> {
    return this.search("other_contacts", "/otherContacts:search", OTHER_FIELDS, query, (r) => list(r.results).map((x) => rec(x).person));
  }

  /**
   * The people in the account's organisation's directory matching `query`, from their profiles and the domain's shared
   * contacts. A personal account has no directory, and Google refuses the call: the caller treats that as nobody.
   */
  async searchDirectory(query: string): Promise<GoogleContact[]> {
    if (!query.trim()) return [];
    const r = rec(
      await this.auth.json({
        service: "contacts",
        method: "GET",
        url: `${API}/people:searchDirectoryPeople`,
        query: {
          query,
          readMask: CONTACT_FIELDS,
          sources: "DIRECTORY_SOURCE_TYPE_DOMAIN_PROFILE",
          pageSize: PAGE_SIZE,
        },
      }),
    );
    return list(r.people).flatMap((p) => contactOf(p, "directory") ?? []);
  }

  /**
   * One contacts search. Google asks that each of these searches be sent once with an empty query before it is used,
   * so its cache is filled; without that, the first real search may find nobody. That warm-up is made once per client.
   */
  private async search(
    source: GoogleContactSource,
    path: string,
    readMask: string,
    query: string,
    people: (answer: Record<string, unknown>) => unknown[],
  ): Promise<GoogleContact[]> {
    if (!query.trim()) return [];
    const call = (q: string) =>
      this.auth.json({ service: "contacts", method: "GET", url: `${API}${path}`, query: { query: q, readMask, pageSize: PAGE_SIZE } });
    if (!this.warmed.has(source)) {
      await call("");
      this.warmed.add(source);
    }
    return people(rec(await call(query))).flatMap((p) => contactOf(p, source) ?? []);
  }
}

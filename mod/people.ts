import type { GoogleContactSource } from "../core/frame-types.ts";
import { inert } from "./account-ops/fence.ts";
import { accountLabel, contactsOf, type AccountRecord, type Accounts } from "./accounts.ts";
import type { GoogleContact, GooglePeople } from "./google-people.ts";
import type { JiraClient, JiraUser, JiraUserScope } from "./jira.ts";
import { searchPeople, type SlackMember, type SlackPeople } from "./slack-people.ts";

/**
 * Finding people in an agent's accounts by what an agent or the person writes (plan 2026-11-14-1530, U2, KTD4): a
 * full name, a first name, an address, a Slack handle, or the token a refusal gave. One resolver serves the propose
 * tools' mentions and assignees, the card's `@` picker and the script tool `people_find`, so they never disagree.
 *
 * Each service is searched where its own `@` would look: Slack the workspace (the hour-long people cache of
 * mod/slack-people.ts), Jira the people who can see the ticket (or browse the project, or take it as assignee), and
 * Gmail the account's contacts, other contacts and directory through the People API, each only when the account
 * granted it. A name resolves only when exactly one person matches it; otherwise the words say who matched, each with
 * a token to write back, so the agent can ask the person which one they mean (R13).
 */

/** A person a name resolved to: the full name the service shows, and Slack's or Jira's id for them, or their address. */
export type ResolvedPerson =
  | { provider: "slack"; display: string; id: string }
  | { provider: "jira"; display: string; id: string }
  | { provider: "gmail"; display: string; address: string };

/**
 * A person a search found: who they resolve to, the token that names exactly them when written back (a Slack handle,
 * a Jira account id, an address), and one detail that tells them apart (an address, a title, a chosen name), or null.
 */
export type FoundPerson = ResolvedPerson & { token: string; detail: string | null };

/** How a name resolved: to one person, or not, with the words that say why (which name the people who matched). */
export type PersonResolution = { ok: true; person: ResolvedPerson } | { ok: false; why: string };

/** What a search found, and a line to show beside it when the account cannot search by name at all; null when it can. */
export interface PeopleFound {
  people: FoundPerson[];
  notice: string | null;
}

/** Where a Jira account looks: the people who can see a ticket, browse a project, or be assigned; the site when left out. */
export interface PeopleOptions {
  jira?: JiraUserScope;
}

/** What People reads: the accounts, each Slack workspace's people, and each Jira and Gmail account's searches. */
export interface PeopleDeps {
  accounts: Pick<Accounts, "get">;
  slack: Pick<SlackPeople, "members">;
  jira: (accountId: string) => Pick<JiraClient, "searchUsers">;
  google: (accountId: string) => Pick<GooglePeople, "searchContacts" | "searchOtherContacts" | "searchDirectory">;
}

/** How many of the people who matched a refusal lists before "and N more". */
const LISTED = 8;

/** Something that looks like an email address, which Gmail can write to whether or not anyone knows it. */
const ADDRESS = /^[^\s@<>()",;]+@[^\s@<>()",;]+\.[^\s@<>()",;]+$/;

/** Something that may be a Jira account id: one word with a digit, as `5b10ac8d82e05b22cc7d4ef5` or `557058:f58131cb-…`. */
const MAYBE_JIRA_ID = /^(?=.*\d)[\w:-]+$/;

/** A person as a match is made against them: every exact name they go by, and each first name, in lower case. */
interface Candidate {
  person: FoundPerson;
  keys: string[];
  first: string[];
}

/** A name as it is compared: without a leading `@`, its spaces folded, in lower case. */
const normal = (name: string): string => name.trim().replace(/^@/, "").replace(/\s+/g, " ").toLowerCase();

/** The words a name as written is searched for with: as typed, without a leading `@` or extra spaces. */
const asWritten = (name: string): string => name.trim().replace(/^@/, "").replace(/\s+/g, " ");

const firstWord = (name: string): string => name.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
const lower = (values: readonly string[]): string[] => [...new Set(values.map((v) => v.trim().toLowerCase()).filter(Boolean))];

/**
 * The people a name matches (R13): exactly, on a full name, an address, a handle or a token; failing that, a single
 * word matches everyone who has it as a first name. An exact match wins over first names, so `@vivek` written as a
 * handle names its owner even when someone else is also called Vivek. Each person is listed once.
 */
export function matchPeople(
  candidates: ReadonlyArray<{ person: FoundPerson; keys: readonly string[]; first: readonly string[] }>,
  name: string,
): FoundPerson[] {
  const q = normal(name);
  if (!q) return [];
  const exact = candidates.filter((c) => c.keys.includes(q));
  const found = exact.length > 0 ? exact : q.includes(" ") ? [] : candidates.filter((c) => c.first.includes(q));
  const seen = new Set<string>();
  return found.flatMap((c) => (seen.has(c.person.token) ? [] : (seen.add(c.person.token), [c.person])));
}

/** One person as a refusal lists them: name, token, and detail when there is one, each made inert for the model. */
const listed = (p: FoundPerson): string => {
  const said = [p.token, ...(p.detail && p.detail !== p.token ? [p.detail] : [])].map(inert).join(", ");
  return `${inert(p.display)} (${said})`;
};

/** The refusal for a name that several people match: up to LISTED of them, then how many more. */
function several(name: string, where: string, people: readonly FoundPerson[]): string {
  const shown = people.slice(0, LISTED).map(listed).join("; ");
  const more = people.length > LISTED ? `; and ${people.length - LISTED} more` : "";
  return `"${inert(asWritten(name))}" matches ${people.length} people ${where}: ${shown}${more}. Ask the person which one they mean, then name them by their token or full name`;
}

/** The refusal for a name nobody matches. */
const nobody = (name: string, where: string): string => `nobody ${where} matched "${inert(asWritten(name))}"`;

/** A list of names for a sentence: "a", "a and b", "a, b and c". */
function names(people: readonly FoundPerson[]): string {
  const all = people.map((p) => inert(p.display));
  return all.length < 2 ? all.join("") : `${all.slice(0, -1).join(", ")} and ${all.at(-1) ?? ""}`;
}

/** Where a Jira search looked, for its refusals. */
function jiraWhere(site: string, scope: JiraUserScope): string {
  switch (scope.kind) {
    case "site":
      return `on ${site}`;
    case "ticket":
      return `on ${site} who can see ${scope.ticket}`;
    case "project":
      return `on ${site} who can see project ${scope.project}`;
    case "assignee":
      return "ticket" in scope ? `on ${site} who can be assigned ${scope.ticket}` : `on ${site} who can be assigned tickets in ${scope.project}`;
  }
}

/** What people found on the site but outside a search's scope cannot do, for the refusal that names them. */
function jiraCannot(scope: Exclude<JiraUserScope, { kind: "site" }>): string {
  switch (scope.kind) {
    case "ticket":
      return `cannot see ${scope.ticket}`;
    case "project":
      return `cannot see project ${scope.project}`;
    case "assignee":
      return "ticket" in scope ? `cannot be assigned ${scope.ticket}` : `cannot be assigned tickets in ${scope.project}`;
  }
}

/** The words for a Gmail account that has not let loki find people by name (R15). */
export const reconnectForPeople = (address: string): string => `reconnect ${address} in Preferences › Accounts to find people by name`;

/** A Slack member as a candidate: their full name shown, their handle as the token, the name they chose as the detail. */
function slackCandidate(m: SlackMember): Candidate {
  const display = m.real_name || m.display_name || m.handle;
  const detail = m.display_name && m.display_name.toLowerCase() !== display.toLowerCase() ? m.display_name : null;
  return {
    person: { provider: "slack", display, id: m.id, token: m.handle, detail },
    keys: lower([m.real_name, m.display_name, m.handle, m.id]),
    first: lower([firstWord(m.real_name), firstWord(m.display_name)]),
  };
}

/** A Jira user as a candidate: their name, their account id as the token, their address as the detail when Jira shares it. */
function jiraCandidate(u: JiraUser): Candidate {
  const display = u.display_name || u.account_id;
  return {
    person: { provider: "jira", display, id: u.account_id, token: u.account_id, detail: u.email },
    keys: lower([u.display_name, u.account_id, u.email ?? ""]),
    first: lower([firstWord(u.display_name)]),
  };
}

/** Each address of a contact as a candidate of its own, since a mention needs one address to copy in. */
function gmailCandidates(c: GoogleContact): Candidate[] {
  return c.addresses.map((address) => ({
    person: { provider: "gmail", display: c.name || address, address, token: address, detail: c.title },
    keys: lower([c.name, address]),
    first: lower([firstWord(c.name)]),
  }));
}

/** The people in an agent's accounts, found by name. */
export class People {
  private readonly deps: PeopleDeps;

  constructor(deps: PeopleDeps) {
    this.deps = deps;
  }

  /**
   * The one person `name` names in the account (R13, R14, R16), or why it names nobody or several. For Jira, `jira`
   * says whose names count: a mention on a ticket looks among those who can see it, and someone on the site who
   * cannot is refused as such. For Gmail, a full address resolves even when no contact has it, and a name needs the
   * contacts grant (R15). A search the service fails throws, since that says nothing about the name.
   */
  async resolve(accountId: string, name: string, opts: PeopleOptions = {}): Promise<PersonResolution> {
    const account = this.account(accountId);
    if (!normal(name)) return { ok: false, why: "an empty name names nobody" };
    switch (account.provider) {
      case "slack":
        return this.pick(name, `in ${inert(accountLabel(account))}`, (await this.deps.slack.members(accountId)).map(slackCandidate));
      case "jira":
        return this.resolveJira(account, name, opts.jira ?? { kind: "site" });
      case "gmail":
        return this.resolveGmail(account, name);
    }
  }

  /**
   * The people whose names start with or hold `query`, for the card's picker and `people_find`, best matches first
   * where the service ranks them. A Gmail account without the contacts grant finds an address as itself and nobody
   * by name, and says how to fix that in `notice`.
   */
  async find(accountId: string, query: string, opts: PeopleOptions = {}): Promise<PeopleFound> {
    const account = this.account(accountId);
    const q = asWritten(query);
    if (!q) return { people: [], notice: null };
    switch (account.provider) {
      case "slack": {
        const members = await this.deps.slack.members(accountId);
        return { people: searchPeople(members, q, members.length).map((m) => slackCandidate(m).person), notice: null };
      }
      case "jira":
        return { people: (await this.jiraSearch(account, opts.jira ?? { kind: "site" }, q)).map((c) => c.person), notice: null };
      case "gmail": {
        const asAddress = ADDRESS.test(q) ? [this.addressOnly(q)] : [];
        if (contactsOf(account).length === 0) return { people: asAddress, notice: reconnectForPeople(account.address) };
        const found = (await this.gmailSearch(account, q)).map((c) => c.person);
        return { people: found.length === 0 ? asAddress : found, notice: null };
      }
    }
  }

  private account(accountId: string): AccountRecord {
    const account = this.deps.accounts.get(accountId);
    if (!account) throw new Error("that account is not connected on this Mac");
    return account;
  }

  /** The one candidate a name matches, or the refusal that lists who matched or says nobody did. */
  private pick(name: string, where: string, candidates: readonly Candidate[]): PersonResolution {
    const found = matchPeople(candidates, name);
    if (found.length === 1) return { ok: true, person: resolvedOf(found[0]) };
    return { ok: false, why: found.length === 0 ? nobody(name, where) : several(name, where, found) };
  }

  private async resolveJira(account: AccountRecord, name: string, scope: JiraUserScope): Promise<PersonResolution> {
    const where = jiraWhere(inert(account.address), scope);
    const written = asWritten(name);
    const inScope = await this.jiraSearch(account, scope, written);
    if (scope.kind === "site" || matchPeople(inScope, name).length > 0) return this.pick(name, where, inScope);
    // Nobody who can see the ticket matched: someone elsewhere on the site may, and Jira would not tell them.
    const elsewhere = matchPeople(await this.jiraSearch(account, { kind: "site" }, written), name);
    return { ok: false, why: elsewhere.length === 0 ? nobody(name, where) : `${names(elsewhere)} ${jiraCannot(scope)}` };
  }

  /** A Jira search by name or address, and by account id too when what was written could be one. */
  private async jiraSearch(account: AccountRecord, scope: JiraUserScope, written: string): Promise<Candidate[]> {
    const client = this.deps.jira(account.account_id);
    const byName = await client.searchUsers(scope, { query: written });
    const byId = MAYBE_JIRA_ID.test(written) ? await client.searchUsers(scope, { account_id: written }) : [];
    return [...byName, ...byId].map(jiraCandidate);
  }

  private async resolveGmail(account: AccountRecord, name: string): Promise<PersonResolution> {
    const written = asWritten(name);
    if (ADDRESS.test(written)) {
      // An address is enough to write to: a contact only lends its name, so a search that fails changes nothing.
      const address = written.toLowerCase();
      if (contactsOf(account).length === 0) return { ok: true, person: resolvedOf(this.addressOnly(address)) };
      const known = await this.gmailSearch(account, address).catch(() => []);
      return { ok: true, person: resolvedOf(known.find((c) => c.person.token === address)?.person ?? this.addressOnly(address)) };
    }
    if (contactsOf(account).length === 0) return { ok: false, why: reconnectForPeople(account.address) };
    return this.pick(name, `in ${inert(account.address)}'s contacts`, await this.gmailSearch(account, written));
  }

  /**
   * Every granted place searched for `written`, merged by address: a person in both the directory and other contacts
   * is one person, with the first name and title any place gives. A directory that fails (a personal account has
   * none, or the organisation does not share it) counts as nobody there.
   */
  private async gmailSearch(account: AccountRecord, written: string): Promise<Candidate[]> {
    const google = this.deps.google(account.account_id);
    const granted = new Set<GoogleContactSource>(contactsOf(account));
    const [contacts, directory, other] = await Promise.all([
      granted.has("contacts") ? google.searchContacts(written) : [],
      granted.has("directory") ? google.searchDirectory(written).catch(() => []) : [],
      granted.has("other_contacts") ? google.searchOtherContacts(written) : [],
    ]);
    const byAddress = new Map<string, Candidate>();
    for (const c of [...contacts, ...directory, ...other].flatMap(gmailCandidates)) {
      const had = byAddress.get(c.person.token);
      if (!had) {
        byAddress.set(c.person.token, c);
        continue;
      }
      const display = had.person.display !== had.person.token ? had.person.display : c.person.display;
      byAddress.set(c.person.token, {
        person: { ...had.person, display, detail: had.person.detail ?? c.person.detail },
        keys: lower([...had.keys, ...c.keys]),
        first: lower([...had.first, ...c.first]),
      });
    }
    return [...byAddress.values()];
  }

  /** An address nobody knows, found as itself: its own display name, since no contact lends one. */
  private addressOnly(address: string): FoundPerson {
    const a = address.toLowerCase();
    return { provider: "gmail", display: a, address: a, token: a, detail: null };
  }
}

/** A found person as a resolution keeps them: without the token and detail, which only told them apart. */
function resolvedOf(p: FoundPerson): ResolvedPerson {
  switch (p.provider) {
    case "slack":
      return { provider: "slack", display: p.display, id: p.id };
    case "jira":
      return { provider: "jira", display: p.display, id: p.id };
    case "gmail":
      return { provider: "gmail", display: p.display, address: p.address };
  }
}

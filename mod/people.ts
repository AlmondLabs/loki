import type { GoogleContactSource } from "../core/frame-types.ts";
import { inert } from "./account-ops/fence.ts";
import { accountLabel, contactsOf, type AccountRecord, type Accounts } from "./accounts.ts";
import type { GoogleContact, GooglePeople } from "./google-people.ts";
import type { JiraClient, JiraUser, JiraUserScope } from "./jira.ts";
import { searchPeople, type SlackMember, type SlackPeople } from "./slack-people.ts";

export type ResolvedPerson =
  | { provider: "slack"; display: string; id: string }
  | { provider: "jira"; display: string; id: string }
  | { provider: "gmail"; display: string; address: string };

export type FoundPerson = ResolvedPerson & { token: string; detail: string | null };

export type PersonResolution = { ok: true; person: ResolvedPerson } | { ok: false; why: string };

export interface PeopleFound {
  people: FoundPerson[];
  notice: string | null;
}

export interface PeopleOptions {
  jira?: JiraUserScope;
}

export interface PeopleDeps {
  accounts: Pick<Accounts, "get">;
  slack: Pick<SlackPeople, "members">;
  jira: (accountId: string) => Pick<JiraClient, "searchUsers">;
  google: (accountId: string) => Pick<GooglePeople, "searchContacts" | "searchOtherContacts" | "searchDirectory">;
}

const LISTED = 8;

const ADDRESS = /^[^\s@<>()",;]+@[^\s@<>()",;]+\.[^\s@<>()",;]+$/;

/** Something that may be a Jira account id: one word with a digit, as `5b10ac8d82e05b22cc7d4ef5` or `557058:f58131cb-…`. */
const MAYBE_JIRA_ID = /^(?=.*\d)[\w:-]+$/;

interface Candidate {
  person: FoundPerson;
  keys: string[];
  first: string[];
}

const normal = (name: string): string => name.trim().replace(/^@/, "").replace(/\s+/g, " ").toLowerCase();

const asWritten = (name: string): string => name.trim().replace(/^@/, "").replace(/\s+/g, " ");

const firstWord = (name: string): string => name.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
const lower = (values: readonly string[]): string[] => [...new Set(values.map((v) => v.trim().toLowerCase()).filter(Boolean))];

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

const listed = (p: FoundPerson): string => {
  const said = [p.token, ...(p.detail && p.detail !== p.token ? [p.detail] : [])].map(inert).join(", ");
  return `${inert(p.display)} (${said})`;
};

function several(name: string, where: string, people: readonly FoundPerson[]): string {
  const shown = people.slice(0, LISTED).map(listed).join("; ");
  const more = people.length > LISTED ? `; and ${people.length - LISTED} more` : "";
  return `"${inert(asWritten(name))}" matches ${people.length} people ${where}: ${shown}${more}. Ask the person which one they mean, then name them by their token or full name`;
}

const nobody = (name: string, where: string): string => `nobody ${where} matched "${inert(asWritten(name))}"`;

function names(people: readonly FoundPerson[]): string {
  const all = people.map((p) => inert(p.display));
  return all.length < 2 ? all.join("") : `${all.slice(0, -1).join(", ")} and ${all.at(-1) ?? ""}`;
}

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

export const reconnectForPeople = (address: string): string => `reconnect ${address} in Preferences › Accounts to find people by name`;

function slackCandidate(m: SlackMember): Candidate {
  const display = m.real_name || m.display_name || m.handle;
  const detail = m.display_name && m.display_name.toLowerCase() !== display.toLowerCase() ? m.display_name : null;
  return {
    person: { provider: "slack", display, id: m.id, token: m.handle, detail },
    keys: lower([m.real_name, m.display_name, m.handle, m.id]),
    first: lower([firstWord(m.real_name), firstWord(m.display_name)]),
  };
}

function jiraCandidate(u: JiraUser): Candidate {
  const display = u.display_name || u.account_id;
  return {
    person: { provider: "jira", display, id: u.account_id, token: u.account_id, detail: u.email },
    keys: lower([u.display_name, u.account_id, u.email ?? ""]),
    first: lower([firstWord(u.display_name)]),
  };
}

function gmailCandidates(c: GoogleContact): Candidate[] {
  return c.addresses.map((address) => ({
    person: { provider: "gmail", display: c.name || address, address, token: address, detail: c.title },
    keys: lower([c.name, address]),
    first: lower([firstWord(c.name)]),
  }));
}

export class People {
  private readonly deps: PeopleDeps;

  constructor(deps: PeopleDeps) {
    this.deps = deps;
  }

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
    const elsewhere = matchPeople(await this.jiraSearch(account, { kind: "site" }, written), name);
    return { ok: false, why: elsewhere.length === 0 ? nobody(name, where) : `${names(elsewhere)} ${jiraCannot(scope)}` };
  }

  private async jiraSearch(account: AccountRecord, scope: JiraUserScope, written: string): Promise<Candidate[]> {
    const client = this.deps.jira(account.account_id);
    const byName = await client.searchUsers(scope, { query: written });
    const byId = MAYBE_JIRA_ID.test(written) ? await client.searchUsers(scope, { account_id: written }) : [];
    return [...byName, ...byId].map(jiraCandidate);
  }

  private async resolveGmail(account: AccountRecord, name: string): Promise<PersonResolution> {
    const written = asWritten(name);
    if (ADDRESS.test(written)) {
      const address = written.toLowerCase();
      if (contactsOf(account).length === 0) return { ok: true, person: resolvedOf(this.addressOnly(address)) };
      const known = await this.gmailSearch(account, address).catch(() => []);
      return { ok: true, person: resolvedOf(known.find((c) => c.person.token === address)?.person ?? this.addressOnly(address)) };
    }
    if (contactsOf(account).length === 0) return { ok: false, why: reconnectForPeople(account.address) };
    return this.pick(name, `in ${inert(account.address)}'s contacts`, await this.gmailSearch(account, written));
  }

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

  private addressOnly(address: string): FoundPerson {
    const a = address.toLowerCase();
    return { provider: "gmail", display: a, address: a, token: a, detail: null };
  }
}

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

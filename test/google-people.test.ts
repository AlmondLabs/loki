import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { memorySecrets } from "../daemon/credentials.ts";
import { Accounts } from "../mod/accounts.ts";
import { CONTACTS_NOT_ALLOWED, GoogleError } from "../mod/google-auth.ts";
import { GooglePeople } from "../mod/google-people.ts";
import { must } from "./fixtures/must.ts";

const ACCOUNT = "gmail:ada@acme.com";
const NOW = new Date("2026-11-14T10:00:00.000Z");
const CONTACTS = "https://www.googleapis.com/auth/contacts.readonly";
const OTHER = "https://www.googleapis.com/auth/contacts.other.readonly";
const DIRECTORY = "https://www.googleapis.com/auth/directory.readonly";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface FakePerson {
  names?: Array<{ displayName: string }>;
  emailAddresses?: Array<{ value: string }>;
  organizations?: Array<{ title?: string }>;
}

// Outside (Google): the People API can answer a cold contacts search with nobody, from a stale cache, until the search
// is warmed with an empty query, and its directory refuses a personal account.
function fakePeople(opts: { contacts?: FakePerson[]; other?: FakePerson[]; directory?: FakePerson[] | "personal"; scopes?: string[]; refreshScope?: string }) {
  const requests: URL[] = [];
  const warmed = new Set<string>();
  const granted = new Set(opts.scopes ?? [CONTACTS, OTHER, DIRECTORY]);
  const json = (status: number, value: unknown) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
  const matching = (people: FakePerson[], q: string) =>
    people.filter((p) =>
      [...(p.names ?? []).map((n) => n.displayName), ...(p.emailAddresses ?? []).map((e) => e.value)].some((v) =>
        v
          .toLowerCase()
          .split(/\s+/)
          .some((w) => w.startsWith(q.toLowerCase())),
      ),
    );
  const fetchFn = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.href === "https://oauth2.googleapis.com/token" && init?.method === "POST")
      return Promise.resolve(json(200, { access_token: "access-new", expires_in: 3600, scope: opts.refreshScope ?? [...granted].join(" ") }));
    requests.push(url);
    const q = url.searchParams.get("query") ?? "";
    const needs = (scope: string) =>
      granted.has(scope) ? null : json(403, { error: { status: "PERMISSION_DENIED", details: [{ reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" }] } });
    const search = (key: string, scope: string, people: FakePerson[]) => {
      const refused = needs(scope);
      if (refused) return refused;
      if (q === "") {
        warmed.add(key);
        return json(200, {});
      }
      return json(200, { results: warmed.has(key) ? matching(people, q).map((person) => ({ person })) : [] });
    };
    if (url.pathname === "/v1/people:searchContacts") return Promise.resolve(search("contacts", CONTACTS, opts.contacts ?? []));
    if (url.pathname === "/v1/otherContacts:search") return Promise.resolve(search("other", OTHER, opts.other ?? []));
    if (url.pathname === "/v1/people:searchDirectoryPeople") {
      const refused = needs(DIRECTORY);
      if (refused) return Promise.resolve(refused);
      if (opts.directory === "personal")
        return Promise.resolve(json(400, { error: { status: "FAILED_PRECONDITION", message: "Must be a G Suite domain user." } }));
      return Promise.resolve(json(200, { people: matching(opts.directory ?? [], q) }));
    }
    return Promise.resolve(json(404, {}));
  };
  return { fetch: fetchFn, requests };
}

async function account(expires = "2026-11-14T11:00:00.000Z") {
  const dir = mkdtempSync(join(tmpdir(), "loki-google-people-"));
  dirs.push(dir);
  const accounts = new Accounts({ file: join(dir, "accounts.json"), secrets: memorySecrets(), now: () => NOW });
  const secret = { access_token: "access-old", refresh_token: "refresh", expires_at: expires, scopes: `${CONTACTS} ${OTHER} ${DIRECTORY}` };
  await accounts.add(
    {
      account_id: ACCOUNT,
      provider: "gmail",
      address: "ada@acme.com",
      owner_agent_id: "agent-work",
      services: ["gmail"],
      contacts: ["contacts", "other_contacts", "directory"],
    },
    JSON.stringify(secret),
  );
  return accounts;
}

const ANA = {
  names: [{ displayName: "Ana Ruiz" }],
  emailAddresses: [{ value: "Ana@Example.com" }, { value: "ana@home.net" }],
  organizations: [{ title: "Designer" }],
};

describe("searching a Google account's people", () => {
  test("contacts and other contacts are warmed once with an empty query before a real search, 30 to a page", async () => {
    const google = fakePeople({ contacts: [ANA], other: [{ names: [{ displayName: "Bo Lind" }], emailAddresses: [{ value: "bo@example.com" }] }] });
    const people = new GooglePeople({ accounts: await account(), account_id: ACCOUNT, fetch: google.fetch, now: () => NOW });
    expect(await people.searchContacts("ana")).toEqual([
      { name: "Ana Ruiz", addresses: ["ana@example.com", "ana@home.net"], title: "Designer", source: "contacts" },
    ]);
    expect(await people.searchContacts("ana")).toHaveLength(1);
    expect(await people.searchOtherContacts("bo")).toEqual([{ name: "Bo Lind", addresses: ["bo@example.com"], title: null, source: "other_contacts" }]);
    expect(google.requests.map((u) => [u.pathname, u.searchParams.get("query"), u.searchParams.get("pageSize")])).toEqual([
      ["/v1/people:searchContacts", "", "30"],
      ["/v1/people:searchContacts", "ana", "30"],
      ["/v1/people:searchContacts", "ana", "30"],
      ["/v1/otherContacts:search", "", "30"],
      ["/v1/otherContacts:search", "bo", "30"],
    ]);
    expect(google.requests.map((u) => u.searchParams.get("readMask"))).toEqual([
      "names,emailAddresses,organizations",
      "names,emailAddresses,organizations",
      "names,emailAddresses,organizations",
      "names,emailAddresses",
      "names,emailAddresses",
    ]);
  });

  test("the directory is searched by the domain's profiles without a warm-up; someone with no address is nobody to write to", async () => {
    const google = fakePeople({ directory: [ANA, { names: [{ displayName: "Ana Nomail" }] }] });
    const people = new GooglePeople({ accounts: await account(), account_id: ACCOUNT, fetch: google.fetch, now: () => NOW });
    expect((await people.searchDirectory("ana")).map((p) => [p.name, p.source])).toEqual([["Ana Ruiz", "directory"]]);
    const asked = must(google.requests[0], "the directory search");
    expect([asked.pathname, asked.searchParams.get("sources"), asked.searchParams.get("query")]).toEqual([
      "/v1/people:searchDirectoryPeople",
      "DIRECTORY_SOURCE_TYPE_DOMAIN_PROFILE",
      "ana",
    ]);
    expect(google.requests).toHaveLength(1);
  });

  test("an empty query asks nothing; a personal account's directory and a missing scope are refused with words", async () => {
    const google = fakePeople({ directory: "personal", scopes: [OTHER, DIRECTORY] });
    const people = new GooglePeople({ accounts: await account(), account_id: ACCOUNT, fetch: google.fetch, now: () => NOW });
    expect(await people.searchContacts("  ")).toEqual([]);
    expect(google.requests).toEqual([]);
    await expect(people.searchDirectory("ana")).rejects.toBeInstanceOf(GoogleError);
    const missing = await people.searchContacts("ana").catch((e: unknown) => e);
    expect(missing).toBeInstanceOf(GoogleError);
    expect((missing as GoogleError).message).toBe(CONTACTS_NOT_ALLOWED);
  });

  test("a token refresh that reports fewer places to find people keeps that on the account", async () => {
    const accounts = await account("2026-11-14T09:00:00.000Z");
    const google = fakePeople({ contacts: [ANA], refreshScope: `https://www.googleapis.com/auth/gmail.modify ${CONTACTS} ${OTHER}` });
    const people = new GooglePeople({ accounts, account_id: ACCOUNT, fetch: google.fetch, now: () => NOW });
    await people.searchContacts("ana");
    expect(accounts.get(ACCOUNT)?.contacts).toEqual(["contacts", "other_contacts"]);
    expect(accounts.get(ACCOUNT)?.services).toEqual(["gmail"]);
  });
});

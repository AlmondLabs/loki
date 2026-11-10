import { describe, expect, test } from "vitest";
import type { AccountStatus } from "../core/frame-types.ts";
import { JiraClient, JiraError } from "../mod/jira.ts";
import type { JiraEvent, JiraEventPage, JiraSecret, JiraTicket } from "../mod/jira.ts";
import { JIRA_ADA, JIRA_BOB, JIRA_ME, fakeJira } from "./fixtures/jira.ts";

const T0 = Date.parse("2026-11-10T10:00:00.000Z");
const at = (iso: string) => new Date(iso);

/** A client over a fake site with the token it accepts, a status log and a clock the test moves. */
function setup(secret: Partial<JiraSecret> = {}) {
  const clock = { t: T0 };
  const jira = fakeJira({ now: () => new Date(clock.t) });
  const statuses: AccountStatus[] = [];
  const c = new JiraClient({
    secret: () => Promise.resolve({ site: jira.host, email: jira.state.email, token: "fixture-jira-token", ...secret }),
    setStatus: (s) => statuses.push(s),
    fetch: jira.fetch,
    now: () => new Date(clock.t),
  });
  return { c, jira, statuses, clock };
}

/** The error a call ends in, or a failure when it ends well. */
async function refusal(call: Promise<unknown>): Promise<JiraError> {
  const err = await call.then(
    () => null,
    (e: unknown) => e,
  );
  if (!(err instanceof JiraError)) throw new Error(`expected a JiraError, got ${String(err)}`);
  return err;
}

describe("who the token belongs to and where the site lives", () => {
  test("the profile is asked of the site's own API with the email and token as basic auth", async () => {
    const { c, jira } = setup();
    expect(await c.myself()).toEqual({ account_id: "acc-me", display_name: "Mina Example", email: "mina@example.com" });
    expect(jira.requests.map((r) => [r.method, r.url.href, r.authorization])).toEqual([
      ["GET", "https://acme.atlassian.net/rest/api/3/myself", `Basic ${Buffer.from("mina@example.com:fixture-jira-token").toString("base64")}`],
    ]);
  });

  test("a site on a custom domain names its API address and the address people browse, and is asked without the token", async () => {
    const { c, jira } = setup({ site: "jira.example.org" });
    jira.state.display_url = "https://jira.example.org";
    expect(await c.serverInfo()).toEqual({ base_url: "https://acme.atlassian.net", display_url: "https://jira.example.org" });
    expect(jira.requests.map((r) => [r.url.href, r.authorization])).toEqual([["https://jira.example.org/rest/api/3/serverInfo", ""]]);
  });
});

describe("the watched-ticket search", () => {
  test("sends the watcher clause with the relative minutes, oldest change first, asks for the fields the sync needs and follows the page token to the end", async () => {
    const { c, jira } = setup();
    const ids = [
      jira.addTicket({ key: "OPS-1", summary: "Rotate the keys", at: at("2026-11-10T09:40:00.000Z"), assignee: JIRA_ME }),
      jira.addTicket({ key: "OPS-2", summary: "Fix the pager", at: at("2026-11-10T09:50:00.250Z") }),
      jira.addTicket({ key: "OPS-3", summary: "Trim the logs", at: at("2026-11-10T09:55:00.000Z"), assignee: JIRA_ADA }),
    ];
    jira.addTicket({ key: "OPS-4", summary: "Changed too long ago", at: at("2026-11-10T09:00:00.000Z") });
    jira.addTicket({ key: "OPS-5", summary: "Not watched", at: at("2026-11-10T09:58:00.000Z"), watchers: [JIRA_ADA] });

    const tickets: JiraTicket[] = [];
    let token: string | null = null;
    do {
      const page = await c.searchWatched({ sinceMinutes: 25, pageToken: token, limit: 2 });
      tickets.push(...page.tickets);
      token = page.next_page_token;
    } while (token !== null);

    expect(tickets).toEqual([
      { id: ids[0], key: "OPS-1", summary: "Rotate the keys", updated: "2026-11-10T09:40:00.000Z", assignee_account_id: "acc-me" },
      { id: ids[1], key: "OPS-2", summary: "Fix the pager", updated: "2026-11-10T09:50:00.250Z", assignee_account_id: null },
      { id: ids[2], key: "OPS-3", summary: "Trim the logs", updated: "2026-11-10T09:55:00.000Z", assignee_account_id: "acc-ada" },
    ]);
    expect(jira.requests).toHaveLength(2);
    const q = jira.requests[0].url.searchParams;
    expect(q.get("jql")).toBe("watcher = currentUser() AND updated >= -25m ORDER BY updated ASC");
    expect(q.get("fields")?.split(",").sort()).toEqual(["assignee", "summary", "updated"]);
  });

  test("with no minutes it lists every watched ticket, most recently changed first, for the past fill", async () => {
    const { c, jira } = setup();
    jira.addTicket({ key: "OPS-1", summary: "Old", at: at("2025-03-01T08:00:00.000Z") });
    jira.addTicket({ key: "OPS-2", summary: "New", at: at("2026-11-09T08:00:00.000Z") });
    const page = await c.searchWatched({ sinceMinutes: null });
    expect(page.tickets.map((t) => t.key)).toEqual(["OPS-2", "OPS-1"]);
    expect(page.next_page_token).toBeNull();
    expect(jira.requests[0]?.url.searchParams.get("jql")).toBe("watcher = currentUser() ORDER BY updated DESC");
  });

  test("uses the current search endpoint and never the retired one", async () => {
    const { c, jira } = setup();
    await c.searchWatched({ sinceMinutes: 10 });
    await c.searchWatched({ sinceMinutes: null });
    expect(jira.requests.map((r) => r.url.pathname)).toEqual(["/rest/api/3/search/jql", "/rest/api/3/search/jql"]);
  });
});

describe("a token Jira rejects", () => {
  test("a 401 sets sign_in_again once and throws", async () => {
    const { c, jira, statuses } = setup();
    jira.state.unauthorized = true;
    const err = await refusal(c.searchWatched({ sinceMinutes: 10 }));
    expect(err.code).toBe("rejected");
    expect(statuses).toEqual([{ disconnected: "sign_in_again" }]);
  });

  test("a token that is not the one the site accepts is rejected the same way", async () => {
    const { c, statuses } = setup({ token: "an-expired-token" });
    expect((await refusal(c.myself())).code).toBe("rejected");
    expect(statuses).toEqual([{ disconnected: "sign_in_again" }]);
  });

  test("a 200 answer carrying the failed-login header sets sign_in_again, although the body is empty", async () => {
    const { c, jira, statuses } = setup();
    jira.addTicket({ key: "OPS-1", summary: "Rotate the keys" });
    jira.state.failed_login = true;
    expect((await refusal(c.comments("OPS-1"))).code).toBe("rejected");
    expect(statuses).toEqual([{ disconnected: "sign_in_again" }]);
  });

  test("a profile answer without an account id is a rejection", async () => {
    const { c, jira, statuses } = setup();
    jira.state.profile_without_id = true;
    expect((await refusal(c.myself())).code).toBe("rejected");
    expect(statuses).toEqual([{ disconnected: "sign_in_again" }]);
  });

  test("an account that keeps no token is a rejection, with nothing asked of Jira", async () => {
    const jira = fakeJira({ now: () => new Date(T0) });
    const statuses: AccountStatus[] = [];
    const c = new JiraClient({ secret: () => Promise.resolve(null), setStatus: (s) => statuses.push(s), fetch: jira.fetch });
    expect((await refusal(c.myself())).code).toBe("rejected");
    expect(statuses).toEqual([{ disconnected: "sign_in_again" }]);
    expect(jira.requests).toEqual([]);
  });
});

describe("a rate limit", () => {
  test("a 429 with a wait time holds every call until then without a request, and the account stays connected", async () => {
    const { c, jira, statuses, clock } = setup();
    jira.addTicket({ key: "OPS-1", summary: "Rotate the keys" });
    jira.state.retry_after = 90;
    const first = await refusal(c.searchWatched({ sinceMinutes: 10 }));
    expect([first.code, first.retryAfterMs]).toEqual(["rate_limited", 90_000]);
    jira.state.retry_after = null;
    expect(jira.requests).toHaveLength(1);

    clock.t = T0 + 89_000;
    const held = await refusal(c.myself());
    expect([held.code, held.retryAfterMs]).toEqual(["rate_limited", 1_000]);
    expect((await refusal(c.comments("OPS-1"))).code).toBe("rate_limited");
    expect((await refusal(c.postComment("OPS-1", "hello"))).code).toBe("rate_limited");
    expect(jira.requests).toHaveLength(1);

    clock.t = T0 + 90_000;
    expect((await c.myself()).account_id).toBe("acc-me");
    expect(jira.requests).toHaveLength(2);
    expect(statuses).toEqual([]);
  });

  test("a 429 whose wait is missing, zero or not a number holds every call for 60 s", async () => {
    for (const retryAfter of [null, "0", "soon"]) {
      const { jira, statuses, clock } = setup();
      let limited = true;
      let asked = 0;
      const c = new JiraClient({
        secret: () => Promise.resolve({ site: jira.host, email: jira.state.email, token: "fixture-jira-token" }),
        setStatus: (s) => statuses.push(s),
        fetch: (input, init) => {
          asked += 1;
          if (!limited) return jira.fetch(input, init);
          limited = false;
          return Promise.resolve(new Response("{}", { status: 429, headers: retryAfter === null ? {} : { "retry-after": retryAfter } }));
        },
        now: () => new Date(clock.t),
      });
      const first = await refusal(c.myself());
      expect([retryAfter, first.code, first.retryAfterMs]).toEqual([retryAfter, "rate_limited", 60_000]);

      clock.t = T0 + 59_999;
      expect([retryAfter, (await refusal(c.myself())).retryAfterMs]).toEqual([retryAfter, 1]);
      expect(asked).toBe(1);

      clock.t = T0 + 60_000;
      expect((await c.myself()).account_id).toBe("acc-me");
      expect(asked).toBe(2);
      expect(statuses).toEqual([]);
    }
  });
});

describe("a ticket the person cannot see", () => {
  test("answers not found, which the client reports as a refusal of that ticket and not of the account", async () => {
    const { c, jira, statuses } = setup();
    jira.addTicket({ key: "OPS-1", summary: "Rotate the keys" });
    jira.addTicket({ key: "SEC-9", summary: "Out of sight" });
    jira.hide("SEC-9");
    for (const call of [c.comments("SEC-9"), c.history("SEC-9"), c.postComment("SEC-9", "hello")]) {
      const err = await refusal(call);
      expect([err.code, err.status]).toEqual(["not_found", 404]);
    }
    expect(statuses).toEqual([]);
    expect((await c.comments("OPS-1")).events).toEqual([]);
  });
});

describe("a ticket's events", () => {
  test("a comment carries who wrote it, when in UTC, its document, and an id of its time, c and its padded number", async () => {
    const { c, jira } = setup();
    const id = jira.addTicket({ key: "OPS-1", summary: "Rotate the keys" });
    const body = { version: 1, type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "On it." }] }] };
    jira.comment("OPS-1", { at: "2026-11-10T14:35:27.259+0530", author: JIRA_ADA, body, id: "30417" });
    const expected: JiraEvent[] = [
      {
        id: "2026-11-10T09:05:27.259Z:c000000030417",
        kind: "comment",
        jira_id: "30417",
        created: "2026-11-10T09:05:27.259Z",
        author: { account_id: "acc-ada", display_name: "Ada Lovelace" },
        body,
      },
    ];
    expect((await c.comments("OPS-1")).events).toEqual(expected);
    // A ticket answers to its numeric id as well as its key.
    expect((await c.comments(id)).events).toEqual(expected);
  });

  test("a history entry carries its changed fields by the values Jira shows, and an id with h", async () => {
    const { c, jira } = setup();
    jira.addTicket({ key: "OPS-1", summary: "Rotate the keys" });
    jira.change("OPS-1", {
      at: at("2026-11-10T09:06:00.000Z"),
      author: JIRA_BOB,
      id: "50712",
      items: [
        { field: "status", from: "To Do", to: "In Progress" },
        { field: "assignee", from: null, to: "Bob Stone" },
      ],
    });
    expect((await c.history("OPS-1")).events).toEqual([
      {
        id: "2026-11-10T09:06:00.000Z:h000000050712",
        kind: "history",
        jira_id: "50712",
        created: "2026-11-10T09:06:00.000Z",
        author: { account_id: "acc-bob", display_name: "Bob Stone" },
        items: [
          { field: "status", from: "To Do", to: "In Progress" },
          { field: "assignee", from: null, to: "Bob Stone" },
        ],
      },
    ]);
  });

  test("ids sort by creation time across comments and history, with two in one millisecond and a +0530 time among them", async () => {
    const { c, jira } = setup();
    jira.addTicket({ key: "OPS-1", summary: "Rotate the keys" });
    // In creation order: h 900 (09:00:00.000), c 1000 and h 85 (both 09:00:00.500), c 99 (09:00:01.000 as +0530), c 100000 (09:00:02).
    jira.change("OPS-1", { at: at("2026-11-10T09:00:00.000Z"), author: JIRA_ADA, id: "900", items: [{ field: "status", from: "To Do", to: "Done" }] });
    jira.comment("OPS-1", { at: at("2026-11-10T09:00:00.500Z"), author: JIRA_ADA, text: "same instant", id: "1000" });
    jira.change("OPS-1", { at: at("2026-11-10T09:00:00.500Z"), author: JIRA_BOB, id: "85", items: [{ field: "Rank", from: null, to: "Ranked higher" }] });
    jira.comment("OPS-1", { at: "2026-11-10T14:30:01.000+0530", author: JIRA_BOB, text: "from Pune", id: "99" });
    jira.comment("OPS-1", { at: at("2026-11-10T09:00:02.000Z"), author: JIRA_ADA, text: "last", id: "100000" });
    const events = [...(await c.comments("OPS-1")).events, ...(await c.history("OPS-1")).events];
    const sorted = events.map((e) => e.id).sort();
    expect(sorted.map((id) => events.find((e) => e.id === id)?.jira_id)).toEqual(["900", "1000", "85", "99", "100000"]);
    expect(new Set(sorted).size).toBe(5);
  });

  test("a history answer is read under either known list name", async () => {
    const { c, jira } = setup();
    jira.addTicket({ key: "OPS-1", summary: "Rotate the keys" });
    jira.change("OPS-1", { at: at("2026-11-10T09:06:00.000Z"), author: JIRA_BOB, id: "50712", items: [{ field: "status", from: "To Do", to: "Done" }] });
    jira.state.history_list = "values";
    expect((await c.history("OPS-1")).events.map((e) => e.jira_id)).toEqual(["50712"]);
    jira.state.history_list = "histories";
    expect((await c.history("OPS-1")).events.map((e) => e.jira_id)).toEqual(["50712"]);
  });

  test.each(["comments", "history"] as const)("%s are read from the end in pages, each oldest first, until the start", async (kind) => {
    const { c, jira } = setup();
    jira.addTicket({ key: "OPS-1", summary: "Rotate the keys" });
    for (let i = 1; i <= 7; i++) {
      const when = at(`2026-11-10T09:0${i}:00.000Z`);
      if (kind === "comments") jira.comment("OPS-1", { at: when, author: JIRA_ADA, text: `c${i}`, id: String(i) });
      else jira.change("OPS-1", { at: when, author: JIRA_ADA, id: String(i), items: [{ field: "status", from: "a", to: "b" }] });
    }
    const pages: string[][] = [];
    let before: number | null = null;
    do {
      const page: JiraEventPage = await c[kind]("OPS-1", { limit: 3, before });
      pages.push(page.events.map((e) => e.jira_id));
      before = page.earlier;
    } while (before !== null);
    expect(pages).toEqual([["5", "6", "7"], ["2", "3", "4"], ["1"]]);
  });

  test("a ticket with fewer events than a page is read whole in one request", async () => {
    const { c, jira } = setup();
    jira.addTicket({ key: "OPS-1", summary: "Rotate the keys" });
    jira.comment("OPS-1", { at: at("2026-11-10T09:01:00.000Z"), author: JIRA_ADA, text: "one" });
    jira.comment("OPS-1", { at: at("2026-11-10T09:02:00.000Z"), author: JIRA_BOB, text: "two" });
    const page = await c.comments("OPS-1", { limit: 3 });
    expect([page.events.length, page.earlier]).toEqual([2, null]);
    expect(jira.requests).toHaveLength(1);
  });
});

describe("a ticket's fields for its card (plan 089)", () => {
  test("the issue read asks for the card's fields and the sprint field, found by name once per site", async () => {
    const { c, jira } = setup();
    jira.addTicket({
      key: "OPS-1",
      summary: "Rotate the keys",
      at: at("2026-11-10T08:00:00.000Z"),
      assignee: JIRA_ADA,
      reporter: JIRA_BOB,
      type: "Task",
      project: "Operations",
      status: "In Progress",
      priority: "High",
      labels: ["security", "q4"],
      sprints: [
        { name: "Sprint 11", state: "closed" },
        { name: "Sprint 12", state: "active" },
      ],
      description: "Rotate every key.\nThen tell the team.",
    });
    const issue = await c.issue("OPS-1");
    expect(issue).toEqual({
      id: expect.any(String) as string,
      key: "OPS-1",
      summary: "Rotate the keys",
      type: "Task",
      project: "Operations",
      status: "In Progress",
      assignee: "Ada Lovelace",
      reporter: "Bob Stone",
      priority: "High",
      sprint: "Sprint 12",
      labels: ["security", "q4"],
      description: expect.objectContaining({ type: "doc" }) as unknown,
      created: "2026-11-10T08:00:00.000Z",
    });
    await c.issue("OPS-1");
    expect(jira.requests.map((r) => r.url.pathname)).toEqual(["/rest/api/3/field", "/rest/api/3/issue/OPS-1", "/rest/api/3/issue/OPS-1"]);
    expect(jira.requests[1].url.searchParams.get("fields")?.split(",")).toEqual(
      expect.arrayContaining(["summary", "issuetype", "project", "status", "assignee", "reporter", "priority", "labels", "description", "customfield_10020"]),
    );
  });

  test("a site without a sprint field shows none, and asks for its fields only once", async () => {
    const { c, jira } = setup();
    jira.state.has_sprints = false;
    jira.addTicket({ key: "OPS-1", summary: "Rotate the keys" });
    const issue = await c.issue("OPS-1");
    expect(issue).toMatchObject({ sprint: null, status: null, assignee: null, labels: [], description: null });
    await c.issue("OPS-1");
    expect(jira.requests.filter((r) => r.url.pathname === "/rest/api/3/field")).toHaveLength(1);
    expect(jira.requests[1].url.searchParams.get("fields")).not.toMatch(/customfield/);
  });

  test("a failed look for the sprint field is asked again on the next read", async () => {
    const { c, jira } = setup();
    jira.addTicket({ key: "OPS-1", summary: "Rotate the keys" });
    jira.state.unauthorized = true;
    await refusal(c.issue("OPS-1"));
    jira.state.unauthorized = false;
    expect((await c.issue("OPS-1")).key).toBe("OPS-1");
    expect(jira.requests.filter((r) => r.url.pathname === "/rest/api/3/field")).toHaveLength(2);
  });
});

describe("the person's comment", () => {
  test("posts paragraphs with line breaks to the ticket and returns the new comment's id", async () => {
    const { c, jira } = setup();
    jira.addTicket({ key: "OPS-1", summary: "Rotate the keys" });
    const { id } = await c.postComment("OPS-1", "Looks good.\nShip it.\n\nThanks");
    expect(jira.posted).toEqual([
      {
        key: "OPS-1",
        id,
        body: {
          version: 1,
          type: "doc",
          content: [
            { type: "paragraph", content: [{ type: "text", text: "Looks good." }, { type: "hardBreak" }, { type: "text", text: "Ship it." }] },
            { type: "paragraph", content: [{ type: "text", text: "Thanks" }] },
          ],
        },
      },
    ]);
    expect(id).toMatch(/^\d+$/);
    expect((await c.comments("OPS-1")).events.map((e) => [e.jira_id, e.author.account_id])).toEqual([[id, "acc-me"]]);
  });
});

/** Names that would change something in Jira: the client may have none but the comment. */
const WRITES = /post|send|add|create|update|edit|delete|remove|assign|transition|watch(?!ed)|set|put|move|mark/i;

/** The client's own helpers, which make no request of their own choosing. */
const PRIVATE = ["now", "sprintField", "call", "request", "page", "rejected", "rateLimited"];

describe("the only thing the client writes is the person's comment", () => {
  test("postComment is the only client method whose name suggests writing", () => {
    const names = Object.getOwnPropertyNames(JiraClient.prototype).filter((n) => n !== "constructor");
    expect(names).toContain("postComment");
    expect(names.filter((n) => WRITES.test(n))).toEqual(["postComment"]);
  });

  test("every other call is a GET, and the comment is the one request that is not", async () => {
    const { c, jira } = setup();
    jira.addTicket({ key: "OPS-1", summary: "Rotate the keys" });
    await c.myself();
    await c.serverInfo();
    await c.searchWatched({ sinceMinutes: 10 });
    await c.comments("OPS-1");
    await c.history("OPS-1");
    await c.ticket("OPS-1");
    await c.issue("OPS-1");
    expect(jira.writes()).toEqual([]);
    await c.postComment("OPS-1", "hello");
    expect(jira.writes().map((r) => [r.method, r.url.pathname])).toEqual([["POST", "/rest/api/3/issue/OPS-1/comment"]]);
    const called = Object.getOwnPropertyNames(JiraClient.prototype).filter((n) => !["constructor", "postComment"].includes(n));
    // Every public method was exercised above; a new one must be added here, where its requests are checked.
    expect(
      called.filter((n) => !["myself", "serverInfo", "searchWatched", "comments", "history", "ticket", "issue"].includes(n) && !PRIVATE.includes(n)),
    ).toEqual([]);
  });
});

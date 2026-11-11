import { describe, expect, test } from "vitest";
import type { OutsideWindowAsk } from "../core/frame-types.ts";
import { JiraClient, type JiraSecret } from "../mod/jira.ts";
import { jiraCardView, jiraThreadText } from "../mod/jira-view.ts";
import type { CardFacts } from "../mod/slack-view.ts";
import { JIRA_ADA, JIRA_BOB, fakeJira, type FakeJiraChange, type FakeJiraPerson } from "./fixtures/jira.ts";

/** Reading a Jira ticket on its card and for a hand-off (plan 2026-11-10-1451, U5, KTD14; plan 089). */

const MIN = 60_000;
const START = Date.parse("2026-11-10T09:00:00.000Z");
/** The person, with an Atlassian id that holds a colon, as real ones do. */
const ME: FakeJiraPerson = { account_id: "557058:6f1c2d3e-acme", display_name: "Mina Example" };
const ID = `jira:acme.atlassian.net:${ME.account_id}`;

/** A time, in minutes from the start. */
const at = (minutes: number) => new Date(START + minutes * MIN);
/** The id an event is known by on a card: its creation time, `c` or `h`, then Jira's id padded (KTD8). */
const eid = (when: Date, kind: "c" | "h", jiraId: string) => `${when.toISOString()}:${kind}${jiraId.padStart(12, "0")}`;

/** One site with one ticket, OPS-7, and the readers over it; `link_host` stands for a custom domain kept at connect. */
function site(over: { link_host?: string } = {}, preview?: (accountId: string, attachmentId: string) => Promise<string | null>) {
  const clock = () => at(1000);
  const jira = fakeJira({ now: clock, me: ME });
  const ticket = jira.addTicket({
    key: "OPS-7",
    summary: "Rotate the keys",
    at: at(0),
    type: "Task",
    project: "Operations",
    status: "In Progress",
    assignee: JIRA_ADA,
    reporter: JIRA_BOB,
    priority: "High",
    labels: ["security"],
    sprints: [{ name: "Sprint 12", state: "active" }],
    description: "Rotate every key.\nThen tell the team.",
  });
  const secret: JiraSecret = { site: jira.host, email: jira.state.email, token: jira.state.token, ...over };
  const client = new JiraClient({ secret: () => Promise.resolve(secret), setStatus: () => {}, fetch: jira.fetch, now: clock });
  const view = jiraCardView(
    () => client,
    () => Promise.resolve(secret),
    preview,
  );
  const facts = (f: Partial<CardFacts> = {}): CardFacts => ({ dealt_message_id: null, brought_ids: [], newest_message_id: null, place: "OPS-7", ...f });
  /** A read as an app on plan 089 asks it, with the ticket. */
  const read = (f: Partial<CardFacts> = {}, ask: OutsideWindowAsk = {}) => view(ID, ticket, facts(f), { ticket: true, ...ask });
  /** A read as an older app asks it, without the ticket. */
  const plain = (f: Partial<CardFacts> = {}, ask: OutsideWindowAsk = {}) => view(ID, ticket, facts(f), ask);
  /** Someone comments at a minute; returns the comment's id on the card. */
  const comment = (minute: number, author: FakeJiraPerson = JIRA_ADA): string =>
    eid(at(minute), "c", jira.comment("OPS-7", { at: at(minute), author, text: `comment at ${String(minute)}` }));
  /** Someone changes fields at a minute; returns the history entry's id on the card. */
  const change = (minute: number, items: FakeJiraChange[], author: FakeJiraPerson = JIRA_ADA): string =>
    eid(at(minute), "h", jira.change("OPS-7", { at: at(minute), author, items }));
  return { jira, ticket, read, plain, comment, change, text: jiraThreadText(() => client) };
}

const STATUS = (from: string, to: string): FakeJiraChange[] => [{ field: "status", from, to }];

describe("a Jira card's window of comments (KTD14)", () => {
  test("a ticket with 30 comments and 3 new opens on the 3 new plus the 5 before, with earlier offered", async () => {
    const s = site();
    const ids = Array.from({ length: 30 }, (_, i) => s.comment(i * 2));
    const { messages, window } = await s.read({ brought_ids: ids.slice(-3) });
    expect(messages.map((m) => m.id)).toEqual(ids.slice(-8));
    expect(messages.map((m) => m.unread === true)).toEqual([false, false, false, false, false, true, true, true]);
    expect(messages.map((m) => m.brought === true)).toEqual([false, false, false, false, false, true, true, true]);
    expect(window).toMatchObject({ more_before: true, more_after: false });
  });

  test("field changes are not messages: the window holds the comments alone, oldest first", async () => {
    const s = site();
    const c1 = s.comment(0);
    s.change(1, STATUS("To Do", "In Progress"));
    const c2 = s.comment(2);
    const { messages } = await s.read();
    expect(messages.map((m) => m.id)).toEqual([c1, c2]);
  });

  test("loading earlier adds 20 older comments in order, and stops offering once the first is shown", async () => {
    const s = site();
    const ids = Array.from({ length: 30 }, (_, i) => s.comment(i * 2));
    for (let i = 0; i < 30; i++) s.change(i * 2 + 1, STATUS("To Do", "In Progress"));
    const first = await s.read({ brought_ids: ids.slice(-3) }, { direction: "before", from: ids[22] });
    expect(first.messages.map((m) => m.id)).toEqual(ids.slice(2, 22));
    expect(first.window.more_before).toBe(true);
    const last = await s.read({ brought_ids: ids.slice(-3) }, { direction: "before", from: ids[2] });
    expect(last.messages.map((m) => m.id)).toEqual(ids.slice(0, 2));
    expect(last.window.more_before).toBe(false);
  });

  test("a ticket longer than a page of comments still opens on what is new and loads the rest", async () => {
    const s = site();
    const ids = Array.from({ length: 130 }, (_, i) => s.comment(i));
    const opened = await s.read({ dealt_message_id: ids[119] });
    expect(opened.messages.map((m) => m.id)).toEqual(ids.slice(115));
    const earlier = await s.read({ dealt_message_id: ids[119] }, { direction: "before", from: ids[115] });
    expect(earlier.messages.map((m) => m.id)).toEqual(ids.slice(95, 115));
  });

  test("comments after the dealt mark are unread; with no dealt mark, only the brought ones are", async () => {
    const s = site();
    const ids = Array.from({ length: 8 }, (_, i) => s.comment(i));
    const dealt = await s.read({ dealt_message_id: ids[4], brought_ids: [ids[7]] });
    expect(dealt.messages.filter((m) => m.unread).map((m) => m.id)).toEqual(ids.slice(5));
    const brought = await s.read({ brought_ids: [ids[5], ids[7]] });
    expect(brought.messages.filter((m) => m.unread).map((m) => m.id)).toEqual([ids[5], ids[7]]);
  });

  test("a dealt mark whose comment was deleted in Jira does not shift which comments are unread", async () => {
    const s = site();
    const before = [s.comment(0), s.comment(1), s.comment(2)];
    const after = [s.comment(4), s.comment(5)];
    // The comment the person last read, at minute 3, is gone from Jira: its id is no longer among the events.
    const gone = eid(at(3), "c", "39999");
    const { messages } = await s.read({ dealt_message_id: gone });
    expect(messages.map((m) => m.id)).toEqual([...before, ...after]);
    expect(messages.filter((m) => m.unread).map((m) => m.id)).toEqual(after);
  });

  test("the person's own comments show as theirs and are never unread", async () => {
    const s = site();
    const theirs = s.comment(0, JIRA_BOB);
    const mine = [s.comment(2, ME), s.comment(3, ME)];
    const { messages } = await s.read({ dealt_message_id: theirs });
    expect(messages.map((m) => [m.id, m.mine, m.unread === true])).toEqual([
      [theirs, false, false],
      [mine[0], true, false],
      [mine[1], true, false],
    ]);
  });

  test("a comment shows its converted text, with who made it and when", async () => {
    const s = site();
    const body = {
      version: 1,
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "Two things:" }] },
        {
          type: "bulletList",
          content: [
            { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "the keys" }] }] },
            { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "the docs" }] }] },
          ],
        },
      ],
    };
    const c = s.jira.comment("OPS-7", { at: at(1), author: JIRA_ADA, body });
    const { messages } = await s.read({ brought_ids: [eid(at(1), "c", c)] });
    expect(messages).toEqual([
      {
        id: eid(at(1), "c", c),
        sender: "Ada Lovelace",
        at: at(1).toISOString(),
        text: "Two things:\n- the keys\n- the docs",
        mine: false,
        unread: true,
        brought: true,
        body: [
          { kind: "text", spans: [{ kind: "text", text: "Two things:" }] },
          { kind: "text", spans: [{ kind: "text", text: "• the keys\n• the docs" }] },
        ],
      },
    ]);
  });

  test("a comment carries its author's picture, its words as the Slack card draws them, and whether it mentions the person (plan 091)", async () => {
    const s = site();
    const avatar = "https://avatar-management.example/ada/48";
    const mention = (who: FakeJiraPerson) => ({ type: "mention", attrs: { id: who.account_id, text: `@${who.display_name}` } });
    const doc = (...content: unknown[]) => ({ version: 1, type: "doc", content: [{ type: "paragraph", content }] });
    const toMe = s.jira.comment("OPS-7", { at: at(1), author: { ...JIRA_ADA, avatar }, body: doc({ type: "text", text: "Over to " }, mention(ME)) });
    const toBob = s.jira.comment("OPS-7", {
      at: at(2),
      author: JIRA_ADA,
      body: doc(mention(JIRA_BOB), { type: "text", text: " can you?", marks: [{ type: "strong" }] }),
    });
    const { messages } = await s.read({ brought_ids: [eid(at(1), "c", toMe), eid(at(2), "c", toBob)] });
    expect(messages[0]).toMatchObject({
      avatar,
      text: "Over to @Mina Example",
      body: [
        {
          kind: "text",
          spans: [
            { kind: "text", text: "Over to " },
            { kind: "mention", text: "@Mina Example" },
          ],
        },
      ],
      mentions_me: true,
    });
    expect(messages[1]).toMatchObject({
      body: [
        {
          kind: "text",
          spans: [
            { kind: "mention", text: "@Bob Stone" },
            { kind: "text", text: " can you?", bold: true },
          ],
        },
      ],
    });
    expect(messages[1]).not.toHaveProperty("avatar");
    expect(messages[1]).not.toHaveProperty("mentions_me");
  });

  test("a field change in the older merged log carries its author's picture, to start a run, but no blocks or mention flag (plan 091)", async () => {
    const s = site();
    const avatar = "https://avatar-management.example/ada/48";
    const h = s.change(1, STATUS("To Do", "Done"), { ...JIRA_ADA, avatar });
    const { messages } = await s.plain({ brought_ids: [h] });
    const change = messages.find((m) => m.id === h);
    expect(change).toMatchObject({ avatar });
    expect(change).not.toHaveProperty("body");
    expect(change).not.toHaveProperty("mentions_me");
  });

  test("the window carries the ticket's address, on the site's own domain when it has one (R14)", async () => {
    const plain = site();
    plain.comment(0);
    expect((await plain.read()).link).toBe("https://acme.atlassian.net/browse/OPS-7");
    const custom = site({ link_host: "jira.acme.example" });
    custom.comment(0);
    expect((await custom.read()).link).toBe("https://jira.acme.example/browse/OPS-7");
  });

  test("a load before a comment carries no ticket: the card already has it", async () => {
    const s = site();
    const ids = Array.from({ length: 3 }, (_, i) => s.comment(i));
    expect((await s.read({}, { direction: "before", from: ids[2] })).ticket).toBeUndefined();
  });
});

describe("a Jira card's ticket (plan 089)", () => {
  test("the card has the summary, type, project, the fields and the description as lines", async () => {
    const s = site();
    s.comment(0);
    const { ticket } = await s.read();
    expect(ticket).toEqual({
      key: "OPS-7",
      summary: "Rotate the keys",
      type: "Task",
      project: "Operations",
      fields: { status: "In Progress", assignee: "Ada Lovelace", reporter: "Bob Stone", priority: "High", sprint: "Sprint 12", labels: ["security"] },
      description: ["Rotate every key.", "Then tell the team."],
      changed: [],
      also_changed: [],
      comment_count: 1,
    });
  });

  test("the comment count is the ticket's, not the window's", async () => {
    const s = site();
    const ids = Array.from({ length: 130 }, (_, i) => s.comment(i));
    const { messages, ticket } = await s.read({ dealt_message_id: ids[127] });
    expect(messages).toHaveLength(7);
    expect(ticket?.comment_count).toBe(130);
  });

  test("a status changed by someone else after the mark is new, with its old value, who and when", async () => {
    const s = site();
    const mark = s.comment(0);
    s.change(1, STATUS("To Do", "In Progress"), JIRA_BOB);
    const { ticket } = await s.read({ dealt_message_id: mark });
    expect(ticket?.changed).toEqual([{ field: "status", from: "To Do", to: "In Progress", by: "Bob Stone", at: at(1).toISOString() }]);
  });

  test("a change at or before the mark is not new", async () => {
    const s = site();
    s.change(0, STATUS("To Do", "In Progress"), JIRA_BOB);
    const mark = s.comment(1);
    const { ticket } = await s.read({ dealt_message_id: mark });
    expect(ticket?.changed).toEqual([]);
  });

  test("two changes to one field since the mark show once, with the first old value and the newest change's who and when", async () => {
    const s = site();
    const mark = s.comment(0);
    s.change(1, STATUS("To Do", "In Review"), JIRA_BOB);
    s.change(2, STATUS("In Review", "In Progress"), JIRA_ADA);
    const { ticket } = await s.read({ dealt_message_id: mark });
    expect(ticket?.changed).toEqual([{ field: "status", from: "To Do", to: "In Progress", by: "Ada Lovelace", at: at(2).toISOString() }]);
  });

  test("the person's own change is not new, and someone else's before it is seen by it", async () => {
    const s = site();
    const mark = s.comment(0);
    s.change(1, STATUS("To Do", "In Review"), JIRA_BOB);
    s.change(2, STATUS("In Review", "In Progress"), ME);
    s.change(3, [{ field: "priority", from: "Low", to: "High" }], ME);
    const { ticket } = await s.read({ dealt_message_id: mark });
    expect(ticket?.changed).toEqual([]);
    expect(ticket?.also_changed).toEqual([]);
  });

  test("a change to a field the card does not show is in also changed, once per field, with the newest who and when", async () => {
    const s = site();
    const mark = s.comment(0);
    s.change(1, [{ field: "Rank", from: null, to: "Ranked higher" }], JIRA_BOB);
    s.change(2, [
      { field: "Rank", from: null, to: "Ranked lower" },
      { field: "Story point estimate", from: "3", to: "5" },
    ]);
    const { ticket } = await s.read({ dealt_message_id: mark });
    expect(ticket?.changed).toEqual([]);
    expect(ticket?.also_changed).toEqual([
      { field: "Rank", by: "Ada Lovelace", at: at(2).toISOString() },
      { field: "Story point estimate", by: "Ada Lovelace", at: at(2).toISOString() },
    ]);
  });

  test("an edited description and summary are marked, the description without its old and new text", async () => {
    const s = site();
    const mark = s.comment(0);
    s.change(1, [
      { field: "description", from: "Rotate the key.", to: "Rotate every key.\nThen tell the team." },
      { field: "summary", from: "Rotate the key", to: "Rotate the keys" },
    ]);
    const { ticket } = await s.read({ dealt_message_id: mark });
    expect(ticket?.changed).toEqual([
      { field: "description", from: null, to: null, by: "Ada Lovelace", at: at(1).toISOString() },
      { field: "summary", from: "Rotate the key", to: "Rotate the keys", by: "Ada Lovelace", at: at(1).toISOString() },
    ]);
  });

  test("with no dealt mark, the changes that brought the card are new", async () => {
    const s = site();
    s.change(0, [{ field: "priority", from: "Low", to: "Medium" }], JIRA_BOB);
    const brought = s.change(1, [{ field: "Sprint", from: "Sprint 11", to: "Sprint 12" }], JIRA_BOB);
    const { ticket } = await s.read({ brought_ids: [brought] });
    expect(ticket?.changed).toEqual([{ field: "Sprint", from: "Sprint 11", to: "Sprint 12", by: "Bob Stone", at: at(1).toISOString() }]);
  });

  test("a site without a sprint field shows no sprint", async () => {
    const s = site();
    s.jira.state.has_sprints = false;
    const { ticket } = await s.read();
    expect(ticket?.fields.sprint).toBeNull();
  });

  test("a ticket with none of the fields shows each as empty", async () => {
    const s = site();
    s.jira.edit("OPS-7", { assignee: null, reporter: null, status: null, priority: null, labels: [], sprints: [], description: null });
    const { ticket } = await s.read();
    expect(ticket?.fields).toEqual({ status: null, assignee: null, reporter: null, priority: null, sprint: null, labels: [] });
    expect(ticket?.description).toEqual([]);
  });
});

describe("a Jira card read by an older app, or when the ticket cannot be read (plan 089)", () => {
  /** A comment, someone else's status change that brought the card, and a later comment. */
  const ticketWithChange = () => {
    const s = site();
    const c1 = s.comment(0);
    const h = s.change(1, STATUS("To Do", "In Progress"));
    const c2 = s.comment(2);
    return { s, c1, h, c2 };
  };
  /** What a merged log shows: each event's id, its text, and whether it is unread and brought. */
  const lines = (messages: ReadonlyArray<{ id?: string; text: string; unread?: boolean; brought?: boolean }>) =>
    messages.map((m) => [m.id, m.text, m.unread === true, m.brought === true]);

  test("a read that does not ask for the ticket gets comments and changes as one log, oldest first, and no ticket", async () => {
    const { s, c1, h, c2 } = ticketWithChange();
    const read = await s.plain({ brought_ids: [h] });
    expect(lines(read.messages)).toEqual([
      [c1, "comment at 0", false, false],
      [h, "status: To Do → In Progress", true, true],
      [c2, "comment at 2", false, false],
    ]);
    expect(read.ticket).toBeUndefined();
    expect(read.link).toBe("https://acme.atlassian.net/browse/OPS-7");
  });

  test("its load of earlier events reads both lists, 20 before the one asked", async () => {
    const s = site();
    const ids = Array.from({ length: 30 }, (_, i) => [s.comment(i * 2), s.change(i * 2 + 1, STATUS("To Do", "In Progress"))]).flat();
    const earlier = await s.plain({}, { direction: "before", from: ids[40] });
    expect(earlier.messages.map((m) => m.id)).toEqual(ids.slice(20, 40));
    expect(earlier.window.more_before).toBe(true);
  });

  test("a read that asks for the ticket gets the comments alone and the ticket", async () => {
    const { s, c1, c2 } = ticketWithChange();
    const read = await s.read();
    expect(read.messages.map((m) => m.id)).toEqual([c1, c2]);
    expect(read.ticket?.key).toBe("OPS-7");
  });

  test("when the ticket's fields cannot be read, the card gets the one log instead, without the ticket", async () => {
    const { s, c1, h, c2 } = ticketWithChange();
    s.jira.state.broken = { read: "issue", status: 500 };
    const read = await s.read({ brought_ids: [h] });
    expect(lines(read.messages)).toEqual([
      [c1, "comment at 0", false, false],
      [h, "status: To Do → In Progress", true, true],
      [c2, "comment at 2", false, false],
    ]);
    expect(read.ticket).toBeUndefined();
  });

  test("so too when the site's list of fields cannot be read", async () => {
    const { s, c1, h, c2 } = ticketWithChange();
    s.jira.state.broken = { read: "field", status: 500 };
    const read = await s.read();
    expect(read.messages.map((m) => m.id)).toEqual([c1, h, c2]);
    expect(read.ticket).toBeUndefined();
  });

  test("a refused token still fails the read, so the card says to reconnect", async () => {
    const { s } = ticketWithChange();
    s.jira.state.broken = { read: "issue", status: 401 };
    await expect(s.read()).rejects.toThrow("Jira did not accept the API token");
  });
});

describe("a Jira ticket read whole, for a hand-off", () => {
  test("the ticket first, then every comment oldest first across pages, then the field history", async () => {
    const s = site();
    const comments = Array.from({ length: 60 }, (_, i) => s.comment(i * 2, i === 7 ? ME : JIRA_ADA));
    const changes = Array.from({ length: 60 }, (_, i) => s.change(i * 2 + 1, STATUS("To Do", "In Progress")));
    const messages = await s.text(ID, s.ticket);
    expect(messages).toHaveLength(121);
    expect(messages[0]).toEqual({
      sender: "Bob Stone",
      at: at(0).toISOString(),
      text: [
        "OPS-7: Rotate the keys",
        "type: Task",
        "project: Operations",
        "status: In Progress",
        "assignee: Ada Lovelace",
        "reporter: Bob Stone",
        "priority: High",
        "sprint: Sprint 12",
        "labels: security",
        "",
        "description:",
        "Rotate every key.",
        "Then tell the team.",
      ].join("\n"),
    });
    expect(messages.slice(1).map((m) => m.id)).toEqual([...comments, ...changes]);
    expect(messages.filter((m) => m.mine).map((m) => m.id)).toEqual([comments[7]]);
    expect(messages[61]).toEqual({ id: changes[0], sender: "Ada Lovelace", at: at(1).toISOString(), text: "status: To Do → In Progress", mine: false });
  });
});

describe("a Jira comment's files on its card (plan 092)", () => {
  const SHOT = { id: "10042", filename: "shot.png", mime_type: "image/png", size: 48_000 };
  const REPORT = { id: "10043", filename: "report.pdf", mime_type: "application/pdf", size: 2048 };
  /** A comment whose document is words and then a picture of `alt`, sized as Jira's editor sizes one. */
  const picture = (alt: string | null, words = "Here it is") => ({
    version: 1,
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: words }] },
      {
        type: "mediaSingle",
        content: [{ type: "media", attrs: { id: "uuid-1", type: "file", collection: "", width: 1200, height: 800, ...(alt ? { alt } : {}) } }],
      },
    ],
  });
  /** A comment of only a file of `alt`, as a group of files holds one. */
  const file = (alt: string) => ({
    version: 1,
    type: "doc",
    content: [{ type: "mediaGroup", content: [{ type: "media", attrs: { id: "uuid-2", type: "file", collection: "", alt } }] }],
  });
  /** A site whose previews are recorded and named after the attachment. */
  function withPreviews(over: { link_host?: string } = {}, gives = true) {
    const asked: string[] = [];
    const s = site(over, (accountId, attachmentId) => {
      asked.push(`${accountId}|${attachmentId}`);
      return Promise.resolve(gives ? `${"a".repeat(31)}${attachmentId.slice(-1)}.png` : null);
    });
    const say = (minute: number, body: unknown) => eid(at(minute), "c", s.jira.comment("OPS-7", { at: at(minute), author: JIRA_ADA, body }));
    const lists = () => s.jira.requests.filter((r) => r.url.searchParams.get("fields") === "attachment").length;
    return { ...s, asked, say, lists };
  }

  test("a picture matched by its name is a chip with its kind, size, file address and preview", async () => {
    const s = withPreviews();
    s.jira.edit("OPS-7", { attachments: [SHOT] });
    const id = s.say(1, picture("shot.png"));
    const { messages } = await s.read({ brought_ids: [id] });
    const m = messages.find((x) => x.id === id);
    expect(m?.slack_files).toEqual([
      {
        name: "shot.png",
        kind: "PNG",
        size: 48_000,
        link: `https://${s.jira.host}/rest/api/3/attachment/content/10042`,
        preview: { name: `${"a".repeat(31)}2.png`, width: 1200, height: 800 },
      },
    ]);
    expect(s.asked).toEqual([`${ID}|10042`]);
    expect(m?.text).toBe("Here it is\nfile: shot.png");
    expect(m?.body).toEqual([{ kind: "text", spans: [{ kind: "text", text: "Here it is" }] }]);
  });

  test("a PDF is matched without asking for a preview", async () => {
    const s = withPreviews();
    s.jira.edit("OPS-7", { attachments: [SHOT, REPORT] });
    const id = s.say(1, file("report.pdf"));
    const { messages } = await s.read({ brought_ids: [id] });
    expect(messages.find((x) => x.id === id)?.slack_files).toEqual([
      { name: "report.pdf", kind: "PDF", size: 2048, link: `https://${s.jira.host}/rest/api/3/attachment/content/10043` },
    ]);
    expect(s.asked).toEqual([]);
  });

  test("a name two attachments share, or none has, is a chip that opens the ticket, on the site's own domain", async () => {
    const s = withPreviews({ link_host: "jira.acme.example" });
    s.jira.edit("OPS-7", { attachments: [SHOT, { ...SHOT, id: "10044" }] });
    const twice = s.say(1, picture("shot.png"));
    const gone = s.say(2, file("old.txt"));
    const unnamed = s.say(3, picture(null));
    const { messages } = await s.read({ brought_ids: [twice, gone, unnamed] });
    const files = (id: string) => messages.find((x) => x.id === id)?.slack_files;
    const ticket = "https://jira.acme.example/browse/OPS-7";
    expect(files(twice)).toEqual([{ name: "shot.png", kind: null, size: null, link: ticket }]);
    expect(files(gone)).toEqual([{ name: "old.txt", kind: null, size: null, link: ticket }]);
    expect(files(unnamed)).toEqual([{ name: "attachment", kind: null, size: null, link: ticket }]);
    expect(s.asked).toEqual([]);
  });

  test("a picture whose thumbnail cannot be had, or whose size the document left out, stays a chip", async () => {
    const s = withPreviews({}, false);
    s.jira.edit("OPS-7", { attachments: [SHOT, { ...SHOT, id: "10045", filename: "plain.png" }] });
    const noThumb = s.say(1, picture("shot.png"));
    const noSize = s.say(2, file("plain.png"));
    const { messages } = await s.read({ brought_ids: [noThumb, noSize] });
    const files = (id: string) => messages.find((x) => x.id === id)?.slack_files;
    const content = (id: string) => `https://${s.jira.host}/rest/api/3/attachment/content/${id}`;
    expect(files(noThumb)).toEqual([{ name: "shot.png", kind: "PNG", size: 48_000, link: content("10042") }]);
    expect(files(noSize)).toEqual([{ name: "plain.png", kind: "PNG", size: 48_000, link: content("10045") }]);
    // Only the picture with a size is asked for; the one without is never fetched.
    expect(s.asked).toEqual([`${ID}|10042`]);
  });

  test("an external file opens its own address", async () => {
    const s = withPreviews();
    const external = {
      version: 1,
      type: "doc",
      content: [{ type: "mediaSingle", content: [{ type: "media", attrs: { type: "external", url: "https://example.com/cat.gif", alt: "cat.gif" } }] }],
    };
    const id = s.say(1, external);
    const { messages } = await s.read({ brought_ids: [id] });
    expect(messages.find((x) => x.id === id)?.slack_files).toEqual([{ name: "cat.gif", kind: null, size: null, link: "https://example.com/cat.gif" }]);
    expect(s.asked).toEqual([]);
  });

  test("a window without files reads no attachment list, and one with files reads it once", async () => {
    const s = withPreviews();
    s.jira.edit("OPS-7", { attachments: [SHOT, REPORT] });
    const plainOnly = s.comment(1);
    await s.read({ brought_ids: [plainOnly] });
    expect(s.lists()).toBe(0);
    const a = s.say(2, picture("shot.png"));
    const b = s.say(3, file("report.pdf"));
    await s.read({ brought_ids: [a, b] });
    expect(s.lists()).toBe(1);
  });

  test("an attachment list that cannot be read leaves the files as ticket chips, and the card still reads", async () => {
    const s = withPreviews();
    s.jira.edit("OPS-7", { attachments: [SHOT] });
    const id = s.say(1, picture("shot.png"));
    // A failed issue read fails the attachment list, which is read from the issue; the card falls back to its log.
    s.jira.state.broken = { read: "issue", status: 500 };
    const { messages } = await s.read({ brought_ids: [id] });
    expect(messages.find((x) => x.id === id)?.slack_files).toEqual([{ name: "shot.png", kind: null, size: null, link: `https://${s.jira.host}/browse/OPS-7` }]);
  });

  test("a load of earlier comments and the older merged log match their files too", async () => {
    const s = withPreviews();
    s.jira.edit("OPS-7", { attachments: [REPORT] });
    const early = s.say(1, file("report.pdf"));
    const later = Array.from({ length: 30 }, (_, i) => s.comment(i + 2));
    const earlier = await s.read({ brought_ids: later.slice(-1) }, { direction: "before", from: later[0] });
    expect(earlier.messages.find((x) => x.id === early)?.slack_files?.[0]?.link).toBe(`https://${s.jira.host}/rest/api/3/attachment/content/10043`);
    const merged = await s.plain({ brought_ids: [early] });
    expect(merged.messages.find((x) => x.id === early)?.slack_files?.[0]?.kind).toBe("PDF");
  });

  test("a hand-off names the file in the comment's text", async () => {
    const s = withPreviews();
    s.say(1, file("report.pdf"));
    const all = await s.text(ID, "OPS-7");
    expect(all.some((m) => m.text === "file: report.pdf")).toBe(true);
  });
});

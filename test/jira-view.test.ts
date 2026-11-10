import { describe, expect, test } from "vitest";
import type { OutsideWindowAsk } from "../core/frame-types.ts";
import { JiraClient, type JiraSecret } from "../mod/jira.ts";
import { jiraCardView, jiraThreadText } from "../mod/jira-view.ts";
import type { CardFacts } from "../mod/slack-view.ts";
import { JIRA_ADA, JIRA_BOB, fakeJira, type FakeJiraPerson } from "./fixtures/jira.ts";

/** Reading a Jira ticket on its card and for a hand-off (plan 2026-11-10-1451, U5, KTD14). */

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
function site(over: { link_host?: string } = {}) {
  const clock = () => at(1000);
  const jira = fakeJira({ now: clock, me: ME });
  const ticket = jira.addTicket({ key: "OPS-7", summary: "Rotate the keys", at: at(0) });
  const secret: JiraSecret = { site: jira.host, email: jira.state.email, token: jira.state.token, ...over };
  const client = new JiraClient({ secret: () => Promise.resolve(secret), setStatus: () => {}, fetch: jira.fetch, now: clock });
  const view = jiraCardView(
    () => client,
    () => Promise.resolve(secret),
  );
  const facts = (f: Partial<CardFacts> = {}): CardFacts => ({ dealt_message_id: null, brought_ids: [], newest_message_id: null, place: "OPS-7", ...f });
  const read = (f: Partial<CardFacts> = {}, ask: OutsideWindowAsk = {}) => view(ID, ticket, facts(f), ask);
  /** Someone comments (even minutes) or changes the status (odd minutes); returns the event's id on the card. */
  const event = (minute: number, author: FakeJiraPerson = JIRA_ADA): string =>
    minute % 2 === 0
      ? eid(at(minute), "c", jira.comment("OPS-7", { at: at(minute), author, text: `comment at ${String(minute)}` }))
      : eid(at(minute), "h", jira.change("OPS-7", { at: at(minute), author, items: [{ field: "status", from: "To Do", to: "In Progress" }] }));
  return { jira, ticket, read, event, text: jiraThreadText(() => client) };
}

describe("a Jira card's window (KTD14)", () => {
  test("a ticket with 30 events and 3 new opens on the 3 new plus the 5 before, with earlier offered", async () => {
    const s = site();
    const ids = Array.from({ length: 30 }, (_, i) => s.event(i));
    const { messages, window } = await s.read({ brought_ids: ids.slice(-3) });
    expect(messages.map((m) => m.id)).toEqual(ids.slice(-8));
    expect(messages.map((m) => m.unread === true)).toEqual([false, false, false, false, false, true, true, true]);
    expect(messages.map((m) => m.brought === true)).toEqual([false, false, false, false, false, true, true, true]);
    expect(window).toMatchObject({ more_before: true, more_after: false });
  });

  test("loading earlier adds 20 older events in order, and stops offering once the first event is shown", async () => {
    const s = site();
    const ids = Array.from({ length: 30 }, (_, i) => s.event(i));
    const first = await s.read({ brought_ids: ids.slice(-3) }, { direction: "before", from: ids[22] });
    expect(first.messages.map((m) => m.id)).toEqual(ids.slice(2, 22));
    expect(first.window.more_before).toBe(true);
    const last = await s.read({ brought_ids: ids.slice(-3) }, { direction: "before", from: ids[2] });
    expect(last.messages.map((m) => m.id)).toEqual(ids.slice(0, 2));
    expect(last.window.more_before).toBe(false);
  });

  test("a ticket longer than a page of each list still opens on what is new and loads the rest", async () => {
    const s = site();
    const ids = Array.from({ length: 130 }, (_, i) => s.event(i));
    const opened = await s.read({ dealt_message_id: ids[119] });
    expect(opened.messages.map((m) => m.id)).toEqual(ids.slice(115));
    const earlier = await s.read({ dealt_message_id: ids[119] }, { direction: "before", from: ids[115] });
    expect(earlier.messages.map((m) => m.id)).toEqual(ids.slice(95, 115));
  });

  test("events after the dealt mark are unread; with no dealt mark, only the brought events are", async () => {
    const s = site();
    const ids = Array.from({ length: 8 }, (_, i) => s.event(i));
    const dealt = await s.read({ dealt_message_id: ids[4], brought_ids: [ids[7]] });
    expect(dealt.messages.filter((m) => m.unread).map((m) => m.id)).toEqual(ids.slice(5));
    const brought = await s.read({ brought_ids: [ids[5], ids[7]] });
    expect(brought.messages.filter((m) => m.unread).map((m) => m.id)).toEqual([ids[5], ids[7]]);
  });

  test("a dealt mark whose event was deleted in Jira does not shift which events are unread", async () => {
    const s = site();
    const before = [s.event(0), s.event(1), s.event(2)];
    const after = [s.event(4), s.event(5)];
    // The comment the person last read, at minute 3, is gone from Jira: its id is no longer among the events.
    const gone = eid(at(3), "c", "39999");
    const { messages } = await s.read({ dealt_message_id: gone });
    expect(messages.map((m) => m.id)).toEqual([...before, ...after]);
    expect(messages.filter((m) => m.unread).map((m) => m.id)).toEqual(after);
  });

  test("the person's own events show as theirs and are never unread", async () => {
    const s = site();
    const theirs = s.event(0, JIRA_BOB);
    const mine = [s.event(2, ME), s.event(3, ME)];
    const { messages } = await s.read({ dealt_message_id: theirs });
    expect(messages.map((m) => [m.id, m.mine, m.unread === true])).toEqual([
      [theirs, false, false],
      [mine[0], true, false],
      [mine[1], true, false],
    ]);
  });

  test("a comment shows its converted text, a status change its one line, each with who made it and when", async () => {
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
    const h = s.jira.change("OPS-7", { at: at(2), author: JIRA_BOB, items: [{ field: "status", from: "To Do", to: "In Progress" }] });
    const { messages } = await s.read({ brought_ids: [eid(at(2), "h", h)] });
    expect(messages).toEqual([
      { id: eid(at(1), "c", c), sender: "Ada Lovelace", at: at(1).toISOString(), text: "Two things:\n- the keys\n- the docs", mine: false },
      { id: eid(at(2), "h", h), sender: "Bob Stone", at: at(2).toISOString(), text: "status: To Do → In Progress", mine: false, unread: true, brought: true },
    ]);
  });

  test("the window carries the ticket's address, on the site's own domain when it has one (R14)", async () => {
    const plain = site();
    plain.event(0);
    expect((await plain.read()).link).toBe("https://acme.atlassian.net/browse/OPS-7");
    const custom = site({ link_host: "jira.acme.example" });
    custom.event(0);
    expect((await custom.read()).link).toBe("https://jira.acme.example/browse/OPS-7");
  });
});

describe("a Jira ticket read whole, for a hand-off", () => {
  test("every comment and history entry, oldest first, across pages, with the person's own marked", async () => {
    const s = site();
    const ids = Array.from({ length: 120 }, (_, i) => s.event(i, i === 7 ? ME : JIRA_ADA));
    const messages = await s.text(ID, s.ticket);
    expect(messages.map((m) => m.id)).toEqual(ids);
    expect(messages.filter((m) => m.mine).map((m) => m.id)).toEqual([ids[7]]);
    expect(messages[1]).toEqual({ id: ids[1], sender: "Ada Lovelace", at: at(1).toISOString(), text: "status: To Do → In Progress", mine: false });
  });
});

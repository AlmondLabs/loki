import { describe, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { OutsideFacts, OutsideMessage } from "../core/frame-types.ts";
import { OutsideThread } from "../app/src/desk/outside-card.tsx";
import { ItemMailThread } from "../app/src/item/outside-rows.tsx";

// Plan 097, U7: an outside card's thread drawn with the item components. The thread keeps its own window, loading,
// scrolling and reacting; these check the rows and the seam.

const html = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(el);
const facts = (over: Partial<OutsideFacts> = {}): OutsideFacts => ({
  account_id: "slack:acme",
  provider: "slack",
  account_label: "acme",
  thread_id: "C1:1.0",
  generation: 0,
  owner_agent_id: "agent-work",
  owner_name: "friday",
  sender: "Priya Raman",
  sender_address: null,
  subject: "launch review",
  lines: ["Can we move it?"],
  newest_message_id: "3.0",
  newest_at: "2026-11-11T10:31:00.000Z",
  handoff_conversation_id: null,
  disconnected: null,
  place: "#web-launch",
  ...over,
});
const msg = (id: string, over: Partial<OutsideMessage> = {}): OutsideMessage => ({ id, sender: "Priya Raman", at: "", text: "hello", mine: false, ...over });
const SLACK = [
  msg("1.0", {
    at: "2026-11-11T10:12:00.000Z",
    text: "Can we move the review to Thursday?",
    reactions: [{ name: "+1", count: 2, mine: true, emoji: { kind: "emoji", text: "👍" } }],
  }),
  msg("2.0", { at: "2026-11-11T10:13:00.000Z", text: "The venue fell through." }),
  msg("3.0", { at: "2026-11-11T10:31:00.000Z", sender: "Ada", text: "Thursday at 3pm works.", mine: true }),
];
const read = (messages: OutsideMessage[]) => ({ kind: "read" as const, messages });

describe("the outside thread's seam", () => {
  test("today's Slack rows by default, the item's rows with items on", () => {
    const today = html(createElement(OutsideThread, { facts: facts(), state: read(SLACK) }));
    expect(today).not.toContain("data-row-item");
    const items = html(createElement(OutsideThread, { facts: facts(), state: read(SLACK), items: true }));
    expect(items).toContain("data-row-item");
    expect(items).toContain('data-row="person"');
    expect(items).toContain('data-row="user"');
  });

  test("a run from one sender shows their name once, and the person's own reaction is marked", () => {
    const out = html(createElement(OutsideThread, { facts: facts(), state: read(SLACK), items: true }));
    expect(out.match(/Priya Raman/g)?.length).toBe(1);
    expect(out).toContain('data-mine="true"');
  });

  test("a Jira comment has no reactions even when its message carries some", () => {
    const out = html(
      createElement(OutsideThread, {
        facts: facts({ provider: "jira", place: "WEB-412" }),
        state: read([msg("c1", { sender: "Lena", reactions: [{ name: "+1", count: 1, mine: false, emoji: null }] })]),
        items: true,
      }),
    );
    expect(out).toContain("Lena");
    expect(out).not.toContain("data-reactions");
  });

  test("the phone keeps its own list whatever items says", () => {
    expect(html(createElement(OutsideThread, { facts: facts(), state: read(SLACK), touch: true, items: true }))).not.toContain("data-row-item");
  });

  test("while the thread is read, the card's last lines stand in, as today", () => {
    expect(html(createElement(OutsideThread, { facts: facts(), state: { kind: "loading" }, items: true }))).toContain("reading the whole thread");
  });
});

describe("an email thread on the item components", () => {
  const mails = [
    msg("m1", { sender: '"Northwind billing" <billing@northwind.example>', text: "October's invoice.", at: "2026-10-11T08:15:00Z" }),
    msg("m2", {
      sender: '"Northwind billing" <billing@northwind.example>',
      text: "November's invoice.",
      at: "2026-11-11T08:15:00Z",
      to: "ada@example.com",
      files: [{ name: "invoice-2026-11.pdf", size: 86_000 }],
    }),
  ];

  test("folds every mail but the newest to a line, and opens the newest with its address and files", () => {
    const out = html(createElement(ItemMailThread, { messages: mails, own: ["ada@example.com"], now: new Date("2026-11-11T12:00:00Z") }));
    expect(out).toContain('aria-expanded="false"');
    expect(out).toContain("October&#x27;s invoice.");
    expect(out).toContain("billing@northwind.example");
    expect(out).toContain("invoice-2026-11.pdf");
  });

  test("the seam draws it for a mail card with items on", () => {
    const out = html(createElement(OutsideThread, { facts: facts({ provider: "gmail", place: null }), state: read(mails), items: true }));
    expect(out).toContain("data-mail-thread");
  });
});

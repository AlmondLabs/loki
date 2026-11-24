import { describe, expect, test } from "vitest";
import { must } from "./fixtures/must.ts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { MailCompose, OutsideFacts, OutsideMessage } from "../core/frame-types.ts";
import { OutsideReply, OutsideThread, type ReplyBoxControl } from "../app/src/desk/outside-card.tsx";
import { ItemMailThread } from "../app/src/item/outside-rows.tsx";
import { reactTarget, rowReacting } from "../app/src/desk/slack-thread.tsx";
import { QUICK_EMOJI } from "../app/src/desk/slack-reactions.tsx";

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
  test("the plain Slack rows without items, the item's rows with items on", () => {
    const plain = html(createElement(OutsideThread, { facts: facts(), state: read(SLACK) }));
    expect(plain).not.toContain("data-row-item");
    const items = html(createElement(OutsideThread, { facts: facts(), state: read(SLACK), items: true }));
    expect(items).toContain("data-row-item");
    expect(items.match(/data-row="person"/g)?.length).toBe(3);
    expect(items).not.toContain('data-row="user"');
    expect(items).toContain(">You<");
  });

  test("a run from one sender shows their name once, and the person's own reaction is marked", () => {
    const out = html(createElement(OutsideThread, { facts: facts(), state: read(SLACK), items: true }));
    expect(out.match(/Priya Raman/g)?.length).toBe(1);
    expect(out).toContain('data-mine="true"');
  });

  test("a refused reaction says why under its message in the item's rows too", () => {
    const text = "Couldn't remove the reaction: Slack reactions.remove failed: not_authed";
    const controls = { load: () => {}, openThread: () => {}, busy: null, react: () => {}, refusal: { messageId: "1.0", text } };
    const out = html(createElement(OutsideThread, { facts: facts(), state: { ...read(SLACK), controls }, items: true }));
    const drawn = text.replace("'", "&#x27;");
    expect(out.split(drawn)).toHaveLength(2);
    expect(out.indexOf(drawn)).toBeLessThan(out.indexOf("The venue fell through."));
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

  test("a mail draws its Gmail reactions as pills titled by the emoji, folded mails too, where nothing can be pressed", () => {
    const thumbs = { name: "+1::skin-tone-4", count: 2, mine: true, emoji: { kind: "emoji" as const, text: "👍🏽" } };
    const odd = { name: "cp-1fae9", count: 1, mine: false, emoji: { kind: "emoji" as const, text: "\u{1FAE9}" } };
    const mails = [
      msg("m1", { sender: "Ana <ana@northwind.test>", text: "The draft is ready", reactions: [thumbs] }),
      msg("m2", { sender: "Ben <ben@northwind.test>", text: "Looks good", reactions: [odd] }),
    ];
    const out = html(createElement(ItemMailThread, { messages: mails, own: ["ada@acme.com"] }));
    expect(out).toContain("data-folded-reactions");
    expect(out).toContain('title="👍🏽"');
    expect(out).toContain('title="\u{1FAE9}"');
    expect(out).not.toContain(":+1::skin-tone-4:");
    expect(out).not.toContain(":cp-1fae9:");
    expect(out).toContain('data-mine="true"');
    expect(out.match(/<button/g)?.length).toBe(2);
  });

  test("the phone keeps its own list whatever items says", () => {
    expect(html(createElement(OutsideThread, { facts: facts(), state: read(SLACK), touch: true, items: true }))).not.toContain("data-row-item");
  });

  test("while the thread is read, the card's last lines stand in", () => {
    expect(html(createElement(OutsideThread, { facts: facts(), state: { kind: "loading" }, items: true }))).toContain("Reading the whole thread");
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

describe("the outside reply box on the Composer", () => {
  const box = (over: Partial<ReplyBoxControl> = {}): ReplyBoxControl => ({
    text: "",
    mail: null,
    busy: false,
    error: null,
    onText: () => {},
    onMail: () => {},
    onSend: () => {},
    ...over,
  });
  const compose: MailCompose = {
    modes: { reply: { to: ["billing@northwind.example"], cc: [] }, reply_all: { to: ["billing@northwind.example"], cc: ["finance@example.com"] } },
    from: [{ address: "ada@example.com", name: "Ada", signature: "Ada\nExample Co" }],
    default_from: "ada@example.com",
    subject: "Your invoice",
    people: [],
  };

  test("the plain box without items (the phone's); the Composer with items, saying where a Slack reply goes, with the card's moves under it", () => {
    const plain = html(createElement(OutsideReply, { facts: facts(), box: box(), actions: createElement("span", null, "the moves") }));
    expect(plain).not.toContain("data-reply-box");
    const items = html(
      createElement(OutsideReply, {
        facts: facts({ thread_id: "C1:1.0" }),
        box: box({ text: "Thursday works." }),
        actions: createElement("span", null, "the moves"),
        items: true,
      }),
    );
    expect(items).toContain("data-reply-box");
    expect(items).toMatch(/data-target[^>]*>Reply in the thread</);
    expect(items).toContain("Thursday works.");
    expect(items).toContain('aria-label="Send"');
    expect(items).toContain("the moves");
  });

  test("send waits for words, and a failed send says why", () => {
    const empty = html(createElement(OutsideReply, { facts: facts(), box: box(), items: true }));
    expect(empty).toMatch(/aria-label="Send"[^>]*disabled|disabled[^>]*aria-label="Send"/);
    expect(html(createElement(OutsideReply, { facts: facts(), box: box({ text: "x", error: "Slack refused it" }), items: true }))).toContain(
      "Slack refused it",
    );
  });

  test("a mail's box has its recipients line on top, its signature, the quoted mail and discard; the moves stay on the card", () => {
    const out = html(
      createElement(OutsideReply, {
        facts: facts({ provider: "gmail", place: null }),
        box: box({ text: "Thanks." }),
        compose,
        quote: "Your invoice for November is attached.",
        actions: createElement("span", null, "the moves"),
        items: true,
      }),
    );
    expect(out).toContain("billing@northwind.example");
    expect(out).toContain("Example Co");
    expect(out).toContain('aria-label="Show the Quoted Mail"');
    expect(out).toContain(">Discard<");
    expect(out).not.toContain("the moves");
  });
});

describe("reacting on a mail card (plan 2026-11-23-1800, U7)", () => {
  const thumbs = (mine: boolean) => ({ name: "+1", count: 1, mine, emoji: { kind: "emoji" as const, text: "👍" } });
  const mails = (over: Partial<OutsideMessage> = {}) => [
    msg("m1", { sender: "Ana <ana@northwind.test>", text: "The draft", reactable: true }),
    msg("m2", { sender: "Ben <ben@northwind.test>", text: "Looks good", reactable: true, ...over }),
  ];
  const controls = () => {
    const sent: Array<[string, string, boolean]> = [];
    return { sent, react: (id: string, c: { name: string }, on: boolean) => void sent.push([id, c.name, on]), quick: [...QUICK_EMOJI] };
  };
  const row = (m: OutsideMessage, c: ReturnType<typeof controls>) => rowReacting(m, c, { picking: null, setPicking: () => {}, final: true });

  test("Covers AE3. a mail that takes reactions has the hover bar with 👀 ✅ 👍 and the picker", () => {
    const out = html(createElement(ItemMailThread, { messages: mails(), own: [], newest: "m2", reacting: controls() }));
    expect(out).toContain("loki-slack-hoverbar");
    expect(out.indexOf("👀")).toBeLessThan(out.indexOf("✅"));
    expect(out.indexOf("✅")).toBeLessThan(out.indexOf("👍"));
    expect(out).not.toContain("🙏");
    expect(out).toContain('aria-label="Add a reaction"');
  });

  test("Covers AE3. the person's own pill says a mail reaction can't be taken back, and neither it nor that emoji sends anything", () => {
    const c = controls();
    const messages = mails({ reactions: [thumbs(true)] });
    const out = html(createElement(ItemMailThread, { messages, own: [], newest: "m2", reacting: c }));
    expect(out).toContain('title="A mail reaction can&#x27;t be taken back"');
    expect(out).toContain('aria-disabled="true"');
    const r = must(row(must(messages[1], "Ben's mail"), c), "Ben's mail reacting");
    r.toggle(thumbs(true));
    r.pick({ name: "thumbsup", emoji: { kind: "emoji", text: "👍" } });
    expect(c.sent).toEqual([]);
  });

  test("pressing someone else's 👍 pill adds the person's", () => {
    const c = controls();
    const messages = mails({ reactions: [thumbs(false)] });
    must(row(must(messages[1], "Ben's mail"), c), "Ben's mail reacting").toggle(thumbs(false));
    expect(c.sent).toEqual([["m2", "+1", true]]);
  });

  test("Covers AE4. a mail Gmail takes no reaction for has no hover bar, its pills don't respond, and ⌘⇧\\ opens nothing", () => {
    const c = controls();
    const messages = mails({ reactable: undefined, reactions: [thumbs(false)] });
    const out = html(createElement(ItemMailThread, { messages, own: [], newest: "m2", reacting: c }));
    expect(out).not.toContain("loki-slack-hoverbar");
    expect(out).toMatch(/<button[^>]*\sdisabled=""/);
    expect(row(must(messages[1], "Ben's mail"), c)).toBeUndefined();
    expect(reactTarget(messages, "m2", true)).toBeNull();
    expect(reactTarget(mails(), "m2", true)).toBe("m2");
  });

  test("Covers AE5. a refused reaction says why under that mail", () => {
    const reacting = { ...controls(), refusal: { messageId: "m2", text: "Couldn't add the reaction: Gmail said no" } };
    const out = html(createElement(ItemMailThread, { messages: mails(), own: [], newest: "m2", reacting }));
    expect(out).toContain("Couldn&#x27;t add the reaction: Gmail said no");
  });
});

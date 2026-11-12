import { describe, expect, test } from "vitest";
import { emptyLive } from "../core/attention/model.ts";
import type { JiraCardTicket, OutsideFacts, OutsideMessage, ReplyProposal, Suggestion } from "../core/frame-types.ts";
import type { TranscriptRow } from "../core/attention/transcript.ts";
import { threadEntries, threadTurns } from "../app/src/item/entries.ts";
import { chatItem, outsideItem, type ItemEntry } from "../app/src/item/item-view.ts";
import { attentionItem } from "./fixtures/attention.ts";

// Plan 097, U2: every source becomes one ItemView, built without rendering. What loki has no data for stays empty.

const NOW = Date.parse("2026-11-11T15:00:00Z");

const turnsOf = (rows: TranscriptRow[]) =>
  threadTurns(threadEntries({ rows, from: 0, above: 0, dividerAt: null, dividerDay: null, widgets: [], busy: false, arrivedFrom: rows.length, now: NOW }), {
    busy: false,
    waiting: false,
  });

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
  subject: "Can we move the launch review to Thursday?",
  lines: [],
  newest_message_id: "3.0",
  newest_at: "2026-11-11T10:31:00.000Z",
  handoff_conversation_id: null,
  disconnected: null,
  ...over,
});

const msg = (id: string, over: Partial<OutsideMessage> = {}): OutsideMessage => ({ id, sender: "Priya Raman", at: "", text: "hello", mine: false, ...over });

const kinds = (entries: ItemEntry[]) => entries.map((e) => e.kind);

describe("an agent chat", () => {
  const rows: TranscriptRow[] = [
    { role: "user", text: "chart signups by week", at: "2026-11-11T14:40:00Z" },
    { role: "tool", text: "Bash · python chart.py", tool: { name: "Bash", output: "boom", failed: true }, at: "2026-11-11T14:41:00Z" },
    { role: "event", text: "context compacted", at: "2026-11-11T14:45:00Z" },
    { role: "assistant", text: "Week 9 stands out.", at: "2026-11-11T14:46:00Z" },
  ];

  test("reads as your message, then one agent turn holding the failed work and the event; titled by its name", () => {
    const item = attentionItem("Signups by week", { agent_name: "friday", status: "running", cwd: "/work/reports", labels: [] });
    const view = chatItem({ item, live: null, turns: turnsOf(rows) });
    expect(view.source).toBe("chat");
    expect(view.header.title).toBe("Signups by week");
    expect(view.header.properties.map((p) => p.label)).toEqual(["friday · working", "reports"]);
    expect(kinds(view.entries).filter((k) => k !== "day")).toEqual(["chat_message", "turn"]);
    const turn = view.entries.find((e) => e.kind === "turn");
    expect(turn?.kind === "turn" && turn.failed).toBe(1);
    expect(turn?.kind === "turn" && turn.parts.map((p) => p.kind)).toEqual(["steps", "event", "message"]);
  });

  test("a waiting approval, question, reply and suggestion each become a proposal of their own kind", () => {
    const reply: ReplyProposal = {
      id: "rp1",
      account_id: "slack:acme",
      provider: "slack",
      account_label: "acme",
      thread_id: "C1:1.0",
      subject: "launch review",
      to: [],
      cc: [],
      place: "the thread in #web-launch",
      text: "Thursday at 3pm works.",
      status: "pending",
      reason: null,
      created_at: "2026-11-11T10:20:00Z",
    };
    const suggestion: Suggestion = {
      id: "s1",
      title: "cookie migration",
      text: "Check whether the Safari fix needs a cookie migration.",
      target: { agent_id: "ops", conversation_id: "deploys" },
      status: "pending",
      created_at: "2026-11-11T10:21:00Z",
    };
    const live = {
      ...emptyLive(),
      pending: { requestId: "r1", toolName: "codemode", input: { path: "a" }, at: "2026-11-11T10:00:00Z" },
      pendingAsk: { requestId: "q1", input: {}, questions: [{ question: "Which week?", options: [], multiSelect: false }], at: "2026-11-11T10:01:00Z" },
      replyProposals: [reply, { ...reply, id: "rp2", status: "drafting" as const }],
      suggestions: [suggestion, { ...suggestion, id: "s2", status: "sent" as const }],
    };
    const view = chatItem({ item: attentionItem("c1"), live, turns: [] });
    expect(view.proposals.map((p) => p.kind)).toEqual(["approval", "question", "reply", "suggestion"]);
    const approval = view.proposals[0];
    // A script is new code at every call, so its approval never offers "always".
    expect(approval.kind === "approval" && approval.always).toBe(false);
  });

  test("an unread chat is flagged, a read one is not; a saved draft seeds the composer, which has one voice", () => {
    const unread = chatItem({ item: attentionItem("c1", { unread: true, draft_text: "also add week 14" }), live: null, turns: [] });
    expect(unread.header.flags).toEqual(["unread"]);
    expect(unread.composer).toMatchObject({ voices: ["you"], seeds: ["also add week 14"] });
    expect(chatItem({ item: attentionItem("c1", { unread: false }), live: null, turns: [] }).header.flags).toEqual([]);
  });
});

describe("a Slack thread", () => {
  const messages = [
    msg("1.0", { text: "Can we move the review to Thursday?", brought: true, reactions: [{ name: "+1", count: 2, mine: true, emoji: null }] }),
    msg("2.0", { sender: "Tomás", text: "after 2pm", in_thread: true }),
    msg("3.0", { sender: "Ada", text: "Thursday at 3pm works.", mine: true, in_thread: true }),
  ];

  test("is titled by its channel, flagged unread and mentioning you, and keeps its reactions", () => {
    const view = outsideItem({ facts: facts({ place: "#web-launch", reach: "mention" }), messages, unread: true });
    expect(view.header.title).toBe("#web-launch");
    expect(view.header.flags).toEqual(["unread", "mentions_you"]);
    expect(view.header.properties.map((p) => p.label)).toEqual(["2 replies", "3 people"]);
    const first = view.entries[0];
    expect(first.kind === "message" && first.reactions.map((r) => [r.name, r.mine])).toEqual([["+1", true]]);
    const yours = view.entries[2];
    expect(yours.kind === "message" && [yours.from, yours.who]).toEqual(["you", "You"]);
    expect(view.composer.targets).toEqual([{ kind: "thread", label: "in thread · #web-launch", also_channel: true }]);
    expect(view.composer.voices).toEqual(["you", "agent"]);
  });

  test("a DM is titled by the person and its reply goes to them, with no channel to also send to", () => {
    const view = outsideItem({ facts: facts({ place: null, thread_id: "D1" }), messages: [msg("1.0")], unread: false });
    expect(view.header.title).toBe("Priya Raman");
    expect(view.header.flags).toEqual([]);
    expect(view.composer.targets).toEqual([{ kind: "thread", label: "to Priya Raman", also_channel: false }]);
  });

  test("keeps only this thread's pending reply proposals", () => {
    const base: ReplyProposal = {
      id: "rp1",
      account_id: "slack:acme",
      provider: "slack",
      account_label: "acme",
      thread_id: "C1:1.0",
      subject: "x",
      to: [],
      cc: [],
      place: null,
      text: "Thursday works.",
      status: "pending",
      reason: null,
      created_at: "",
    };
    const replies = [base, { ...base, id: "other", thread_id: "C2:9.0" }, { ...base, id: "done", status: "rejected" as const }];
    const view = outsideItem({ facts: facts(), messages: [], unread: true, replies });
    expect(view.proposals.map((p) => p.key)).toEqual(["reply-rp1"]);
  });
});

describe("an email", () => {
  test("is titled by its subject with the sender first; its HTML, files and quoted reply are parts", () => {
    const view = outsideItem({
      facts: facts({
        provider: "gmail",
        subject: "Your invoice for November is ready",
        sender: "Northwind billing",
        sender_address: "billing@northwind.example",
        reach: "to_you",
      }),
      messages: [msg("m1", { sender: "Northwind billing", html: "<p>Attached.</p>", files: [{ name: "invoice-2026-11.pdf", size: 86_000 }] })],
      unread: true,
    });
    expect(view.header.title).toBe("Your invoice for November is ready");
    expect(view.header.properties.map((p) => p.label)).toEqual(["Northwind billing", "to you", "1 file"]);
    expect(view.actions.main).toBe("archive");
    const m = view.entries[0];
    expect(m.kind === "message" && m.parts.map((p) => p.kind)).toEqual(["html", "mail_files"]);
    expect(view.composer.targets.map((t) => t.kind)).toEqual(["reply", "reply_all"]);
  });

  test("a message with no HTML is its plain text, and an email never carries reactions", () => {
    const view = outsideItem({
      facts: facts({ provider: "gmail" }),
      messages: [msg("m1", { text: "Thanks", reactions: [{ name: "+1", count: 1, mine: false, emoji: null }] })],
      unread: false,
    });
    const m = view.entries[0];
    expect(m.kind === "message" && m.parts).toEqual([{ kind: "text", text: "Thanks" }]);
    expect(m.kind === "message" && m.reactions).toEqual([]);
  });
});

describe("a Jira ticket", () => {
  const ticket: JiraCardTicket = {
    key: "WEB-412",
    summary: "Login redirect loops on Safari",
    type: "Bug",
    project: "Web",
    fields: { status: "In progress", assignee: "Sam", reporter: "Lena", priority: "High", sprint: null, labels: ["auth", "safari"] },
    description: [],
    changed: [{ field: "status", from: "To do", to: "In progress", by: "Sam", at: "2026-11-10T09:00:00.000Z" }],
    also_changed: [],
    comment_count: 2,
  };

  test("is titled by key and summary, with status, assignee, priority and labels editable, and flagged changed", () => {
    const view = outsideItem({
      facts: facts({ provider: "jira", place: "WEB-412", reach: "watching" }),
      messages: [
        msg("c1", { sender: "Sam", text: "can't reproduce", at: "2026-11-10T08:00:00.000Z" }),
        msg("c2", {
          sender: "Lena",
          text: "Safari 17.4, @you",
          at: "2026-11-10T10:00:00.000Z",
          mentions_me: true,
          reactions: [{ name: "+1", count: 1, mine: false, emoji: null }],
        }),
      ],
      ticket,
      unread: true,
    });
    expect(view.header.title).toBe("WEB-412 · Login redirect loops on Safari");
    expect(view.header.properties.map((p) => [p.label, p.editable])).toEqual([
      ["In progress", true],
      ["Sam", true],
      ["High", true],
      ["auth, safari", true],
    ]);
    expect(view.header.flags).toEqual(["unread", "mentions_you", "changed"]);
    // Comments and the status change read in time order; a comment has no reactions on a Jira card.
    expect(view.entries.map((e) => (e.kind === "event" ? e.text : e.kind === "message" ? e.who : e.kind))).toEqual([
      "Sam",
      "status To do → In progress",
      "Lena",
    ]);
    const lena = view.entries[2];
    expect(lena.kind === "message" && lena.reactions).toEqual([]);
    expect(view.actions.main).toBe("mark_read");
  });

  test("approved comments wait as seeds for the composer", () => {
    const view = outsideItem({
      facts: facts({ provider: "jira", seeds: [{ id: "rp9", text: "Repro steps are in the description now.", at: "" }] }),
      messages: [],
      ticket,
      unread: false,
    });
    expect(view.composer.seeds).toEqual(["Repro steps are in the description now."]);
    expect(view.composer.targets).toEqual([{ kind: "comment", label: "comment on WEB-412" }]);
  });
});

describe("what loki does not have", () => {
  test("no source invents a flag, a reaction or a proposal it was not given", () => {
    const bare = outsideItem({ facts: facts({ place: "#ops" }), messages: [msg("1.0")], unread: false });
    expect(bare.header.flags).toEqual([]);
    expect(bare.proposals).toEqual([]);
    const only = bare.entries[0];
    expect(only.kind === "message" && only.reactions).toEqual([]);
    expect(chatItem({ item: attentionItem("c1", { unread: false }), live: null, turns: [] }).proposals).toEqual([]);
  });
});

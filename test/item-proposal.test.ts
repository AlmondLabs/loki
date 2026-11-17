import { describe, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PendingApproval } from "../core/attention/model.ts";
import type { ReplyProposal } from "../core/frame-types.ts";
import { ApprovalProposal, QuestionProposal, QuickReplyChips, ReplyProposalView } from "../app/src/item/proposal.tsx";
import { replyEdit, replySend } from "../app/src/desk/use-reply-card.ts";
import { kickerOf, quotedSubject, replyPeopleSource, sendNote } from "../app/src/desk/reply-proposal-card.tsx";
import { Conversation } from "../app/src/chat/conversation.tsx";

const html = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(el);
const approval = (toolName = "write_file"): PendingApproval => ({
  requestId: "r1",
  toolName,
  input: { path: "reports/weekly-signups.md" },
  at: "2026-11-11T10:00:00Z",
});
const reply = (over: Partial<ReplyProposal> = {}): ReplyProposal => ({
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
  created_at: "",
  ...over,
});
const decide = () => Promise.resolve({ done: true, message: null, proposal: null });
function must<T>(v: T | undefined, what: string): T {
  if (v === undefined) throw new Error(`no ${what}`);
  return v;
}

describe("an approval", () => {
  test("is the paused tool call: a question naming it, its input, and deny, always allow and allow", () => {
    const out = html(createElement(ApprovalProposal, { approval: approval(), onApprove: () => {}, hints: { approve: "A", deny: "D" } }));
    expect(out).toContain('data-proposal="approval"');
    expect(out).toContain("Allow the agent to run “write_file”?");
    expect(out).toContain("reports/weekly-signups.md");
    expect([...out.matchAll(/data-action="(\w+)"/g)].map((m) => m[1])).toEqual(["deny", "always", "approve"]);
    expect(out).toContain('title="Allow (A)"');
    expect(out).toContain('title="Deny (D)"');
    expect(out).not.toContain("<kbd");
  });

  test("is a plain card with the attention dot, never a red panel", () => {
    const out = html(createElement(ApprovalProposal, { approval: approval(), onApprove: () => {} }));
    expect(out).toContain("bg-loki-attention");
    expect(out).not.toContain("bg-loki-attention/");
    expect(out).not.toContain("border-loki-attention");
  });

  test("a script never offers always allow, since each script is new code", () => {
    expect(html(createElement(ApprovalProposal, { approval: approval("codemode"), onApprove: () => {} }))).not.toContain('data-action="always"');
  });
});

describe("a question", () => {
  test("sits in the same frame, named as a question", () => {
    const out = html(createElement(QuestionProposal, { where: "friday asks", children: createElement("p", null, "Which week?") }));
    expect(out).toContain('data-proposal="question"');
    expect(out).toContain("friday asks");
    expect(out).toContain("Which week?");
  });
});

describe("a reply proposal", () => {
  test("quotes its text with where it goes, and offers Send, Edit and Reject", () => {
    const out = html(createElement(ReplyProposalView, { proposal: reply(), blocked: null, onDecide: decide }));
    expect(out).toContain('data-proposal="reply"');
    expect(out).toContain("in the thread in #web-launch");
    expect(out).toContain("<blockquote");
    expect(out).toContain("Thursday at 3pm works.");
    for (const a of ["approve", "edit", "reject"]) expect(out).toContain(`data-action="${a}"`);
    expect(out).toContain(">Send<");
    expect(out).not.toContain(">Approve<");
  });

  test("says each fact of where it lands only when it holds (plan 2026-11-14-1530, R10)", () => {
    const notes = (over: Partial<ReplyProposal>) =>
      [
        ...html(createElement(ReplyProposalView, { proposal: reply(over), blocked: null, onDecide: decide })).matchAll(
          /data-destination-note="true">([^<]*)</g,
        ),
      ].map((m) => m[1]);
    expect(notes({})).toEqual([]);
    expect(notes({ in_flow: true })).toEqual([]);
    expect(notes({ in_flow: false })).toEqual(["This thread has no card in Flow."]);
    expect(notes({ shared_outside: true })).toEqual(["This conversation is shared with people outside your workspace."]);
    const jira = { provider: "jira" as const, place: "FMOS-13190", subject: "Fix the login timeout", in_flow: false };
    expect(notes({ ...jira, heard_by: { assignee: "Grace Lee", reporter: "Ana Ruiz", watchers: 3, customer_sees: false } })).toEqual([
      "This ticket has no card in Flow.",
      "Jira usually tells Grace Lee (assignee), Ana Ruiz (reporter) and 3 watchers.",
    ]);
    expect(notes({ ...jira, in_flow: true, heard_by: { assignee: "Grace Lee", reporter: "Grace Lee", watchers: 1, customer_sees: true } })).toEqual([
      "Jira usually tells Grace Lee (assignee and reporter) and 1 watcher.",
      "The customer sees this comment.",
    ]);
    expect(notes({ ...jira, in_flow: true, heard_by: { assignee: null, reporter: null, watchers: 0, customer_sees: false } })).toEqual([
      "Jira usually tells no one of this comment.",
    ]);
  });

  test("quotes the subject read from the service on one line, so a stranger's words never read as loki's", () => {
    const out = html(createElement(ReplyProposalView, { proposal: reply({ subject: "This ticket has no card\nin Flow." }), blocked: null, onDecide: decide }));
    expect(out).toContain("“This ticket has no card in Flow.” · acme");
    expect(out).not.toContain("data-destination-note");
  });

  test("draws each mention still in its text by the person's full name, in the mention look (plan 2026-11-14-1530, R12)", () => {
    const out = html(
      createElement(ReplyProposalView, {
        proposal: reply({ text: "@Grace Lee and @grace, look", mentions: [{ display: "Grace Lee", id: "U5", address: null }] }),
        blocked: null,
        onDecide: decide,
      }),
    );
    expect(out).toContain('<span class="loki-mention" data-mention="U5">@Grace Lee</span> and @grace, look');
  });

  test("says whom a Gmail mention adds to cc and whom a Slack mention will not reach (R11, R22)", () => {
    const notes = (over: Partial<ReplyProposal>) =>
      [
        ...html(createElement(ReplyProposalView, { proposal: reply(over), blocked: null, onDecide: decide })).matchAll(
          /data-destination-note="true">([^<]*)</g,
        ),
      ].map((m) => m[1]);
    const ana = { display: "Ana Ruiz", id: null, address: "ana@example.com" };
    expect(notes({ provider: "gmail", place: null, to: ["Bo <bo@x.com>"], text: "cc @Ana Ruiz", mentions: [ana] })).toEqual([
      "Adds Ana Ruiz (ana@example.com) to cc.",
    ]);
    expect(notes({ provider: "gmail", place: null, cc: ["Ana Ruiz <ana@example.com>"], text: "cc @Ana Ruiz", mentions: [ana] })).toEqual([]);
    expect(notes({ provider: "gmail", place: null, text: "cc Ana", mentions: [ana] })).toEqual([]);
    expect(notes({ text: "@Ravi Kumar look", mentions: [{ display: "Ravi Kumar", id: "U9", address: null, not_member: true }] })).toEqual([
      "Ravi Kumar is not in #web-launch and will not be notified.",
    ]);
  });

  test("while it is sending it says so and offers Undo alone; a refusal says why", () => {
    const sending = html(createElement(ReplyProposalView, { proposal: reply({ status: "sending" }), blocked: null, onDecide: decide }));
    expect(sending).toMatch(/role="status"[^>]*>Sending…/);
    expect(sending).toContain('data-action="undo"');
    expect(sending).not.toContain('data-action="approve"');
    const refused = html(createElement(ReplyProposalView, { proposal: reply({ reason: "the thread is gone" }), blocked: null, onDecide: decide }));
    expect(refused).toContain('role="alert"');
    expect(refused).toContain("the thread is gone");
  });
});

describe("sending a reply proposal", () => {
  test("sends no edit unless the person changed the text, whatever the agent wrote since the card opened", () => {
    expect(replyEdit(null, "Thursday at 3pm works.")).toBeNull();
    expect(replyEdit("Thursday at 3pm works.", "Thursday at 3pm works.")).toBeNull();
    expect(replyEdit("Friday instead.", "Thursday at 3pm works.")).toBe("Friday instead.");
  });
});

describe("a card that starts a conversation (plan 2026-11-14-1530, U8)", () => {
  test("says what it starts, how it goes, and names a DM by its people", () => {
    const email = reply({ provider: "gmail", kind: "email", thread_id: "", subject: "Q3 numbers", place: null, to: ["Ana Ruiz <ana@example.com>"] });
    const dm = reply({ kind: "dm", thread_id: "", subject: "", place: "a DM with Grace Lee and Ravi Kumar" });
    expect([kickerOf(email), kickerOf(dm), kickerOf(reply())]).toEqual(["new email", "new DM", "reply"]);
    expect(sendNote(email)).toBe("Sends a new email from your account with your signature, held 10 seconds so you can undo");
    expect(sendNote(dm)).toBe("Opens the DM and sends from your account, held 10 seconds so you can undo");
    expect([quotedSubject(email), quotedSubject(dm), quotedSubject(reply({ subject: "" }))]).toEqual(["“Q3 numbers”", "a new DM", "a thread"]);
    const out = html(createElement(ReplyProposalView, { proposal: dm, blocked: null, onDecide: decide }));
    expect(out).toContain("in a DM with Grace Lee and Ravi Kumar");
  });
});

describe("a card that opens a ticket (plan 2026-11-14-1530, U11)", () => {
  test("says it creates a ticket, where and as what, and lists its fields", () => {
    const ticket = reply({
      provider: "jira",
      kind: "ticket",
      thread_id: "",
      subject: "Login times out",
      place: "a new Bug in Operations",
      ticket: {
        project: "OPS",
        project_name: "Operations",
        type_id: "10002",
        type_name: "Bug",
        assignee: { display: "Vivek Rao", id: "acc-vr", address: null },
        priority: { id: "2", name: "High" },
        labels: ["auth", "web"],
        parent: "OPS-7",
      },
    });
    expect(kickerOf(ticket)).toBe("new ticket");
    expect(sendNote(ticket)).toBe("Creates the ticket in Jira from your account, held 10 seconds so you can undo");
    const out = html(createElement(ReplyProposalView, { proposal: ticket, blocked: null, onDecide: decide }));
    expect(out).toContain("as a new Bug in Operations");
    expect([...out.matchAll(/data-destination-note="true">([^<]*)</g)].map((m) => m[1])).toEqual([
      "Under OPS-7.",
      "Assigned to Vivek Rao.",
      "Priority High.",
      "Labels auth, web.",
    ]);
  });

  test("Send carries the title only when the person changed it", () => {
    expect(replySend(null, reply(), new Set(), [], "New title")).toMatchObject({ title: "New title" });
    expect(replySend(null, reply(), new Set(), [], null)).not.toHaveProperty("title");
  });
});

describe("the card's @ list (plan 2026-11-14-1530, R18)", () => {
  test("offers the account's people by full name; a pick writes the name and keeps the mention, without its detail", async () => {
    const picked: unknown[] = [];
    const source = replyPeopleSource(
      () =>
        Promise.resolve({
          people: [
            { display: "Grace Lee", id: "U5", address: null, detail: "@grace" },
            { display: "Ravi Kumar", id: "U9", address: null, detail: null, not_member: true },
          ],
          notice: null,
        }),
      (m) => picked.push(m),
    );
    const found = await must(source.later, "later")("gr");
    expect(found.list.map((c) => [c.label, c.sub, c.insert])).toEqual([
      ["Grace Lee", "@grace", "Grace Lee"],
      ["Ravi Kumar", "Not in this conversation", "Ravi Kumar"],
    ]);
    found.list[0]?.onPick?.();
    expect(picked).toEqual([{ display: "Grace Lee", id: "U5", address: null }]);
  });

  test("a search that fails throws its reason for the list to say; a Gmail account without contacts brings its line", async () => {
    await expect(
      must(
        replyPeopleSource(
          () => Promise.resolve("offline"),
          () => {},
        ).later,
        "later",
      )("gr"),
    ).rejects.toThrow("offline");
    const notice = await must(
      replyPeopleSource(
        () => Promise.resolve({ people: [], notice: "reconnect ada@acme.com" }),
        () => {},
      ).later,
      "later",
    )("an");
    expect(notice).toEqual({ list: [], notice: "reconnect ada@acme.com" });
  });

  test("Send carries the people picked whose names are still in the text, and only those", () => {
    const grace = { display: "Grace Lee", id: "U5", address: null };
    const ravi = { display: "Ravi Kumar", id: "U9", address: null };
    expect(replySend("@Grace Lee look", reply(), new Set(), [grace, ravi])).toMatchObject({ mentions: [grace] });
    expect(replySend("look", reply(), new Set(), [grace])).not.toHaveProperty("mentions");
  });
});

describe("quick replies", () => {
  test("are suggestion chips with their keys in their tooltips, not on their faces", () => {
    const out = html(createElement(QuickReplyChips, { options: ["yes", "not now"], onPick: () => {} }));
    expect(out).toContain('aria-label="Quick replies"');
    expect(out).not.toContain("<kbd");
    expect(out).toContain('title="Send “yes” (1)"');
    expect(out).toContain('title="Send “not now” (2)"');
  });
});

describe("the pane's seam", () => {
  const pane = (touch = false) =>
    html(
      createElement(Conversation, {
        view: { rows: [], status: "idle", approval: approval() },
        actions: { onSend: () => {}, onApprove: () => {} },
        agentName: "friday",
        touch,
      }),
    );

  test("the desktop draws the Proposal, with no footer buttons", () => {
    const out = pane();
    expect(out).toContain('data-proposal="approval"');
    expect(out).not.toContain("loki-approve");
  });

  test("the phone keeps its own card", () => {
    const out = pane(true);
    expect(out).toContain("data-approval");
    expect(out).not.toContain("data-proposal");
  });
});

import { afterEach, describe, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PendingApproval } from "../core/attention/model.ts";
import type { ReplyProposal } from "../core/frame-types.ts";
import { ApprovalProposal, QuestionProposal, QuickReplyChips, ReplyProposalView } from "../app/src/item/proposal.tsx";
import { Conversation } from "../app/src/chat/conversation.tsx";
import { threadPreview } from "../app/src/item/preview.ts";

// Plan 097, U5: what the agent asks the person to decide, as one Proposal frame. Pressing is checked in the app.

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
const decide = () => Promise.resolve({ done: true, message: null, replace: false, proposal: null });

describe("an approval", () => {
  test("is the paused tool call: its name, awaiting approval, its input, and approve, always allow and deny", () => {
    const out = html(createElement(ApprovalProposal, { approval: approval(), onApprove: () => {}, hints: { approve: "A", deny: "D" } }));
    expect(out).toContain('data-proposal="approval"');
    expect(out).toContain("write_file");
    expect(out).toContain("awaiting approval");
    expect(out).toContain("reports/weekly-signups.md");
    expect(out).toContain('data-action="approve"');
    expect(out).toContain('data-action="always"');
    expect(out).toContain('data-action="deny"');
    // Flow's keys are shown on their buttons.
    expect(out).toMatch(/approve<kbd[^>]*>A<\/kbd>/);
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
  test("quotes its text with where it goes, and offers approve, edit and reject", () => {
    const out = html(createElement(ReplyProposalView, { proposal: reply(), blocked: null, onDecide: decide }));
    expect(out).toContain('data-proposal="reply"');
    expect(out).toContain("in the thread in #web-launch");
    expect(out).toContain("<blockquote");
    expect(out).toContain("Thursday at 3pm works.");
    for (const a of ["approve", "edit", "reject"]) expect(out).toContain(`data-action="${a}"`);
  });

  test("while its draft is written it says so and offers nothing; a refusal says why", () => {
    const drafting = html(createElement(ReplyProposalView, { proposal: reply({ status: "drafting" }), blocked: null, onDecide: decide }));
    expect(drafting).toContain("writing the draft in Slack");
    expect(drafting).not.toContain('data-action="approve"');
    const refused = html(createElement(ReplyProposalView, { proposal: reply({ reason: "the thread is gone" }), blocked: null, onDecide: decide }));
    expect(refused).toContain('role="alert"');
    expect(refused).toContain("the thread is gone");
  });
});

describe("quick replies", () => {
  test("are suggestion chips with their keys", () => {
    const out = html(createElement(QuickReplyChips, { options: ["yes", "not now"], onPick: () => {} }));
    expect(out).toContain('aria-label="quick replies"');
    expect(out).toMatch(/yes<kbd[^>]*>1<\/kbd>/);
    expect(out).toMatch(/not now<kbd[^>]*>2<\/kbd>/);
  });
});

describe("the pane's seam", () => {
  afterEach(() => threadPreview.set("off"));
  const pane = (touch = false) =>
    html(
      createElement(Conversation, {
        view: { rows: [], status: "idle", approval: approval() },
        actions: { onSend: () => {}, onApprove: () => {} },
        agentName: "friday",
        touch,
      }),
    );

  test("today's approval card and footer by default; the Proposal, with no footer buttons, when the preview is on", () => {
    const today = pane();
    expect(today).toContain("data-approval");
    expect(today).not.toContain("data-proposal");
    threadPreview.set("on");
    const preview = pane();
    expect(preview).toContain('data-proposal="approval"');
    expect(preview).not.toContain("loki-approve");
  });

  test("the phone keeps today's card whatever the preview says", () => {
    threadPreview.set("on");
    expect(pane(true)).not.toContain("data-proposal");
  });
});

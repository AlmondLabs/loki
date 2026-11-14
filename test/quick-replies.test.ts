import { describe, expect, test } from "vitest";
import { createElement, isValidElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Conversation } from "../app/src/chat/conversation.tsx";
import { QuickReplies, lastReplies, replyKey } from "../app/src/chat/quick-replies.tsx";
import type { TranscriptRow } from "../app/src/chat/transcript.tsx";
import type { ChatStatus } from "../app/src/chat/conversation.tsx";
import type { PendingQuestion } from "../core/attention/model.ts";

/**
 * Quick replies (plan 066): an agent ends a reply with a few options, drawn as buttons under its last reply; a click, or
 * 1 to 4 from an empty box on the Mac, sends the option as the person's message.
 */
const offer = "Ready to migrate.\n\n<loki-replies>\n- run the migration\n- show me the diff first\n</loki-replies>";
const reply: TranscriptRow = { role: "assistant", text: offer };
const key = (k: string, mods: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean }> = {}) => ({
  key: k,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  ...mods,
});

/** Both the desktop's chips and the phone's row are named "quick replies". */
const OFFERED = 'aria-label="quick replies"';
const draw = (rows: TranscriptRow[], status: ChatStatus = "idle", question: PendingQuestion | null = null, touch = false) =>
  renderToStaticMarkup(createElement(Conversation, { touch, view: { rows, status, question }, actions: { onSend: () => {}, onAnswer: () => {} } }));

describe("quick replies (plan 066)", () => {
  test("only the last message offers them, and only an agent's reply", () => {
    expect(lastReplies([reply])).toEqual(["run the migration", "show me the diff first"]);
    expect(lastReplies([reply, { role: "user", text: "run the migration" }])).toBeNull();
    expect(lastReplies([reply, { role: "assistant", text: "Done." }])).toBeNull();
    expect(lastReplies([reply, { role: "tool", text: "Bash" }])).toBeNull();
    expect(lastReplies(undefined)).toBeNull();
  });

  for (const touch of [false, true]) {
    test(`${touch ? "phone" : "desktop"}: the buttons show under a finished reply, the block's words never do`, () => {
      const html = draw([reply], "idle", null, touch);
      expect(html).toContain(OFFERED);
      expect(html).toMatch(/>run the migration</);
      expect(html).toMatch(/>show me the diff first</);
      expect(html).not.toContain("loki-replies&gt;");
      expect(html).toContain("Ready to migrate.");
    });
  }

  test("none while the agent is still at it, or waiting on a question", () => {
    expect(draw([reply], "streaming")).not.toContain(OFFERED);
    expect(draw([reply], "thinking")).not.toContain(OFFERED);
    const question: PendingQuestion = { requestId: "q1", questions: [{ question: "which?", options: [{ label: "a" }, { label: "b" }] }] } as PendingQuestion;
    expect(draw([reply], "idle", question)).not.toContain(OFFERED);
    expect(draw([reply], "streaming", null, true)).not.toContain(OFFERED);
  });

  test("the Mac shows each one's key; the phone does not", () => {
    expect(draw([reply])).toMatch(/run the migration<kbd[^>]*>1<\/kbd>/);
    const phone = draw([reply], "idle", null, true);
    expect(phone).toContain(OFFERED);
    expect(phone).not.toContain("<kbd");
    expect(phone).not.toContain("loki-kbd");
  });

  test("a click sends the option word for word", () => {
    const sent: string[] = [];
    const tree = QuickReplies({ options: ["yes", "no"], onPick: (t) => sent.push(t) });
    const buttons = (tree.props as { children: ReactElement[] }).children.filter(isValidElement);
    (buttons[1].props as { onClick: () => void }).onClick();
    expect(sent).toEqual(["no"]);
  });

  test("1 to 4 pick an option; a modifier or a key past the options types as usual", () => {
    const options = ["yes", "no", "later"];
    expect(replyKey(key("1"), options)).toBe("yes");
    expect(replyKey(key("3"), options)).toBe("later");
    expect(replyKey(key("4"), options)).toBeNull();
    expect(replyKey(key("5"), [...options, "never"])).toBeNull();
    expect(replyKey(key("1", { metaKey: true }), options)).toBeNull();
    expect(replyKey(key("a"), options)).toBeNull();
  });
});

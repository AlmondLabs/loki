import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PendingApproval } from "../core/attention/model.ts";
import { ThemeProvider } from "../app/src/theme.tsx";
import { ActionBar } from "../app/src/item/action-bar.tsx";
import { ApprovalProposal } from "../app/src/item/proposal.tsx";

// Plan 2026-11-12-1505, U4: the chat pane on Liquid Glass. ThemeProvider reads the palette from storage, so these put
// the apple family there for the glass cases and leave it empty for today's look.

const noop = () => {};
const approval: PendingApproval = { requestId: "r1", toolName: "Edit notes.txt", input: { path: "notes.txt" }, at: "2026-11-12T09:00:00Z" };
const verbs = { archive: { run: noop, keys: "⌘E" }, later: { run: noop }, mark_read: { run: noop } };

let saved: Storage | undefined;
const withPalette = (palette: string | null) => {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: (key: string) => (key === "loki.palette" ? palette : null), setItem: noop },
  });
};
const html = (el: ReactElement) => renderToStaticMarkup(createElement(ThemeProvider, null, el));

beforeEach(() => {
  saved = globalThis.localStorage;
});
afterEach(() => {
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: saved });
});

describe("the approval under Liquid Glass", () => {
  test("asks a question naming the agent and the step, with Deny, Always Allow and Allow in that order", () => {
    withPalette("apple");
    const out = html(createElement(ApprovalProposal, { approval, onApprove: noop, who: "friday" }));
    expect(out).toContain("Allow friday to run “Edit notes.txt”?");
    expect([...out.matchAll(/data-action="(\w+)"/g)].map((m) => m[1])).toEqual(["deny", "always", "approve"]);
    expect(out).toContain(">Allow</button>");
    expect(out).toContain("&quot;path&quot;: &quot;notes.txt&quot;");
  });

  test("keeps today's card in today's look", () => {
    withPalette(null);
    const out = html(createElement(ApprovalProposal, { approval, onApprove: noop, who: "friday" }));
    expect(out).toContain("awaiting approval");
    expect(out).not.toContain("Allow friday");
  });
});

describe("the moves under the box under Liquid Glass", () => {
  test("take Apple's words, and the key moves from the face into the tooltip", () => {
    withPalette("apple");
    const out = html(createElement(ActionBar, { view: { main: "archive", more: ["later", "mark_read"] }, verbs }));
    expect(out).toContain(">Mark as Read</button>");
    expect(out).toMatch(/title="Archive \(⌘E\)"[^>]*>Archive<\/button>/);
    expect(out).not.toContain("<kbd");
  });

  test("today's look keeps the lowercase word with its key beside it", () => {
    withPalette(null);
    const out = html(createElement(ActionBar, { view: { main: "archive", more: ["later", "mark_read"] }, verbs }));
    expect(out).toContain(">read</button>");
    expect(out).toContain("<kbd");
  });
});

describe("the thread under the floating header and dock", () => {
  const css = readFileSync(join(import.meta.dirname, "..", "app", "src", "components", "components.css"), "utf8");
  test("pads itself by the measured heights, and the dock has no box outside Liquid Glass", () => {
    expect(css).toMatch(/\.loki-dock \{\s*display: contents;\s*\}/);
    expect(css).toMatch(/padding-top: calc\(var\(--loki-header-height\) \+ 20px\);/);
    expect(css).toMatch(/padding-bottom: calc\(var\(--loki-dock-height\) \+ 20px\);/);
  });
});

describe("the keyboard under Liquid Glass (U5)", () => {
  test("Allow Step and Deny Step sit in the Chat menu, and Deny leaves ⌘⌫ to the text", async () => {
    const { KEYMAP, menuSpec } = await import("../app/src/shell/keymap.ts");
    const allow = KEYMAP.find((b) => b.id === "chat.allow");
    const deny = KEYMAP.find((b) => b.id === "chat.deny");
    expect(allow?.keys).toEqual(["cmd+enter"]);
    expect(deny?.keys).toEqual(["cmd+shift+backspace"]);
    expect(KEYMAP.filter((b) => b.where === "desk" && b.keys.includes("cmd+backspace"))).toEqual([]);
    const chat = menuSpec(KEYMAP, "macos").find((m) => m.title === "Chat");
    const ids = (chat?.items ?? []).flatMap((i) => ("id" in i ? [i.id] : []));
    expect(ids).toEqual(expect.arrayContaining(["chat.allow", "chat.deny"]));
  });

  test("Always Allow promises a question with its ellipsis and grants nothing by being drawn", () => {
    withPalette("apple");
    const ran: string[] = [];
    const out = html(createElement(ApprovalProposal, { approval, onApprove: (b) => ran.push(b), who: "friday" }));
    expect(out).toContain(">Always Allow…</button>");
    expect(ran).toEqual([]);
  });

  test("the empty box's words carry no keys, and say Return allows while an approval waits", async () => {
    const { glassPlaceholder } = await import("../app/src/chat/conversation.tsx");
    expect(glassPlaceholder({ status: "idle", approval: null, question: null }, "friday")).toBe("Message friday");
    expect(glassPlaceholder({ status: "idle", approval, question: null }, "friday")).toBe("Reply, or press Return to allow");
    expect(glassPlaceholder({ status: "streaming", approval: null, question: null }, "friday")).toBe("Message friday — sends when this turn ends");
  });
});

describe("Flow under Liquid Glass (U6)", () => {
  test("a Gmail card's moves take Apple's words, archive last and filled", async () => {
    const { OutsideItemActions } = await import("../app/src/desk/outside-card.tsx");
    withPalette("apple");
    const facts = {
      provider: "gmail" as const,
      account_id: "gmail:ada@example.com",
      account_label: "ada@example.com",
      place: null,
      sender: "Northwind billing",
      subject: "Your invoice",
      thread_id: "t1",
      generation: 0,
      owner_agent_id: "agent-work",
      owner_name: "friday",
      sender_address: "billing@northwind.example",
      lines: ["November's invoice is attached."],
      newest_message_id: "m1",
      newest_at: "2026-11-11T08:15:00.000Z",
      handoff_conversation_id: null,
      disconnected: null,
    };
    const moves = { read: noop, later: noop, archive: noop, label: noop };
    const out = html(createElement(OutsideItemActions, { facts, thread: { kind: "loading" }, typing: false, moves, picking: false, onHandoff: noop }));
    expect([...out.matchAll(/>([A-Z][A-Za-z ]+)<\/button>/g)].map((m) => m[1])).toEqual(["Hand Off", "Label", "Later", "Mark as Read", "Archive"]);
    expect(out).not.toContain("<kbd");
  });

  test("a Flow card pads its thread under the dock, and an outside card's reply box is the glass capsule", () => {
    const css = readFileSync(join(import.meta.dirname, "..", "app", "src", "components", "components.css"), "utf8");
    expect(css).toMatch(/\.loki-flow-card \[data-slot="message-scroller-content"\] \{\s*padding-bottom: calc\(var\(--loki-dock-height\) \+ 20px\);/);
    expect(css).toMatch(/\.loki-flow-card \[data-reply-box\] \[data-slot="input-group"\] \{[^}]*var\(--loki-glass-strong\)/);
  });
});

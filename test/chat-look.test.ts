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

describe("the wording pass under Liquid Glass", () => {
  test("loki's Button capitalises its label and moves its key into the tooltip; today's look keeps both as written", async () => {
    const { Button } = await import("../app/src/components/index.tsx");
    withPalette("apple");
    const glass = html(createElement(Button, { kbd: "⌘E" }, "turn the writer on"));
    expect(glass).toContain(">Turn the writer on</button>");
    expect(glass).toContain('title="Turn the writer on (⌘E)"');
    expect(glass).not.toContain("loki-kbd");
    withPalette(null);
    const today = html(createElement(Button, { kbd: "⌘E" }, "turn the writer on"));
    expect(today).toContain("turn the writer on");
    expect(today).toContain("loki-kbd");
  });

  test("loki's own name keeps its lowercase", async () => {
    const { capitalFirst } = await import("../app/src/kit/words.ts");
    expect(capitalFirst("loki did not load")).toBe("loki did not load");
    expect(capitalFirst("ask friday to update this")).toBe("Ask friday to update this");
  });

  test("the turn's header, the plan, the thought and the flags take their capitals", async () => {
    const { AgentTurn } = await import("../app/src/item/agent-turn.tsx");
    const { AgentPlan } = await import("../app/src/item/agent-plan.tsx");
    const { Thought } = await import("../app/src/item/thought.tsx");
    const { ItemHeader } = await import("../app/src/item/item-header.tsx");
    withPalette("apple");
    const turn = html(createElement(AgentTurn, { agentName: "friday", state: "needs you", failed: 0, took: "2 min", parts: [], draw: () => null }));
    expect(turn).toContain("Worked 2 min");
    expect(turn).toContain("Needs you");
    expect(html(createElement(AgentPlan, { items: [{ content: "read", status: "completed" as const }] }))).toContain(">Plan<");
    expect(html(createElement(Thought, { rows: [{ role: "assistant" as const, text: "x", thought: "y", thought_ms: 2000 }] }))).toContain(
      "Thought for 2 seconds",
    );
    expect(html(createElement(ItemHeader, { view: { title: "t", properties: [], flags: ["unread" as const] } }))).toContain("Unread");
  });

  test("a chat's icon is a speech bubble, not Slack's #", async () => {
    const { Icon } = await import("../app/src/shared/icons.tsx");
    withPalette("apple");
    expect(html(createElement(Icon, { name: "desk" }))).toContain("lucide-message-square");
    withPalette(null);
    expect(html(createElement(Icon, { name: "desk" }))).not.toContain("lucide-message-square");
  });
});

describe("the thread as a Mac conversation with an agent (U14)", () => {
  const at = (m: number) => new Date(Date.parse("2026-11-12T09:00:00Z") + m * 60_000).toISOString();
  const you = (text: string, m: number) => ({ role: "user" as const, text, at: at(m) });
  const them = (text: string, m: number) => ({ role: "assistant" as const, text, at: at(m) });

  test("your message is a bubble with no label, its time in its tooltip; today's look keeps both on the row", async () => {
    const { ChatMessage } = await import("../app/src/item/message-entry.tsx");
    const { clockLabel } = await import("../app/src/shared/thread.ts");
    const row = you("chart the signups", 0);
    const props = { row, last: false, streaming: false, arrived: false };
    withPalette("apple");
    const glass = html(createElement(ChatMessage, props));
    expect(glass).not.toContain(">You<");
    expect(glass).toContain(`title="${clockLabel(row.at)}"`);
    expect(glass).toContain("max-w-[75%]");
    withPalette(null);
    expect(html(createElement(ChatMessage, props))).toContain(">You<");
  });

  test("the agent's turn names no one on screen but still to a screen reader, and a quiet finished turn has no header", async () => {
    const { AgentTurn } = await import("../app/src/item/agent-turn.tsx");
    withPalette("apple");
    const quiet = html(createElement(AgentTurn, { agentName: "friday", state: "done", failed: 0, took: null, parts: [], draw: () => null }));
    expect(quiet).toContain('aria-label="friday&#x27;s turn, done"');
    expect(quiet).not.toContain("<header");
    const failed = html(createElement(AgentTurn, { agentName: "friday", state: "failed", failed: 1, took: null, parts: [], draw: () => null }));
    expect(failed).toContain("1 failed");
    expect(failed).not.toContain(">friday<");
    withPalette(null);
    expect(html(createElement(AgentTurn, { agentName: "friday", state: "done", failed: 0, took: null, parts: [], draw: () => null }))).toContain(">friday<");
  });

  test("time is told before your message after a quarter hour's gap, and rides on the day's marker where both fall", async () => {
    const { threadEntries } = await import("../app/src/item/entries.ts");
    const { clockLabel } = await import("../app/src/shared/thread.ts");
    const rows = [you("one", 0), them("a", 1), you("two", 5), them("b", 6), you("three", 30)];
    const base = { rows, from: 0, above: 0, dividerAt: null, dividerDay: null, widgets: [], busy: false, arrivedFrom: rows.length, now: Date.parse(at(60)) };
    const markers = (gaps?: number) => threadEntries({ ...base, gaps }).flatMap((e) => (e.kind === "day" ? [e.label] : []));
    const days = markers();
    expect(days).toHaveLength(1);
    // the first message carries the day and its time; "two" came 4 minutes after "a", so no marker; "three" came 24 after
    expect(markers(15 * 60_000)).toEqual([`${days[0]} ${clockLabel(at(0))}`, clockLabel(at(30))]);
  });
});

describe("a Flow card asks one thing at a time (U16)", () => {
  test("the shared toolbar names each symbol and its key, and its title opens the item", async () => {
    const { ToolbarGroup, ToolbarTitle } = await import("../app/src/item/toolbar.tsx");
    const group = html(
      createElement(ToolbarGroup, {
        label: "Chat actions",
        moves: [
          { label: "Later", icon: createElement("i"), title: "Later (L)", run: noop },
          { label: "Archive", icon: createElement("i"), title: "Archive (E)", run: noop, disabled: true },
        ],
      }),
    );
    expect(group).toContain('role="group" aria-label="Chat actions"');
    expect(group).toContain('aria-label="Later" title="Later (L)"');
    expect(group).toMatch(/aria-label="Archive" title="Archive \(E\)" disabled=""/);
    const title = html(
      createElement(ToolbarTitle, {
        title: "Signups",
        facts: [{ key: "agent", label: "friday · needs you", editable: false, tone: "attention" }],
        onOpen: noop,
        openTitle: "Open Chat (O)",
      }),
    );
    expect(title).toContain('<button type="button" class="loki-toolbar-open" title="Open Chat (O)">Signups</button>');
    expect(title).toContain('class="loki-toolbar-dot"');
  });

  test("under Liquid Glass the card's moves are its header's, and the box has no row of buttons under it", () => {
    const card = readFileSync(join(import.meta.dirname, "..", "app", "src", "desk", "catch-up.tsx"), "utf8");
    expect(card).toContain("moves={glass ? { current, ...moves } : undefined}");
    expect(card).toMatch(/footer=\{preview === "on" \? \(?glass \? undefined : <ChatItemActions/);
    const parts = readFileSync(join(import.meta.dirname, "..", "app", "src", "desk", "catch-up-parts.tsx"), "utf8");
    for (const key of ["inbox.later", "inbox.next", "inbox.archive", "inbox.open"]) expect(parts).toContain(`deckKey("${key}", moves.typing)`);
  });
});

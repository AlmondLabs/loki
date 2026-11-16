import { describe, expect, test } from "vitest";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PendingApproval } from "../core/attention/model.ts";
import { ThemeProvider } from "../app/src/theme.tsx";
import { ApprovalProposal } from "../app/src/item/proposal.tsx";

const noop = () => {};
const approval: PendingApproval = { requestId: "r1", toolName: "Edit notes.txt", input: { path: "notes.txt" }, at: "2026-11-12T09:00:00Z" };

const html = (el: ReactElement) => renderToStaticMarkup(createElement(ThemeProvider, null, el));

describe("the approval", () => {
  test("asks a question naming the agent and the step, with Deny, Always Allow and Allow in that order", () => {
    const out = html(createElement(ApprovalProposal, { approval, onApprove: noop, who: "friday" }));
    expect(out).toContain("Allow friday to run “Edit notes.txt”?");
    expect([...out.matchAll(/data-action="(\w+)"/g)].map((m) => m[1])).toEqual(["deny", "always", "approve"]);
    expect(out).toContain(">Allow</button>");
    expect(out).toContain("&quot;path&quot;: &quot;notes.txt&quot;");
  });
});

describe("the thread under the floating header and dock", () => {
  const css = readFileSync(join(import.meta.dirname, "..", "app", "src", "components", "components.css"), "utf8");
  test("pads itself by the measured heights", () => {
    expect(css).toMatch(/padding-top: calc\(var\(--loki-header-height\) \+ 20px\);/);
    expect(css).toMatch(/padding-bottom: calc\(var\(--loki-dock-height\) \+ 20px\);/);
  });

  test("any thread with a dock beside it pads by the dock, the chat inset on the canvas too, not only the hosts named", () => {
    expect(css).toMatch(/:has\(> \.loki-dock\) \[data-slot="message-scroller-content"\] \{\s*padding-bottom: calc\(var\(--loki-dock-height\) \+ 20px\);/);
    expect(css).toMatch(/:has\(> \.loki-dock\) \[data-slot="message-scroller-button"\] \{\s*bottom: calc\(var\(--loki-dock-height\) \+ 12px\);/);
    expect(css).not.toMatch(/\.loki-(desk-pane-messages|flow-card) \[data-slot="message-scroller-content"\] \{[^}]*--loki-dock-height/);
  });

  test("the dock is measured again when it comes back: kept in state, not in a ref that re-runs nothing", () => {
    const src = readFileSync(join(import.meta.dirname, "..", "app", "src", "chat", "conversation.tsx"), "utf8");
    expect(src).toMatch(/ref=\{setDockEl\} className=\{proposals \? "loki-dock/);
    expect(src).toMatch(/useCallback\(\(\) => dockEl, \[dockEl\]\)/);
  });
});

describe("the keyboard (U5)", () => {
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
    const ran: string[] = [];
    const out = html(createElement(ApprovalProposal, { approval, onApprove: (b) => ran.push(b), who: "friday" }));
    expect(out).toContain(">Always Allow…</button>");
    expect(ran).toEqual([]);
  });

  test("the empty box's words carry no keys, and say how to answer while an approval waits", async () => {
    const { boxPlaceholder } = await import("../app/src/chat/conversation.tsx");
    expect(boxPlaceholder({ status: "idle", approval: null, question: null }, "friday")).toBe("Message friday");
    expect(boxPlaceholder({ status: "idle", approval, question: null }, "friday")).toBe("Reply, or allow or deny the step");
    expect(boxPlaceholder({ status: "idle", approval, question: null }, "friday", true)).toBe("Reply, or approve or deny the step");
    expect(boxPlaceholder({ status: "streaming", approval: null, question: null }, "friday")).toBe("Message friday — sends when this turn ends");
  });
});

describe("Flow (U6)", () => {
  test("a Gmail card's moves are symbols named in Apple's words, their keys in the tooltip, Archive last and prominent", async () => {
    const { OutsideItemActions } = await import("../app/src/desk/outside-toolbar.tsx");
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
    expect([...out.matchAll(/aria-label="([^"]+)"/g)].map((m) => m[1])).toEqual(["Card actions", "Hand Off", "Label", "Later", "Mark as Read", "Archive"]);
    expect(out).toMatch(/class="loki-toolbar-item loki-toolbar-item--prominent" aria-label="Archive" title="[^"]*\(E\)"/);
    expect(out).not.toContain("<kbd");
  });

  test("an outside Flow card's reply box is the glass capsule", () => {
    const css = readFileSync(join(import.meta.dirname, "..", "app", "src", "components", "components.css"), "utf8");
    expect(css).toMatch(/\.loki-flow-card \[data-reply-box\] \[data-slot="input-group"\] \{[^}]*var\(--loki-glass-strong\)/);
  });
});

describe("the wording pass", () => {
  test("loki's Button capitalises its label and moves its key into the tooltip", async () => {
    const { Button } = await import("../app/src/components/index.tsx");
    const out = html(createElement(Button, { kbd: "⌘E" }, "turn the writer on"));
    expect(out).toContain(">Turn the writer on</button>");
    expect(out).toContain('title="Turn the writer on (⌘E)"');
    expect(out).not.toContain("loki-kbd");
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
    const { OutsideItemHeader } = await import("../app/src/desk/outside-toolbar.tsx");
    const turn = html(createElement(AgentTurn, { agentName: "friday", state: "needs you", failed: 0, took: "2 min", parts: [], draw: () => null }));
    expect(turn).toContain("Worked 2 min");
    expect(turn).toContain("Needs you");
    expect(html(createElement(AgentPlan, { items: [{ content: "read", status: "completed" as const }] }))).toContain(">Plan<");
    expect(html(createElement(Thought, { rows: [{ role: "assistant" as const, text: "x", thought: "y", thought_ms: 2000 }] }))).toContain(
      "Thought for 2 seconds",
    );
    const facts = {
      provider: "slack" as const,
      account_id: "slack:acme",
      account_label: "acme",
      sender: "Ada",
      sender_address: null,
      subject: "t",
      thread_id: "t1",
      generation: 0,
      owner_agent_id: "a1",
      owner_name: "friday",
      lines: [],
      newest_message_id: "m1",
      newest_at: "2026-11-11T08:15:00.000Z",
      handoff_conversation_id: null,
      disconnected: null,
    };
    expect(html(createElement(OutsideItemHeader, { facts, unread: true, flash: null, went: null, cameBack: false, thread: { kind: "loading" } }))).toContain(
      "Unread",
    );
  });

  test("a chat's icon is a speech bubble, not Slack's #", async () => {
    const { Icon } = await import("../app/src/shared/icons.tsx");
    expect(html(createElement(Icon, { name: "desk" }))).toContain("lucide-message-square");
  });
});

describe("the thread as a Mac conversation with an agent (U14)", () => {
  const at = (m: number) => new Date(Date.parse("2026-11-12T09:00:00Z") + m * 60_000).toISOString();
  const you = (text: string, m: number) => ({ role: "user" as const, text, at: at(m) });
  const them = (text: string, m: number) => ({ role: "assistant" as const, text, at: at(m) });

  test("your message is a bubble with no label, its time in its tooltip", async () => {
    const { ChatMessage } = await import("../app/src/item/message-entry.tsx");
    const { clockLabel } = await import("../app/src/shared/thread.ts");
    const row = you("chart the signups", 0);
    const props = { row, last: false, streaming: false, arrived: false };
    const out = html(createElement(ChatMessage, props));
    expect(out).not.toContain(">You<");
    expect(out).toContain(`title="${clockLabel(row.at)}"`);
    expect(out).toContain("max-w-[75%]");
  });

  test("the agent's turn names no one on screen but still to a screen reader, and a quiet finished turn has no header", async () => {
    const { AgentTurn } = await import("../app/src/item/agent-turn.tsx");
    const quiet = html(createElement(AgentTurn, { agentName: "friday", state: "done", failed: 0, took: null, parts: [], draw: () => null }));
    expect(quiet).toContain('aria-label="friday&#x27;s turn, done"');
    expect(quiet).not.toContain("<header");
    const failed = html(createElement(AgentTurn, { agentName: "friday", state: "failed", failed: 1, took: null, parts: [], draw: () => null }));
    expect(failed).toContain("1 failed");
    expect(failed).not.toContain(">friday<");
  });

  test("time is told before your message after a quarter hour's gap, and rides on the day's marker where both fall", async () => {
    const { threadEntries } = await import("../app/src/item/entries.ts");
    const { clockLabel } = await import("../app/src/shared/thread.ts");
    const rows = [you("one", 0), them("a", 1), you("two", 5), them("b", 6), you("three", 30)];
    const base = { rows, from: 0, above: 0, dividerAt: null, dividerDay: null, widgets: [], busy: false, arrivedFrom: rows.length, now: Date.parse(at(60)) };
    const markers = (gaps?: number) => threadEntries({ ...base, gaps }).flatMap((e) => (e.kind === "day" ? [e.label] : []));
    const days = markers();
    expect(days).toHaveLength(1);
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

  test("the card's moves are its header's, and the box has no row of buttons under it", () => {
    const card = readFileSync(join(import.meta.dirname, "..", "app", "src", "desk", "catch-up.tsx"), "utf8");
    expect(card).toContain("moves={moves}");
    expect(card).not.toContain("footer=");
    const parts = readFileSync(join(import.meta.dirname, "..", "app", "src", "desk", "catch-up-parts.tsx"), "utf8");
    for (const key of ["inbox.later", "inbox.next", "inbox.archive", "inbox.open"]) expect(parts).toContain(`deckKey("${key}", moves.typing)`);
  });
});

describe("one detail inset (plan 2026-11-14-2224, U3)", () => {
  const classOf = (out: string, marker: string) => {
    const tag = new RegExp(`<[^>]*${marker}[^>]*>`).exec(out)?.[0] ?? "";
    return /class="([^"]*)"/.exec(tag)?.[1].split(" ") ?? [];
  };

  test("the transcript and the composer are centred in the detail, at the thread's width", async () => {
    const { Conversation } = await import("../app/src/chat/conversation.tsx");
    const out = html(
      createElement(Conversation, { view: { rows: [{ role: "assistant", text: "On it." }], status: "idle" }, actions: { onSend: noop }, agentName: "friday" }),
    );
    const thread = classOf(out, 'data-slot="message-scroller-content"');
    expect(thread).toContain("max-w-3xl");
    expect(thread).toContain("mx-auto");
    expect(thread.filter((c) => /^(px|pl|pr|ps|pe)-/.test(c))).toEqual([]);
    const composer = classOf(out, 'data-composer="messages"');
    expect(composer).toContain("max-w-3xl");
    expect(composer).toEqual(expect.arrayContaining(["mx-auto", "w-full", "max-w-3xl"]));
    expect(composer).not.toContain("px-5");
    expect(classOf(out, 'class="loki-dock')).toContain("px-5");
    expect(out).not.toMatch(/\[calc\(/);
  });

  test("an outside card's thread and reply box are centred, 20px in", async () => {
    const { OutsideCard } = await import("../app/src/desk/outside-card.tsx");
    const facts = {
      provider: "slack" as const,
      account_id: "slack:acme",
      account_label: "acme",
      place: "#web-launch",
      sender: "Priya Raman",
      subject: "launch review",
      thread_id: "C1:1.0",
      generation: 0,
      owner_agent_id: "agent-work",
      owner_name: "friday",
      sender_address: null,
      lines: ["Can we move it?"],
      newest_message_id: "1.0",
      newest_at: "2026-11-11T10:31:00.000Z",
      handoff_conversation_id: null,
      disconnected: null,
    };
    const box = { text: "", mail: null, busy: false, error: null, onText: noop, onMail: noop, onSend: noop };
    const out = html(
      createElement(OutsideCard, {
        current: { id: "o1", outside: facts } as unknown as Parameters<typeof OutsideCard>[0]["current"],
        facts,
        flash: null,
        cameBack: false,
        typing: false,
        moves: { read: noop, later: noop, archive: noop, label: noop },
        box,
      }),
    );
    expect(out).toContain('class="mx-auto w-full max-w-3xl" style="padding:8px 20px 16px"');
    expect(out).toContain('class="mx-auto w-full max-w-3xl" style="padding:12px 20px 16px"');
  });

  test("Learn's review deck stays centred, and All Cards starts at the edge", async () => {
    const { LearnColumn } = await import("../app/src/recall/recall-parts.tsx");
    const column = (view: "review" | "all") => html(createElement(LearnColumn, { view, children: "body" }));
    expect(column("review")).toContain("margin:0 auto");
    expect(column("all")).not.toContain("auto");
    expect(column("all")).toContain("max-width:100%");
  });
});

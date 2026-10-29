// The phone's Inbox card: its message box carries the model pill as the conversation page's does, and a plain wait
// adds no line above it (the box's "Message friday" already says it is your turn).
import { describe, expect, test } from "vitest";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AttentionItem } from "../core/attention/model.ts";
import type { ModelEntry } from "../core/models.ts";
import { Card, CardConversation, Decisions, type CardActions } from "../app/src/phone/inbox.tsx";
import { CardHeader } from "../app/src/desk/catch-up-parts.tsx";
import { LOKI_COMMANDS } from "../core/attention/commands.ts";
import type { SuggestionSource } from "../app/src/chat/suggestion-card.tsx";
import type { Suggestion } from "../core/frame-types.ts";

const item = (over: Partial<AttentionItem> = {}): AttentionItem => ({
  id: "c1",
  agent_id: "a1",
  agent_name: "friday",
  title: "data pipelines",
  last_message_at: "2026-09-25T10:00:00Z",
  archived: false,
  status: "done",
  lastAssistantText: "x",
  lastRole: "assistant",
  pendingApproval: null,
  pendingQuestion: null,
  error: null,
  seenAt: null,
  unread: true,
  viewedAt: null,
  lastAsk: null,
  score: 0,
  reason: "other",
  focus: 0,
  runtime: { agent_id: "a1", conversation_id: "c1" },
  ...over,
});

const MODELS: ModelEntry[] = [
  { id: "opus-medium", handle: "anthropic/claude-opus-5-5", label: "Opus 5.5", is_featured: true, reasoning_effort: "medium" },
  { id: "opus-high", handle: "anthropic/claude-opus-5-5", label: "Opus 5.5", is_featured: true, reasoning_effort: "high" },
];

const actions = (model?: CardActions["model"]): CardActions => ({ onSend: () => {}, onAnswer: () => {}, onCancelQueued: () => {}, model });
/** The card draws the agent's face, whose URL reads the page's token and origin: a bare page for the render, then put back. */
/** Draw an element as the phone's page would, with the browser globals it reads faked and put back after. */
function inPage(el: ReactElement): string {
  const g = globalThis as Record<string, unknown>;
  const saved = { window: g.window, localStorage: g.localStorage, location: g.location };
  g.window = {};
  g.localStorage = { getItem: () => null };
  g.location = { origin: "http://127.0.0.1:5191", href: "http://127.0.0.1:5191/" };
  try {
    return renderToStaticMarkup(el);
  } finally {
    Object.assign(g, saved);
  }
}

function render(it: AttentionItem, card: CardActions, status: "idle" | "thinking" | "streaming" = "idle", suggestionsTick = 0): string {
  return inPage(createElement(CardConversation, { item: it, view: { rows: [], status }, card, onHold: () => {}, suggestionsTick }));
}

describe("the Inbox card's message box", () => {
  const model: CardActions["model"] = {
    models: MODELS,
    onLoad: () => {},
    modelOf: () => "anthropic/claude-opus-5-5",
    effortOf: () => "medium",
    onPick: async () => {},
  };

  test("carries the model pill, named with the card's model and effort", () => {
    const html = render(item(), actions(model));
    expect(html).toContain('aria-label="Model: Opus 5.5, medium effort"');
  });

  test("without a way to switch (the link is down) there is no pill", () => {
    expect(render(item(), actions({ ...model, onPick: undefined }))).not.toContain("Model:");
    expect(render(item(), actions())).not.toContain("Model:");
  });

  test("a plain wait has no line above the box; what adds something still shows", () => {
    expect(render(item(), actions(model))).not.toContain("waiting for your reply");
    expect(render(item(), actions(model))).not.toContain("loki-phone-notice");
    expect(render(item({ status: "approval" }), actions(model))).toContain("friday needs your approval");
    expect(render(item(), actions(model), "streaming")).toContain("friday is writing");
  });
});

describe("the Inbox card's suggestions (plan 049)", () => {
  const pending = (id: string, createdAt: string): Suggestion => ({
    id,
    title: `suggestion ${id}`,
    text: "look at this elsewhere",
    target: { agent_id: "a1", folder: "/work" },
    status: "pending",
    created_at: createdAt,
  });
  const source: SuggestionSource = {
    conversation: () => ({ suggestions: [pending("s1", "2026-09-25T09:00:00Z"), pending("s2", "2026-09-25T10:00:00Z")], cwd: null }),
    items: [],
    agents: [{ id: "a1", name: "friday" }],
    listed: true,
    agentsLoaded: true,
    suggestions: {
      decide: () => Promise.resolve({ done: true, message: null, suggestion: null }),
      retarget: () => Promise.resolve({ done: true, message: null, suggestion: null }),
    },
  };
  test("two pending suggestions wait behind the box's chip, and the card's mark opens them in the phone's words (plan 052)", () => {
    const closed = render(item(), { ...actions(), suggestions: { source, blocked: null } });
    expect(closed).toContain("loki-suggestion-chip");
    expect(closed).not.toContain("data-suggestion=");
    const html = render(item(), { ...actions(), suggestions: { source, blocked: null } }, "idle", 1);
    expect([...html.matchAll(/data-suggestion="([^"]+)"/g)].map((m) => m[1])).toEqual(["s2", "s1"]);
    expect(html).toContain("New chat with friday in work");
  });
  test("the desktop card's head says how many wait, beside draft, as a button", () => {
    const html = inPage(createElement(CardHeader, { current: item(), cameBack: false, flash: null, suggestions: 2, onSuggestions: () => {} }));
    expect(html).toMatch(/<button[^>]*loki-chip--tag[^>]*>2 suggestions<\/button>/);
    expect(inPage(createElement(CardHeader, { current: item(), cameBack: false, flash: null }))).not.toContain("suggestion");
  });
  test("/suggestions opens them, as ⌘⇧S does", () => {
    expect(LOKI_COMMANDS.find((c) => c.id === "suggestions")?.action).toBe("chat.suggestions");
  });
  test("the card's head says how many wait, as a button", () => {
    const html = inPage(createElement(Card, { item: item(), role: "top", style: {}, suggestions: 2, onSuggestions: () => {} }));
    expect(html).toMatch(/<button[^>]*loki-phone-card-suggestions[^>]*>2 suggestions<\/button>/);
  });
  test("without them the card draws none", () => {
    expect(render(item(), actions())).not.toContain("loki-suggestions");
  });
});

describe("the phone's decisions under a card", () => {
  const html = (over: Partial<AttentionItem>) =>
    renderToStaticMarkup(createElement(Decisions, { item: item(over), onOpen: () => {}, onSeen: () => {}, onApprove: () => {} }));

  test("an approval offers deny, approve, and always allowing the tool", () => {
    const out = html({
      pendingApproval: {
        requestId: "approval-t1",
        toolName: "mcp__github__create_issue",
        input: {},
        at: "2026-09-25T10:00:00Z",
      },
    });
    expect(out).toContain(">Deny<");
    expect(out).toContain(">Approve<");
    expect(out).toContain("Always allow mcp__github__create_issue");
  });

  test("anything else offers open and next, and no always", () => {
    const out = html({});
    expect(out).toContain(">Open chat<");
    expect(out).not.toContain("Always allow");
  });
});

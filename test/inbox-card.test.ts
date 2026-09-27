// The phone's Inbox card: its message box carries the model pill as the conversation page's does, and a plain wait
// adds no line above it (the box's "Message friday" already says it is your turn).
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AttentionItem } from "../core/attention/model.ts";
import type { ModelEntry } from "../core/models.ts";
import { CardConversation, type CardActions } from "../app/src/phone/Inbox.tsx";

const item = (over: Partial<AttentionItem> = {}): AttentionItem => ({
  id: "c1",
  agentId: "a1",
  agentName: "friday",
  title: "data pipelines",
  lastMessageAt: "2026-09-25T10:00:00Z",
  archived: false,
  status: "done",
  lastAssistantText: "x",
  lastRole: "assistant",
  pendingApproval: null,
  pendingQuestion: null,
  turns: 0,
  error: null,
  seenAt: null,
  unread: true,
  viewedAt: null,
  lastAsk: null,
  score: 0,
  reason: "report",
  runtime: { agent_id: "a1", conversation_id: "c1" },
  ...over,
});

const MODELS: ModelEntry[] = [
  { id: "opus-medium", handle: "anthropic/claude-opus-5-5", label: "Opus 5.5", isFeatured: true, reasoningEffort: "medium" },
  { id: "opus-high", handle: "anthropic/claude-opus-5-5", label: "Opus 5.5", isFeatured: true, reasoningEffort: "high" },
];

const actions = (model?: CardActions["model"]): CardActions => ({ onSend: () => {}, onAnswer: () => {}, onCancelQueued: () => {}, model });
/** The card draws the agent's face, whose URL reads the page's token and origin: a bare page for the render, then put back. */
function render(it: AttentionItem, card: CardActions, status: "idle" | "thinking" | "streaming" = "idle"): string {
  const g = globalThis as Record<string, unknown>;
  const saved = { window: g.window, localStorage: g.localStorage, location: g.location };
  g.window = {};
  g.localStorage = { getItem: () => null };
  g.location = { origin: "http://127.0.0.1:5191", href: "http://127.0.0.1:5191/" };
  try {
    return renderToStaticMarkup(createElement(CardConversation, { item: it, view: { rows: [], status }, card, onHold: () => {} }));
  } finally {
    Object.assign(g, saved);
  }
}

describe("the Inbox card's message box", () => {
  const model: CardActions["model"] = { models: MODELS, onLoad: () => {}, modelOf: () => "anthropic/claude-opus-5-5", effortOf: () => "medium", onPick: async () => {} };

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

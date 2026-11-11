import { describe, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ModelEntry } from "../core/models.ts";
import { Command } from "../app/src/ui/command.tsx";
import { ModelDialogChoices } from "../app/src/item/model-dialog.tsx";

// Plan 097, U6: Select model on AI Elements' ModelSelector. The dialog itself mounts in a portal only in a browser, so
// its choices are drawn here inside a plain Command; opening it from the pill is checked in the app.

const entry = (handle: string, label: string, over: Partial<ModelEntry> = {}): ModelEntry => ({
  id: `${handle}:${over.reasoning_effort ?? ""}`,
  handle,
  label,
  ...over,
});
const ENTRIES: ModelEntry[] = [
  entry("anthropic/claude-opus-5-5", "Opus 5.5", { reasoning_effort: "medium", is_featured: true }),
  entry("anthropic/claude-opus-5-5", "Opus 5.5", { reasoning_effort: "high" }),
  entry("anthropic/claude-sonnet-5-5", "Sonnet 5.5", { is_featured: true }),
  entry("openai/gpt-x", "GPT X"),
  entry("acp:claude/default", "Claude Code"),
  entry("acp:claude/sonnet", "Claude Code · Sonnet"),
];

const draw = (over: Partial<Parameters<typeof ModelDialogChoices>[0]> = {}) =>
  renderToStaticMarkup(
    createElement(
      Command,
      null,
      createElement(ModelDialogChoices, {
        current: "anthropic/claude-opus-5-5",
        currentEffort: "high",
        entries: ENTRIES,
        loading: false,
        onPick: () => {},
        onClose: () => {},
        ...over,
      }),
    ),
  );

describe("the model dialog's choices", () => {
  test("one filter over every harness's models, the current one checked", () => {
    const out = draw();
    expect(out).toContain("filter by provider or name");
    expect(out).toContain("Opus 5.5");
    expect(out).toContain("Sonnet 5.5");
    expect(out).toContain("Claude Code");
    expect(out).toMatch(/data-checked="true"[^>]*>[\s\S]*?Opus 5\.5/);
  });

  test("the current model's efforts, its own checked", () => {
    const out = draw();
    expect(out).toContain(">effort<");
    expect(out).toMatch(/data-checked="true"[^>]*>high</);
  });

  test("once the chat has started, other harnesses are left out with a line saying why", () => {
    const out = draw({ started: true });
    expect(out).not.toContain("Claude Code · Sonnet");
    expect(out).toContain("only in a new chat");
  });

  test("before the models come, it says they are loading", () => {
    expect(draw({ entries: null, loading: true })).toContain("loading models");
  });
});

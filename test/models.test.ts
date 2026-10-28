import { describe, expect, test } from "vitest";
import { reasoningEffortFromSettings, type ModelEntry } from "../core/models.ts";
import { effortEntriesFor, groupModelEntries, preferredModelEntry } from "../app/src/chat/model-picker.tsx";

const entries: ModelEntry[] = [
  { id: "gpt-low", handle: "openai/gpt-5", label: "GPT-5 Low", reasoning_effort: "low" },
  { id: "gpt-high", handle: "openai/gpt-5", label: "GPT-5 High", reasoning_effort: "high", is_default: true },
  { id: "claude", handle: "anthropic/claude-sonnet", label: "Claude Sonnet" },
];

describe("model effort metadata", () => {
  test("reads the agent's own effort from its record's model_settings; anything else leaves the model's", () => {
    expect(reasoningEffortFromSettings({ reasoning_effort: "high" })).toBe("high");
    expect(reasoningEffortFromSettings({ reasoning_effort: "turbo" })).toBeNull();
    expect(reasoningEffortFromSettings({ context_window_limit: 1000 })).toBeNull();
    expect(reasoningEffortFromSettings(null)).toBeNull();
  });

  test("groups one model's presets and chooses the requested or default effort", () => {
    const groups = groupModelEntries(entries);
    expect(groups.map((g) => g.handle)).toEqual(["openai/gpt-5", "anthropic/claude-sonnet"]);
    expect(effortEntriesFor(entries, "openai/gpt-5").map((e) => e.reasoning_effort)).toEqual(["low", "high"]);
    expect(preferredModelEntry(groups[0], "low").id).toBe("gpt-low");
    expect(preferredModelEntry(groups[0], "max").id).toBe("gpt-high");
  });
});

import { describe, expect, test } from "bun:test";
import { AppServerSocket } from "../core/attention/protocol.ts";
import { modelEntriesFromWire, reasoningEffortFromSettings, type ModelEntry } from "../core/models.ts";
import { effortEntriesFor, groupModelEntries, preferredModelEntry } from "../app/src/chat/ModelPicker.tsx";
import type { Transport } from "../core/attention/transport.ts";

const entries: ModelEntry[] = [
  { id: "gpt-low", handle: "openai/gpt-5", label: "GPT-5 Low", reasoningEffort: "low" },
  { id: "gpt-high", handle: "openai/gpt-5", label: "GPT-5 High", reasoningEffort: "high", isDefault: true },
  { id: "claude", handle: "anthropic/claude-sonnet", label: "Claude Sonnet" },
];

describe("model effort metadata", () => {
  test("reads effort variants from list_models entries", () => {
    expect(
      modelEntriesFromWire([
        { id: "gpt-low", handle: "openai/gpt-5", label: "GPT-5", updateArgs: { reasoning_effort: "low" } },
        { id: "plain", handle: "anthropic/claude", label: "Claude", updateArgs: { reasoning_effort: "turbo" } },
      ]),
    ).toEqual([
      { id: "gpt-low", handle: "openai/gpt-5", label: "GPT-5", reasoningEffort: "low" },
      { id: "plain", handle: "anthropic/claude", label: "Claude" },
    ]);
  });

  test("expands reasoning levels, including the ChatGPT OAuth compatibility shape", () => {
    const parsed = modelEntriesFromWire([
      {
        id: "future",
        handle: "openai-codex/future",
        label: "Future",
        reasoning_levels: ["off", "low", "turbo", "high"],
        updateArgs: { provider_type: "chatgpt_oauth" },
      },
      {
        id: "sol",
        handle: "openai-codex/gpt-5.6-sol",
        label: "GPT-5.6 Sol",
        updateArgs: { provider_type: "chatgpt_oauth" },
      },
      { id: "claude", handle: "anthropic/claude-opus-5", label: "Claude Opus 5" },
    ]);

    expect(parsed.filter((entry) => entry.handle === "openai-codex/future").map((entry) => entry.reasoningEffort)).toEqual(["none", "low", "high"]);
    expect(parsed.filter((entry) => entry.handle === "openai-codex/gpt-5.6-sol").map((entry) => entry.reasoningEffort)).toEqual(["none", "low", "medium", "high", "xhigh", "max"]);
    expect(parsed.filter((entry) => entry.handle === "anthropic/claude-opus-5")).toEqual([{ id: "claude", handle: "anthropic/claude-opus-5", label: "Claude Opus 5" }]);
  });

  test("reads persisted effort across provider-specific settings", () => {
    expect(reasoningEffortFromSettings({ effort: "high" })).toBe("high");
    expect(reasoningEffortFromSettings({ reasoning: { reasoning_effort: "xhigh" } })).toBe("xhigh");
    expect(reasoningEffortFromSettings({ reasoning: null })).toBeNull(); // provider default, not "off"
    expect(reasoningEffortFromSettings({ thinking: { type: "disabled" } })).toBe("none");
    expect(reasoningEffortFromSettings({ effort: "turbo" })).toBeNull();
  });

  test("groups one model's presets and chooses the requested or default effort", () => {
    const groups = groupModelEntries(entries);
    expect(groups.map((g) => g.handle)).toEqual(["openai/gpt-5", "anthropic/claude-sonnet"]);
    expect(effortEntriesFor(entries, "openai/gpt-5").map((e) => e.reasoningEffort)).toEqual(["low", "high"]);
    expect(preferredModelEntry(groups[0], "low").id).toBe("gpt-low");
    expect(preferredModelEntry(groups[0], "max").id).toBe("gpt-high");
  });
});

describe("model update protocol", () => {
  test("sends the exact preset and effort and returns the applied settings", async () => {
    let handlers: Parameters<Transport["open"]>[0] | null = null;
    const sent: Array<Record<string, unknown>> = [];
    const transport: Transport = {
      open(next) {
        handlers = next;
        queueMicrotask(next.onOpen);
      },
      send(raw) {
        const message = JSON.parse(raw) as Record<string, unknown>;
        sent.push(message);
        queueMicrotask(() =>
          handlers?.onMessage(
            JSON.stringify({
              type: "update_model_response",
              request_id: message.request_id,
              success: true,
              model_handle: "openai/gpt-5",
              model_settings: { reasoning: { reasoning_effort: "high" } },
            }),
          ),
        );
      },
      close() {},
    };
    const socket = new AppServerSocket("ws://test", () => transport);

    const applied = await socket.updateModel(
      { agent_id: "agent-1", conversation_id: "conv-1" },
      { id: "gpt-high", handle: "openai/gpt-5", reasoningEffort: "high" },
    );

    expect(sent[0]).toMatchObject({
      type: "update_model",
      runtime: { agent_id: "agent-1", conversation_id: "conv-1" },
      payload: { model_id: "gpt-high", model_handle: "openai/gpt-5", reasoning_effort: "high" },
    });
    expect(applied).toEqual({ handle: "openai/gpt-5", reasoningEffort: "high" });

    // A bare handle (the recall worker's model) travels as model_handle alone, so Letta resolves it by handle.
    await socket.updateModel({ agent_id: "agent-1", conversation_id: "conv-1" }, "openai/gpt-5");
    expect(sent[1]).toMatchObject({ type: "update_model", payload: { model_handle: "openai/gpt-5" } });
    expect((sent[1] as { payload: Record<string, unknown> }).payload).not.toHaveProperty("model_id");
    socket.close();
  });
});

import { describe, expect, test } from "vitest";
import type { AdvisorView } from "../core/advisor.ts";
import { FrameChatClient } from "../core/attention/chat-client.ts";
import type { ModelEntry } from "../core/models.ts";
import { advisorConversation, lokiModels, type AdvisorModels } from "../app/src/workspace/advisor-pane.tsx";
import { must } from "./fixtures/must.ts";

const RT = { agent_id: "ada", conversation_id: "advisor-c1" };
const ADVISOR: AdvisorView = { advisor_chat: "advisor-c1", model: "openai/gpt-6", working: false, waiting: 0, last_failure: null };
const ENTRIES: ModelEntry[] = [
  { id: "gpt-6", handle: "openai/gpt-6", label: "GPT-6" },
  { id: "sol", handle: "openai/gpt-6.1-sol", label: "GPT-6.1 Sol" },
  { id: "claude", handle: "acp:claude/default", label: "Claude Code" },
  { id: "claude-opus", handle: "acp:claude/opus", label: "Claude Code · Opus" },
];
const CATCH_UP = {
  send: () => Promise.resolve(null),
  answer: () => {},
  decide: () => {},
  cancelQueued: () => Promise.resolve(null),
  stop: () => Promise.resolve(null),
} as never;

const conversation = (models: Partial<AdvisorModels>) =>
  advisorConversation(CATCH_UP, { deskRuntime: RT, deskChat: null }, ADVISOR, { entries: ENTRIES, model: null, reasoningEffort: null, ...models }, undefined);

describe("changing an advisor chat's model (R8, R9)", () => {
  test("only loki's own models are offered, none of another engine's", () => {
    expect(lokiModels(ENTRIES)?.map((e) => e.handle)).toEqual(["openai/gpt-6", "openai/gpt-6.1-sol"]);
    expect(lokiModels(null)).toBeNull();
  });

  test("a pick sends chat_model for the advisor chat, and the advisor offers no permission mode", async () => {
    const sent: unknown[] = [];
    const client = new FrameChatClient({
      request: ((type: string, payload: unknown) => (sent.push({ type, ...(payload as object) }), Promise.resolve({ ok: true, reply: {} }))) as never,
      onChatEvent: () => () => {},
    });
    const scopes: string[] = [];
    const { actions } = conversation({
      onPick: async (scope, rt, selection) => {
        scopes.push(scope);
        await client.updateModel(rt, selection);
      },
    });
    expect(actions.onPickMode).toBeUndefined();
    await must(actions.onPickModel, "a model pick")({ id: "sol", handle: "openai/gpt-6.1-sol", reasoning_effort: "high" });
    expect(sent).toEqual([{ type: "chat_model", agent_id: "ada", conversation_id: "advisor-c1", handle: "openai/gpt-6.1-sol", reasoning_effort: "high" }]);
    expect(scopes).toEqual(["advisor-c1"]);
  });

  test("the view shows the advisor's model until the person picks one here", () => {
    expect(conversation({}).view.model).toBe("openai/gpt-6");
    expect(conversation({ model: "openai/gpt-6.1-sol", reasoningEffort: "high" }).view).toMatchObject({ model: "openai/gpt-6.1-sol", reasoningEffort: "high" });
    expect(conversation({}).actions.onPickModel).toBeUndefined();
  });
});

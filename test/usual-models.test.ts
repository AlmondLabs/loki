import { describe, expect, test } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { USUAL_MAX, readUsualModels, recordUsualModel, topUsualModel } from "../mod/usual-models.ts";
import { chatFrames, type ChatBackend } from "../mod/frames/chat.ts";
import type { FrameContext } from "../mod/frames/context.ts";

// Plan 2026-11-13-1240: each agent keeps its three usual model configurations, written only on a switch.

const file = () => join(mkdtempSync(join(tmpdir(), "loki-usual-")), "state", "usual-models.json");
const at = (minute: number) => new Date(Date.UTC(2026, 10, 13, 12, minute));
const shape = (f: string, agent: string) =>
  (readUsualModels(f)[agent] ?? []).map((u) => `${u.handle}${u.reasoning_effort ? `@${u.reasoning_effort}` : ""}×${u.uses}`);

describe("each agent's usual models (mod/usual-models.ts)", () => {
  test("nothing kept reads as none; a switch counts, model and effort together, most used first", () => {
    const f = file();
    expect(readUsualModels(f)).toEqual({});
    expect(topUsualModel("a1", f)).toBeNull();
    recordUsualModel("a1", "anthropic/fable", "high", at(0), f);
    recordUsualModel("a1", "openai/gpt", null, at(1), f);
    recordUsualModel("a1", "anthropic/fable", "high", at(2), f);
    recordUsualModel("a1", "anthropic/fable", "low", at(3), f);
    expect(shape(f, "a1")).toEqual(["anthropic/fable@high×2", "anthropic/fable@low×1", "openai/gpt×1"]);
    expect(topUsualModel("a1", f)).toMatchObject({ handle: "anthropic/fable", reasoning_effort: "high", uses: 2 });
  });

  test("at most three: a new one takes the least used one's place, the older on a tie; each agent keeps its own", () => {
    const f = file();
    recordUsualModel("a1", "m/one", null, at(0), f);
    recordUsualModel("a1", "m/one", null, at(1), f);
    recordUsualModel("a1", "m/two", null, at(2), f);
    recordUsualModel("a1", "m/three", null, at(3), f);
    recordUsualModel("a1", "m/four", null, at(4), f);
    expect(shape(f, "a1")).toEqual(["m/one×2", "m/four×1", "m/three×1"]);
    expect(USUAL_MAX).toBe(3);
    recordUsualModel("a2", "acp:claude/default", null, at(5), f);
    expect(topUsualModel("a2", f)?.handle).toBe("acp:claude/default");
    expect(topUsualModel("a1", f)?.handle).toBe("m/one");
  });

  test("a broken file, or broken entries in it, read as none", () => {
    const f = file();
    recordUsualModel("a1", "m/one", null, at(0), f);
    writeFileSync(f, "{not json");
    expect(readUsualModels(f)).toEqual({});
    writeFileSync(f, JSON.stringify({ version: 1, agents: { a1: [{ handle: "" }, { handle: "m/ok", reasoning_effort: "huge", uses: -2 }] } }));
    expect(readUsualModels(f)).toEqual({ a1: [{ handle: "m/ok", reasoning_effort: null, uses: 1, at: "" }] });
  });
});

describe("a switch counts and every window hears", () => {
  test("chat_model records the switch once it succeeds and broadcasts models_usual; a refused one records nothing", async () => {
    const recorded: string[] = [];
    const broadcasts: unknown[] = [];
    let refuse = false;
    const backend = {
      model: () => (refuse ? Promise.reject(new Error("this chat has started on an ACP agent")) : Promise.resolve()),
    } as unknown as ChatBackend;
    const frames = chatFrames({
      chat: backend,
      usualModels: {
        read: () => ({}),
        record: (agentId, handle, effort) => (
          recorded.push(`${agentId} ${handle} ${effort ?? "-"}`),
          { [agentId]: [{ handle, reasoning_effort: effort, uses: 1, at: "" }] }
        ),
      },
    });
    const ctx = { broadcast: (m: unknown) => broadcasts.push(m) } as unknown as FrameContext;
    const run = frames.chat_model;
    if (!run) throw new Error("no chat_model handler");
    await run({ agent_id: "a1", conversation_id: "c1", handle: "m/one", reasoning_effort: "high" }, ctx);
    expect(recorded).toEqual(["a1 m/one high"]);
    expect(broadcasts).toEqual([{ type: "models_usual", usual: { a1: [{ handle: "m/one", reasoning_effort: "high", uses: 1, at: "" }] } }]);
    refuse = true;
    await run({ agent_id: "a1", conversation_id: "c1", handle: "m/two", reasoning_effort: null }, ctx);
    expect(recorded).toHaveLength(1);
  });
});

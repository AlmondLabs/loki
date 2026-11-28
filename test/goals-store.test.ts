import { afterAll, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, MemoryStorage } from "@earendil-works/pi-durable";
import { GoalsStore } from "../daemon/goals-store.ts";
import { goalsExtension, goalsSection } from "../daemon/goals.ts";
import { AgentStore } from "../daemon/kernel/index.ts";
import { sections } from "../daemon/section-cache.ts";

const dirs: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "loki-goals-store-"));
  dirs.push(dir);
  return dir;
};

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("GoalsStore", () => {
  test("creates, updates, logs progress, toggles habit checkins, and persists to disk", () => {
    const dir = tempDir();
    let nowMs = Date.parse("2026-11-28T09:00:00.000Z");
    const store = new GoalsStore(join(dir, "goals.json"), () => new Date(nowMs));
    let events = 0;
    const off = store.onChange(() => {
      events += 1;
    });

    const parent = store.create({ title: "Grow revenue", horizon: "long", why: "$1M ARR" });
    const child = store.create({
      title: "Launch self-serve onboarding",
      horizon: "short",
      parent_id: parent.id,
      obstacle: "Edge-case bugs",
      fallback_plan: "Ship with feature flag",
      lead_habit: { label: "Ship 1 onboarding fix", per_week: 3 },
    });
    expect(events).toBe(2);

    nowMs += 3600_000;
    const logged = store.logProgress(child.id, "Deployed step 1", { source: "reflection", chat_id: "c1", agent_id: "a1" });
    expect(logged.entries).toHaveLength(1);
    expect(logged.entries[0]).toMatchObject({ note: "Deployed step 1", source: "reflection", chat_id: "c1", agent_id: "a1" });
    expect(logged.progress).toBe("Deployed step 1");

    const checked = store.toggleHabitCheckin(child.id, "2026-11-28", true);
    expect(checked.lead_habit?.checkins).toEqual(["2026-11-28"]);

    const reopened = new GoalsStore(join(dir, "goals.json"));
    expect(reopened.list()).toHaveLength(2);
    expect(reopened.get(child.id)?.parent_id).toBe(parent.id);

    expect(() => store.update(parent.id, { parent_id: child.id })).toThrow(/cycle/);
    expect(() => store.update(parent.id, { parent_id: parent.id })).toThrow(/own parent/);

    expect(store.remove(parent.id)).toBe(true);
    expect(store.get(child.id)?.parent_id).toBeNull();
    off();
  });

  test("caps progress entries at 50 and invalidates section cache on change", () => {
    const dir = tempDir();
    const store = new GoalsStore(join(dir, "goals.json"));
    const g = store.create({ title: "Write book", horizon: "medium" });
    sections.get(`goals\u0000a1`, () => "stale");
    for (let i = 0; i < 55; i++) store.logProgress(g.id, `Chapter draft ${i}`);
    const latest = store.get(g.id);
    expect(latest?.entries).toHaveLength(50);
    expect(latest?.entries[0]?.note).toBe("Chapter draft 5");
    expect(sections.get(`goals\u0000a1`, () => goalsSection(store, "a1"))).toContain("Write book");
  });

  test("goalsExtension injects <goals> section and executes goal_list, goal_create, and goal_update", async () => {
    const dir = tempDir();
    const store = new GoalsStore(join(dir, "goals.json"));
    store.create({ title: "Existing goal", horizon: "medium" });

    const ctx = BACKGROUND_CONTEXT;
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const registry = createRegistry();
    registry.install(goalsExtension(store));
    const agentStore = await AgentStore.open({ storage: new MemoryStorage() }, { models, registry }, ctx);
    try {
      const seenPrompts: string[] = [];
      faux.setResponses([
        (c: { messages: unknown }) => {
          seenPrompts.push(JSON.stringify(c.messages));
          return fauxAssistantMessage(fauxToolCall("goal_create", { title: "Ship goals", horizon: "short", next_step: "Run tests" }), {
            stopReason: "toolUse",
          });
        },
        () => {
          const createdId = store.list().find((g) => g.title === "Ship goals")?.id ?? "";
          return fauxAssistantMessage(fauxToolCall("goal_update", { id: createdId, progress_note: "All tests pass", status: "achieved" }), {
            stopReason: "toolUse",
          });
        },
        () => fauxAssistantMessage(fauxToolCall("goal_list", {}), { stopReason: "toolUse" }),
        fauxAssistantMessage("Done."),
      ]);

      const chat = await agentStore.createChat("c1", { agent: { model: { provider: faux.provider.id, modelId: faux.getModel().id } } }, ctx);
      await (await chat.submit({ type: "input", content: "Track shipping goals" }, ctx)).wait(ctx);

      expect(seenPrompts[0]).toContain("Existing goal");
      expect(seenPrompts[0]).toContain("treat them as your own");
      const created = store.list().find((g) => g.title === "Ship goals");
      expect(created).toMatchObject({ status: "achieved", progress: "All tests pass" });
      expect(created?.entries[0]?.note).toBe("All tests pass");
    } finally {
      await agentStore.close(ctx);
    }
  });
});

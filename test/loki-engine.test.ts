import { describe, expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage, watchEvents } from "@earendil-works/pi-durable";
import { Approvals } from "../daemon/approvals.ts";
import { AgentStore } from "../daemon/kernel/index.ts";
import { LokiEngine } from "../daemon/loki-engine.ts";
import { ModRegistry } from "../daemon/mods/registry.ts";

const ctx = BACKGROUND_CONTEXT;

describe("following a chat's events", () => {
  test("a follow that failed once is tried again by the next open, not answered with the same error until a restart", async () => {
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const mods = new ModRegistry(() => {});
    const store = await AgentStore.open({ storage: new MemoryStorage() }, { models, registry: mods.registry }, ctx);
    const chat = await store.createChat("c1", { agent: { model: { provider: faux.provider.id, modelId: faux.getModel().id } } }, ctx);
    let fails = 1;
    let watched = 0;
    const engine = new LokiEngine({
      approvals: new Approvals(),
      mods,
      models,
      backendDir: "",
      context: ctx,
      push: () => {},
      watch: (...args) => {
        watched++;
        if (fails-- > 0) return Promise.reject(new Error("the store is busy"));
        return watchEvents(...args);
      },
    });
    const c = { agentId: "ada", conversationId: "c1", store, chat, engine: null };
    await expect(engine.open(c, null)).rejects.toThrow("the store is busy");
    await engine.open(c, null);
    await engine.open(c, null);
    // Once for the failure, once for the follow that took; the third open reuses it.
    expect(watched).toBe(2);
    await store.close(ctx);
  });
});

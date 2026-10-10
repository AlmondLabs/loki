import { describe, expect, test } from "vitest";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, MemoryStorage } from "@earendil-works/pi-durable";
import { AgentStore } from "../daemon/kernel/index.ts";
import { StoreManager } from "../daemon/kernel/stores.ts";

const ctx = BACKGROUND_CONTEXT;

function manager(reports: string[] = []) {
  const options = { models: createModels(), registry: createRegistry() };
  const opened: string[] = [];
  const stores = new StoreManager("/nowhere", options, ctx, (m) => reports.push(m), (file) => {
    opened.push(file);
    return AgentStore.open({ storage: new MemoryStorage() }, options, ctx);
  });
  return { stores, opened };
}

async function until(check: () => boolean, ms = 2000) {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
}

describe("store manager", () => {
  test("an agent's store opens once and is shared, each agent its own file", async () => {
    const { stores, opened } = manager();
    const [a1, a2, b] = await Promise.all([stores.get("agent-a"), stores.get("agent-a"), stores.get("agent-b")]);
    expect(a1).toBe(a2);
    expect(a1).not.toBe(b);
    expect(opened).toEqual([join("/nowhere", "agent-a.sqlite"), join("/nowhere", "agent-b.sqlite")]);
    expect(stores.agents().sort()).toEqual(["agent-a", "agent-b"]);
    await stores.closeAll();
  });

  test("a store that closes on its own is opened again, and the other agents' stores are untouched", async () => {
    const reports: string[] = [];
    const { stores } = manager(reports);
    const seen: string[] = [];
    stores.onOpen((id) => seen.push(id));
    const a = await stores.get("agent-a");
    const b = await stores.get("agent-b");
    await a.harness.close(ctx); // what a storage error does
    await until(() => seen.filter((id) => id === "agent-a").length === 2);
    expect(seen).toEqual(["agent-a", "agent-b", "agent-a"]);
    expect(await stores.get("agent-a")).not.toBe(a);
    expect(await stores.get("agent-b")).toBe(b);
    expect(reports.some((r) => r.includes("agent-a") && r.includes("again"))).toBe(true);
    await stores.closeAll();
  });

  test("a store closed through the manager stays closed", async () => {
    const { stores } = manager();
    const seen: string[] = [];
    stores.onOpen((id) => seen.push(id));
    await stores.get("agent-a");
    await stores.close("agent-a");
    await new Promise((r) => setTimeout(r, 50));
    expect(seen).toEqual(["agent-a"]);
    expect(stores.agents()).toEqual([]);
  });
});

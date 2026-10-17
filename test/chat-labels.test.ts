import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { chatLabels, LABEL_COLORS, labelName } from "../core/labels.ts";
import { FRAMES } from "../core/frames.ts";
import { DaemonChats } from "../daemon/chat-backend.ts";
import { Approvals } from "../daemon/approvals.ts";
import { ChatProjection } from "../daemon/chats.ts";
import { KeychainCredentials, memorySecrets } from "../daemon/credentials.ts";
import { AgentStore } from "../daemon/kernel/index.ts";
import { StoreManager } from "../daemon/kernel/stores.ts";
import { LabelColors } from "../daemon/labels.ts";
import { ModRegistry } from "../daemon/mods/registry.ts";
import { Providers } from "../daemon/providers.ts";

const ctx = BACKGROUND_CONTEXT;
/** The colours a labels file holds. */
const savedColors = (file: string) => (JSON.parse(readFileSync(file, "utf8")) as { colors: Record<string, number> }).colors;
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

/** A daemon's chats with two agents, the labels' colours kept in a file under a temporary folder. */
async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "loki-labels-"));
  const models = createModels();
  models.setProvider(fauxProvider().provider);
  const mods = new ModRegistry(() => {});
  const stores = new StoreManager(
    join(dir, "stores"),
    { models, registry: mods.registry },
    ctx,
    () => {},
    () => AgentStore.open({ storage: new MemoryStorage() }, { models, registry: mods.registry }, ctx),
  );
  const labelsFile = join(dir, "state", "labels.json");
  const chats = new DaemonChats({
    stores,
    mods,
    approvals: new Approvals(),
    providers: new Providers(models, new KeychainCredentials(memorySecrets())),
    models,
    labelsFile,
    backendDir: join(dir, "backend"),
    context: ctx,
  });
  cleanups.push(async () => {
    await stores.closeAll();
    rmSync(dir, { recursive: true, force: true });
  });
  const ada = await chats.createAgent({ name: "Ada", description: null, persona: null, model: null });
  const bob = await chats.createAgent({ name: "Bob", description: null, persona: null, model: null });
  const label = (agentId: string, conversationId: string, labels: string[]) =>
    chats.update({ agent_id: agentId, conversation_id: conversationId, title: undefined, archived: undefined, hidden: undefined, labels });
  const labelsOf = async (agentId: string, conversationId: string) =>
    (await (await stores.get(agentId)).chats(ctx)).find((c) => c.id === conversationId)?.labels;
  return { dir, chats, stores, ada: ada.id, bob: bob.id, label, labelsOf, labelsFile };
}

describe("a label's name (plan 022, R2)", () => {
  test("typed words become lowercase letters, digits and dashes, at most 32; nothing left is no label", () => {
    expect(labelName("Client X")).toBe("client-x");
    expect(labelName("  --Infra__2026!! ")).toBe("infra-2026");
    expect(labelName("a".repeat(40))).toHaveLength(32);
    expect(labelName(`${"a".repeat(31)} b`)).toBe("a".repeat(31));
    expect(labelName("!!!")).toBeNull();
  });
  test("a chat's labels: named, blanks and repeats dropped, in order, at most eight", () => {
    expect(chatLabels(["Infra", "infra", "", "Billing", "?"])).toEqual(["infra", "billing"]);
    expect(chatLabels(Array.from({ length: 10 }, (_, i) => `l${i}`))).toHaveLength(8);
  });
  test("chat_update takes labels as a chat keeps them; chat_label_set wants a name and something to do", () => {
    const ref = { agent_id: "agent-local-a", conversation_id: "c" };
    expect(FRAMES.chat_update.parse({ ...ref, labels: ["Client X", "client-x", 3] })).toMatchObject({ labels: ["client-x"] });
    expect(FRAMES.chat_update.parse({ ...ref, title: "t" })).toMatchObject({ labels: undefined });
    expect(FRAMES.chat_label_set.parse({ name: "Infra", rename: "Platform" })).toEqual({ name: "infra", rename: "platform" });
    expect(FRAMES.chat_label_set.parse({ name: "infra", color: 3 })).toEqual({ name: "infra", color: 3 });
    expect(FRAMES.chat_label_set.parse({ name: "infra", remove: true })).toEqual({ name: "infra", remove: true });
    expect(FRAMES.chat_label_set.parse({ name: "infra", color: LABEL_COLORS })).toBe("rename, color or remove required");
    expect(FRAMES.chat_label_set.parse({ name: "infra", rename: "!!" })).toBe("rename to a label of letters, digits or dashes");
    expect(FRAMES.chat_label_set.parse({ name: "" })).toBe("name required");
  });
});

describe("label colours (KD4)", () => {
  test("a new label takes the colour the fewest have; colours are kept in the file and go with a rename", () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-label-colors-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const file = join(dir, "labels.json");
    const colors = new LabelColors(file);
    const first = Array.from({ length: LABEL_COLORS }, (_, i) => colors.colorOf(`l${i}`));
    expect(new Set(first).size).toBe(LABEL_COLORS);
    expect(colors.colorOf("l0")).toBe(first[0]);
    colors.set("l1", 5);
    colors.rename("l1", "m1");
    expect(new LabelColors(file).colorOf("m1")).toBe(5);
    colors.remove("m1");
    expect(savedColors(file)).not.toHaveProperty("m1");
  });
  test("a missing file starts empty, and a colour outside the palette is ignored", () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-label-colors-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    expect(new LabelColors(join(dir, "missing.json")).colorOf("a")).toBe(0);
    const file = join(dir, "labels.json");
    writeFileSync(file, JSON.stringify({ colors: { a: 3, b: LABEL_COLORS, c: -1, d: "2" } }));
    const colors = new LabelColors(file);
    expect(colors.colorOf("a")).toBe(3);
    // b, c and d were not kept, so b takes a free colour like any new label.
    expect(colors.colorOf("b")).toBe(0);
  });
});

describe("labels on chats (plan 022)", () => {
  test("a chat keeps its labels; the list counts them across agents, each with its colour, hidden chats left out", async () => {
    const s = await setup();
    const a1 = (await s.chats.create(s.ada, null, null)).conversationId;
    const a2 = (await s.chats.create(s.ada, null, null)).conversationId;
    const b1 = (await s.chats.create(s.bob, null, null)).conversationId;
    await s.label(s.ada, a1, ["infra", "billing"]);
    await s.label(s.ada, a2, ["infra"]);
    await s.label(s.bob, b1, ["infra"]);
    expect(await s.labelsOf(s.ada, a1)).toEqual(["infra", "billing"]);
    const { labels } = await s.chats.labels();
    expect(labels.map((l) => [l.name, l.chats])).toEqual([
      ["billing", 1],
      ["infra", 3],
    ]);
    expect(new Set(labels.map((l) => l.color)).size).toBe(2);
    await s.chats.update({ agent_id: s.ada, conversation_id: a2, title: undefined, archived: undefined, hidden: true, labels: undefined });
    expect((await s.chats.labels()).labels.find((l) => l.name === "infra")?.chats).toBe(2);
    // An update without labels leaves them; an empty list clears them.
    await s.chats.update({ agent_id: s.ada, conversation_id: a1, title: "Renamed", archived: undefined, hidden: undefined, labels: undefined });
    expect(await s.labelsOf(s.ada, a1)).toEqual(["infra", "billing"]);
    await s.label(s.ada, a1, []);
    expect(await s.labelsOf(s.ada, a1)).toEqual([]);
  });

  test("renaming a label changes every chat that carries it, once even where the new name was there; deleting removes it", async () => {
    const s = await setup();
    const a1 = (await s.chats.create(s.ada, null, null)).conversationId;
    const b1 = (await s.chats.create(s.bob, null, null)).conversationId;
    await s.label(s.ada, a1, ["infra", "platform"]);
    await s.label(s.bob, b1, ["infra", "billing"]);
    const color = (await s.chats.labels()).labels.find((l) => l.name === "billing")?.color;
    const after = await s.chats.setLabel({ name: "infra", rename: "platform" });
    expect(await s.labelsOf(s.ada, a1)).toEqual(["platform"]);
    expect(await s.labelsOf(s.bob, b1)).toEqual(["platform", "billing"]);
    expect(after.labels.map((l) => [l.name, l.chats])).toEqual([
      ["billing", 1],
      ["platform", 2],
    ]);
    expect((await s.chats.setLabel({ name: "billing", color: 7 })).labels.find((l) => l.name === "billing")?.color).toBe(7);
    expect(color).not.toBe(7);
    await s.chats.setLabel({ name: "platform", remove: true });
    expect(await s.labelsOf(s.ada, a1)).toEqual([]);
    expect(await s.labelsOf(s.bob, b1)).toEqual(["billing"]);
    expect(savedColors(s.labelsFile)).toEqual({ billing: 7 });
  });

  test("the projection's details carry a chat's labels, for the sidebar, the header and the Inbox", async () => {
    const s = await setup();
    const a1 = (await s.chats.create(s.ada, null, null)).conversationId;
    const projection = new ChatProjection(ctx, () => "Ada");
    await projection.attach(s.ada, await s.stores.get(s.ada));
    expect(projection.info(a1, s.ada)?.labels).toEqual([]);
    await s.label(s.ada, a1, ["infra"]);
    expect(projection.info(a1, s.ada)?.labels).toEqual(["infra"]);
  });
});

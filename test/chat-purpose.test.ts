import { afterEach, describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { SHARED_SCOPE } from "../core/desk-core.ts";
import { FRAMES, type PayloadOf } from "../core/frames.ts";
import type { ChatEvent } from "../core/attention/model.ts";
import type { SavedDraft, Suggestion } from "../core/frame-types.ts";
import { Approvals } from "../daemon/approvals.ts";
import { DaemonChats } from "../daemon/chat-backend.ts";
import { ChatProjection } from "../daemon/chats.ts";
import { KeychainCredentials, memorySecrets } from "../daemon/credentials.ts";
import { AgentStore } from "../daemon/kernel/index.ts";
import { StoreManager } from "../daemon/kernel/stores.ts";
import { ModRegistry } from "../daemon/mods/registry.ts";
import { Providers } from "../daemon/providers.ts";
import { ChatListing } from "../mod/chat-listing.ts";
import { DeskRegistry } from "../mod/desks.ts";

const ctx = BACKGROUND_CONTEXT;
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

/** A draft saved from a suggestion made in another chat. */
const draft: SavedDraft = { text: "look at the flaky upload test", suggestion_id: "sug-1", source: { agent_id: "agent-local-b", conversation_id: "conv-src" } };

/** One agent's daemon chats in a temporary folder, read through the projection and listed as the mod lists them. */
async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "loki-purpose-"));
  const models = createModels();
  const faux = fauxProvider();
  models.setProvider(faux.provider);
  const mods = new ModRegistry(() => {});
  const stores = new StoreManager(
    join(dir, "stores"),
    { models, registry: mods.registry },
    ctx,
    () => {},
    () => AgentStore.open({ storage: new MemoryStorage() }, { models, registry: mods.registry }, ctx),
  );
  const backendDir = join(dir, "backend");
  const chats = new DaemonChats({
    stores,
    mods,
    approvals: new Approvals(),
    providers: new Providers(models, new KeychainCredentials(memorySecrets())),
    models,
    backendDir,
    context: ctx,
  });
  const pushed: ChatEvent[] = [];
  chats.attach((_agentId, _conversationId, events) => pushed.push(...events));
  cleanups.push(async () => {
    await stores.closeAll();
    rmSync(dir, { recursive: true, force: true });
  });
  const ada = (await chats.createAgent({ name: "Ada", description: null, persona: null, model: `${faux.provider.id}/${faux.getModel().id}` })).id;
  mkdirSync(join(backendDir, "memfs", ada), { recursive: true });
  const projection = new ChatProjection(ctx, () => "Ada");
  await projection.attach(ada, await stores.get(ada));
  const desks = new DeskRegistry(join(dir, "desks.json"), (id) => projection.agentOf(id));
  const listing = new ChatListing({
    chats: projection,
    desks,
    layouts: () => [],
    widgets: { entries: () => [] },
    pins: () => new Set(),
    passChats: () => () => false,
    activeScope: () => SHARED_SCOPE,
    backendDir,
  });
  const update = (conversationId: string, change: Partial<PayloadOf<"chat_update">>) =>
    chats.update({ agent_id: ada, conversation_id: conversationId, title: undefined, archived: undefined, hidden: undefined, labels: undefined, ...change });
  const row = (conversationId: string) => listing.inbox().find((r) => r.id === conversationId);
  const desk = (conversationId: string) => listing.desks().find((d) => d.conversation_id === conversationId);
  return { chats, stores, ada, projection, update, row, desk, faux, pushed };
}

describe("a chat's purpose line and saved draft (plan 047, U1)", () => {
  test("a purpose set through chat_update shows in the chat list and the Inbox row; an empty one clears it", async () => {
    const s = await setup();
    const id = (await s.chats.create(s.ada, "/work/site", "site")).conversationId;
    await s.update(id, parsed(FRAMES.chat_update.parse({ agent_id: s.ada, conversation_id: id, purpose: "  the website:\n deploys and copy " })));
    expect(s.row(id)?.purpose).toBe("the website: deploys and copy");
    expect(s.desk(id)?.purpose).toBe("the website: deploys and copy");
    // An update without a purpose leaves it.
    await s.update(id, { title: "site work" });
    expect(s.row(id)?.purpose).toBe("the website: deploys and copy");
    await s.update(id, parsed(FRAMES.chat_update.parse({ agent_id: s.ada, conversation_id: id, purpose: " " })));
    expect(s.row(id)?.purpose).toBeNull();
    expect(s.desk(id)?.purpose).toBeNull();
  });

  test("a saved draft marks the Inbox row, and clearing it unmarks it", async () => {
    const s = await setup();
    const id = (await s.chats.create(s.ada, null, null)).conversationId;
    await s.update(id, parsed(FRAMES.chat_update.parse({ agent_id: s.ada, conversation_id: id, draft })));
    expect(s.row(id)?.has_draft).toBe(true);
    expect(s.desk(id)?.has_draft).toBe(true);
    const info = (await (await s.stores.get(s.ada)).chats(ctx)).find((c) => c.id === id);
    expect(info?.draft).toEqual(draft);
    await s.update(id, parsed(FRAMES.chat_update.parse({ agent_id: s.ada, conversation_id: id, draft: null })));
    expect(s.row(id)?.has_draft).toBe(false);
  });

  test("the Inbox row carries the saved draft's text, so the chat's empty box can show it on any client", async () => {
    const s = await setup();
    const id = (await s.chats.create(s.ada, null, null)).conversationId;
    expect(s.row(id)?.draft_text).toBeNull();
    await s.update(id, { draft });
    expect(s.row(id)?.draft_text).toBe("look at the flaky upload test");
  });

  test("the chat's next send clears its saved draft and the Inbox mark", async () => {
    const s = await setup();
    const id = (await s.chats.create(s.ada, null, null)).conversationId;
    await s.update(id, { draft });
    await s.chats.open(s.ada, id);
    s.faux.setResponses([() => fauxAssistantMessage("On it.")]);
    await s.chats.send({ agent_id: s.ada, conversation_id: id, text: draft.text, images: [], send_id: "s1", context: null });
    const info = (await (await s.stores.get(s.ada)).chats(ctx)).find((c) => c.id === id);
    expect(info?.draft).toBeNull();
    expect(s.row(id)).toMatchObject({ has_draft: false, draft_text: null });
    // The turn ends before the store closes.
    await until(() => s.pushed.some((e) => e.kind === "turn_end"));
  });

  test("the rows carry the chat's folder, for agents choosing where work goes", async () => {
    const s = await setup();
    const id = (await s.chats.create(s.ada, "/work/site", null)).conversationId;
    expect(s.row(id)?.cwd).toBe("/work/site");
    expect(s.desk(id)?.cwd).toBe("/work/site");
  });

  test("a chat with none of the new fields reads as before: no purpose, no draft, no suggestions", async () => {
    const s = await setup();
    const id = (await s.chats.create(s.ada, null, null)).conversationId;
    expect(s.row(id)).toMatchObject({ purpose: null, has_draft: false, cwd: null });
    expect(s.projection.info(id, s.ada)).toMatchObject({ purpose: null, hasDraft: false });
    const info = (await (await s.stores.get(s.ada)).chats(ctx)).find((c) => c.id === id);
    expect(info?.purpose).toBeUndefined();
    expect(info?.draft).toBeUndefined();
    expect(info?.suggestions).toBeUndefined();
  });

  test("the store keeps a chat's suggestions as they are given", async () => {
    const s = await setup();
    const id = (await s.chats.create(s.ada, null, null)).conversationId;
    const suggestions: Suggestion[] = [
      {
        id: "sug-1",
        title: "fix upload",
        text: "the upload test is flaky",
        target: { agent_id: s.ada, folder: "/work/site" },
        status: "pending",
        created_at: "2026-10-29T10:00:00.000Z",
      },
    ];
    const store = await s.stores.get(s.ada);
    expect(await store.updateChat(id, { suggestions }, ctx)).toBe(true);
    expect((await store.chats(ctx)).find((c) => c.id === id)?.suggestions).toEqual(suggestions);
  });
});

describe("chat_update's purpose and draft at the frame edge", () => {
  const ref = { agent_id: "agent-local-a", conversation_id: "c" };
  test("a purpose is one line of text, an empty one or null clears it, and anything else is refused", () => {
    expect(FRAMES.chat_update.parse({ ...ref, purpose: "billing" })).toMatchObject({ purpose: "billing" });
    expect(FRAMES.chat_update.parse({ ...ref, purpose: "" })).toMatchObject({ purpose: null });
    expect(FRAMES.chat_update.parse({ ...ref, purpose: null })).toMatchObject({ purpose: null });
    expect(FRAMES.chat_update.parse({ ...ref, title: "t" })).not.toHaveProperty("purpose");
    expect(FRAMES.chat_update.parse({ ...ref, purpose: 3 })).toBe("purpose must be text");
  });
  test("a draft needs its text, its suggestion and the chat it came from; null clears it", () => {
    expect(FRAMES.chat_update.parse({ ...ref, draft })).toMatchObject({ draft });
    expect(FRAMES.chat_update.parse({ ...ref, draft: null })).toMatchObject({ draft: null });
    expect(FRAMES.chat_update.parse({ ...ref, title: "t" })).not.toHaveProperty("draft");
    expect(FRAMES.chat_update.parse({ ...ref, draft: { text: "x" } })).toBe("draft needs text, suggestion_id and source");
    expect(FRAMES.chat_update.parse({ ...ref, draft: { ...draft, text: "" } })).toBe("draft needs text, suggestion_id and source");
  });
});

/** Wait for a condition, failing after a deadline rather than sleeping a fixed time. */
async function until(check: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** A parsed frame, or the test fails with the frame's complaint. */
function parsed<T>(frame: T | string): T {
  if (typeof frame === "string") throw new Error(frame);
  return frame;
}

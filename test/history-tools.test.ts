import { describe, expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, MemoryStorage, type PromptInput } from "@earendil-works/pi-durable";
import type { TranscriptRow } from "../core/attention/transcript.ts";
import { ChatProjection } from "../daemon/chats.ts";
import { historyExtension, historyTools, readRows, searchRows } from "../daemon/history-tools.ts";
import { AgentStore } from "../daemon/kernel/index.ts";
import { sampleEntries } from "./fixtures/entries.ts";
import { must } from "./fixtures/must.ts";

const ctx = BACKGROUND_CONTEXT;

/** One agent's store with a chat `chatId` holding `entries`, attached to `chats`. */
async function agentWith(chats: ChatProjection, agentId: string, chatId: string, entries = sampleEntries()) {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const store = await AgentStore.open({ storage: new MemoryStorage() }, { models, registry: createRegistry() }, ctx);
  await store.setAgent({ id: agentId, name: agentId }, ctx);
  const chat = await store.createChat(chatId, { agent: { model: { provider: faux.provider.id, modelId: faux.getModel().id } } }, ctx);
  await store.importEntries(chat, entries, ctx);
  await chats.attach(agentId, store);
  return { store, chat };
}

/** The text a history tool answers with, called as `chat` on `store`. */
async function call(
  chats: ChatProjection,
  name: string,
  args: Record<string, unknown>,
  store: AgentStore,
  conversationId: Parameters<typeof store.harness.conversation>[0],
) {
  const tool = must(
    historyTools(chats).find((t) => t.name === name),
    name,
  );
  const result = await tool.run(args, { read: store.harness, conversationId, callId: "call", signal: new AbortController().signal, output: () => {} }, ctx);
  return result.output?.map((o) => o.text).join("") ?? "";
}

const row = (role: TranscriptRow["role"], text: string): TranscriptRow => ({ role, text });

describe("history_search and history_read", () => {
  test("find a turn from before the compaction by its row in the thread, and read it back", async () => {
    const chats = new ChatProjection(ctx, () => null);
    const { store, chat } = await agentWith(chats, "agent-a", "c");
    try {
      const thread = chats.thread("c", "agent-a");
      const asked = thread.findIndex((r) => r.role === "user" && r.text.includes("readme"));
      expect(asked).toBeGreaterThanOrEqual(0);
      const found = await call(chats, "history_search", { query: "README" }, store, chat.id);
      expect(found).toContain(`#${asked} person`);
      expect(found).toContain("What is in the readme?");
      const read = await call(chats, "history_read", { from: asked, to: asked }, store, chat.id);
      expect(read.startsWith(`#${asked} person`)).toBe(true);
      expect(read).toContain("What is in the readme?");
    } finally {
      await store.close(ctx);
    }
  });

  test("read only the calling agent's chat, though another agent has a chat of the same id", async () => {
    const chats = new ChatProjection(ctx, () => null);
    const a = await agentWith(chats, "agent-a", "c");
    const b = await agentWith(chats, "agent-b", "c", [
      {
        sourceId: "s1",
        line: 1,
        kind: "pi.user",
        model: [{ role: "user", timestamp: 1790848801000, content: [{ type: "text", text: "the other agent's secret" }] }],
      },
    ]);
    try {
      expect(await call(chats, "history_search", { query: "secret" }, a.store, a.chat.id)).toContain("No row of this conversation");
      expect(await call(chats, "history_search", { query: "secret" }, b.store, b.chat.id)).toContain("#0 person");
    } finally {
      await a.store.close(ctx);
      await b.store.close(ctx);
    }
  });

  test("words match across a line break and in any case", () => {
    const rows = [row("user", "the Deploy\n  failed again"), row("assistant", "deploy worked")];
    expect(searchRows(rows, "deploy   FAILED")).toBe('1 row contains "deploy   FAILED":\n#0 person: the Deploy failed again');
  });

  test("a search shows the newest 10 hits and says how many there were", () => {
    const rows = Array.from({ length: 15 }, (_, n) => row(n % 2 ? "assistant" : "user", `step ${n} of the deploy`));
    const found = searchRows(rows, "deploy");
    expect(found.split("\n")[0]).toContain("15 rows contain");
    expect(found.split("\n")[0]).toContain("newest 10");
    expect(
      found
        .split("\n")
        .slice(1)
        .map((l) => /^#(\d+)/.exec(l)?.[1]),
    ).toEqual(["14", "13", "12", "11", "10", "9", "8", "7", "6", "5"]);
    expect(() => searchRows(rows, "  ")).toThrow("needs words");
  });

  test("a tool row is found by its input and output, and named by its tool", () => {
    const rows: TranscriptRow[] = [{ role: "tool", text: "ran a command", tool: { name: "bash", input: "npm test", output: "3 failed" } }];
    expect(searchRows(rows, "3 failed")).toContain("#0 tool bash");
    expect(readRows(rows, 0)).toBe("#0 tool bash: input: npm test\noutput: 3 failed");
  });

  test("a long read stops and says where to go on; a read past the end says which rows there are", () => {
    const rows = Array.from({ length: 5 }, (_, n) => row("assistant", `${n}`.repeat(3000)));
    const read = readRows(rows, 0);
    expect(read).toContain("[stopped before #2; read on with history_read from 2]");
    expect(read).not.toContain("#2 you");
    expect(readRows(rows, 9)).toBe("Nothing at #9: this conversation's rows are #0 to #4.");
    expect(readRows([], 0)).toBe("This conversation has no rows yet.");
  });
});

describe("the history section", () => {
  /** The section's text for `chat` on `store`, offered `tools`. */
  async function render(chats: ChatProjection, store: AgentStore, conversationId: PromptInput["conversationId"], tools: string[]) {
    const section = must(historyExtension(chats).sections?.[0], "the history section");
    const input = { conversationId, read: store.harness, agent: { tools: tools.map((name) => ({ name })) }, env: undefined, shown: {} };
    return section.render(input as unknown as PromptInput, ctx);
  }

  test("shows once the chat has been compacted, and only where history_search is offered", async () => {
    const chats = new ChatProjection(ctx, () => null);
    const compacted = await agentWith(chats, "agent-a", "c");
    const whole = await agentWith(
      chats,
      "agent-b",
      "c",
      sampleEntries().filter((e) => e.kind !== "pi.compaction"),
    );
    try {
      expect(await render(chats, compacted.store, compacted.chat.id, ["history_search"])).toContain("history_search");
      expect(await render(chats, compacted.store, compacted.chat.id, ["memory_read"])).toBeUndefined();
      expect(await render(chats, whole.store, whole.chat.id, ["history_search"])).toBeUndefined();
    } finally {
      await compacted.store.close(ctx);
      await whole.store.close(ctx);
    }
  });
});

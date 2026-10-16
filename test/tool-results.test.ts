import { describe, expect, test } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, MemoryStorage, type ConversationId, type DocumentReader } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { AgentStore } from "../daemon/kernel/index.ts";
import { ChatEnv, chatEnvs, toolResultsDir } from "../daemon/tool-results.ts";

const ctx = BACKGROUND_CONTEXT;
const conversation = 7 as ConversationId;
/** A document reader whose chat document has `id`, or none at all. */
const reader = (id?: string) => ({ snapshot: () => Promise.resolve(id === undefined ? undefined : { id }) }) as unknown as Pick<DocumentReader, "snapshot">;

/** A command that prints `lines` lines, run without a shell so it behaves the same on Windows. */
const print = (lines: number) => [process.execPath, "-e", `process.stdout.write("a line of output\\n".repeat(${lines}))`];

/** Too-big tool results are saved under `<loki>/tool-results/<chat>/`, bash output past pi-durable's limits included. */
describe("tool results", () => {
  test("a chat's folder is named for its chat id, made safe, or for its conversation before it has one", async () => {
    expect(await toolResultsDir("/loki", reader("c/1 x"), conversation, ctx)).toBe(join("/loki", "tool-results", "c_1_x"));
    expect(await toolResultsDir("/loki", reader(), conversation, ctx)).toBe(join("/loki", "tool-results", "conversation-7"));
  });

  test("bash output past the limits is saved whole in the chat's folder; output within them saves nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-results-"));
    try {
      const resultsDir = join(dir, "tool-results", "c1");
      const env = new ChatEnv({ cwd: dir, resultsDir });
      const spill = { afterBytes: 1000, afterLines: 100 };
      const big = await env.exec(print(500), { spill }, ctx);
      if (!big.ok) throw big.error;
      expect(big.value.spillPath && dirname(big.value.spillPath)).toBe(resultsDir);
      expect(readFileSync(big.value.spillPath ?? "", "utf8")).toBe("a line of output\n".repeat(500));
      const small = await env.exec(print(3), { spill }, ctx);
      if (!small.ok) throw small.error;
      expect(small.value.spillPath).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("when the chat's folder cannot be written, the system's temp folder still takes the output", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-results-"));
    try {
      // A file where the folder should be: nothing can be made inside it.
      const blocked = join(dir, "tool-results");
      writeFileSync(blocked, "");
      const env = new ChatEnv({ cwd: dir, resultsDir: join(blocked, "c1") });
      const big = await env.exec(print(500), { spill: { afterBytes: 1000, afterLines: 100 } }, ctx);
      if (!big.ok) throw big.error;
      const saved = big.value.spillPath ?? "";
      expect(saved.startsWith(blocked)).toBe(false);
      expect(readFileSync(saved, "utf8")).toBe("a line of output\n".repeat(500));
      rmSync(dirname(saved), { recursive: true, force: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("in a chat, bash output past the limits ends with the path of the whole of it, in the chat's folder", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-results-"));
    const registry = createRegistry();
    registry.install(CodingTools);
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const store = await AgentStore.open({ storage: new MemoryStorage() }, { models, registry, env: chatEnvs(dir) }, ctx);
    try {
      const chat = await store.createChat("c1", { agent: { model: { provider: faux.provider.id, modelId: faux.getModel().id }, cwd: dir } }, ctx);
      // 3,000 lines, past bash's 2,000; printed by node, which every platform's shell finds by its full path.
      const command = `"${process.execPath.replaceAll("\\", "/")}" -e "process.stdout.write('a line of output\\n'.repeat(3000))"`;
      faux.setResponses([fauxAssistantMessage(fauxToolCall("bash", { command }), { stopReason: "toolUse" }), fauxAssistantMessage("done")]);
      await (await chat.submit({ type: "input", content: "print a lot" }, ctx)).wait(ctx);
      const [result] = (await store.entries(chat, ctx)).filter((e) => e.kind === "pi.tool-result").map((e) => JSON.stringify(e.model?.[0]));
      const folder = join(dir, "tool-results", "c1");
      const files = readdirSync(folder);
      expect(files).toHaveLength(1);
      expect(readFileSync(join(folder, files[0]), "utf8")).toBe("a line of output\n".repeat(3000));
      // In JSON a Windows path's backslashes are doubled, so the result is searched for the file's name.
      expect(result).toContain("Full output:");
      expect(result).toContain(files[0]);
    } finally {
      await store.close(ctx);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

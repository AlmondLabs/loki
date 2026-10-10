/**
 * Plan 017, U1: does every real Letta conversation convert into pi-durable and continue? Reads Letta's local backend
 * read-only, imports each conversation of the person's own agents (those with a memory folder) into a throwaway
 * in-memory store, checks that it folds into the same rows the mod shows today, and sends one message with a faux
 * model to prove the history becomes a valid request. Nothing is written anywhere.
 *
 *   bun scripts/pi-import-check.ts [backend dir]
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, MemoryStorage } from "@earendil-works/pi-durable";
import { AgentStore } from "../daemon/kernel/index.ts";
import { lettaLogEntries } from "../daemon/import/convert.ts";
import { entrySteps } from "../core/attention/pi-steps.ts";
import { foldSteps } from "../core/attention/thread.ts";
import { readLocalTranscriptPage } from "../daemon/import/letta-log.ts";

const backend = process.argv[2] ?? join(homedir(), ".letta", "lc-local-backend");
const ctx = BACKGROUND_CONTEXT;
const agents = new Set(readdirSync(join(backend, "memfs")));

let checked = 0;
let continued = 0;
const failures: string[] = [];
const started = performance.now();

for (const dir of readdirSync(join(backend, "conversations"))) {
  const base = join(backend, "conversations", dir);
  const logFile = join(base, "messages.jsonl");
  if (!existsSync(logFile) || !existsSync(join(base, "conversation.json"))) continue;
  const record = JSON.parse(readFileSync(join(base, "conversation.json"), "utf8")) as { id: string; agent_id: string };
  if (!agents.has(record.agent_id)) continue;

  const text = readFileSync(logFile, "utf8");
  const converted = lettaLogEntries(text);
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const model = { provider: faux.provider.id, modelId: faux.getModel().id };
  const store = await AgentStore.open({ storage: new MemoryStorage() }, { models, registry: createRegistry() }, ctx);
  try {
    const chat = await store.createChat(record.id, { agent: { model } }, ctx);
    await store.importEntries(chat, converted, ctx);
    const imported = foldSteps((await store.entries(chat, ctx)).flatMap(entrySteps));
    const today = readLocalTranscriptPage(record.id, record.agent_id, Number.MAX_SAFE_INTEGER, backend).rows;
    // A branch Letta left behind is not imported, so a log with one may show fewer rows; same rows otherwise.
    if (JSON.stringify(imported) !== JSON.stringify(today)) {
      const at = imported.findIndex((row, i) => JSON.stringify(row) !== JSON.stringify(today[i]));
      if (process.env.SHOW_DIFF) console.log(record.id, "\n  imported:", JSON.stringify(imported[at]).slice(0, 400), "\n  today:   ", JSON.stringify(today[at]).slice(0, 400));
      const branched = text.split("\n").filter(Boolean).length - 1 > converted.length + text.split('"type":"compaction"').length - 1;
      failures.push(`${record.id}: ${imported.length} rows imported, ${today.length} today${branched ? " (log has a branch)" : ""}`);
    }
    checked++;
    if (converted.length > 0) {
      // A long chat may compact before it answers: the summary takes a reply too.
      faux.setResponses([fauxAssistantMessage("summary"), fauxAssistantMessage("ok"), fauxAssistantMessage("ok")]);
      const settled = await (await chat.submit({ type: "input", content: "continue", requestId: "check" }, ctx)).wait(ctx);
      if (settled.status === "done") continued++;
      else failures.push(`${record.id}: did not continue (${JSON.stringify(settled).slice(0, 200)})`);
    }
  } catch (error) {
    failures.push(`${record.id}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await store.close(ctx);
  }
}

console.log(`checked ${checked} conversations, ${continued} continued, in ${Math.round(performance.now() - started)} ms`);
for (const f of failures) console.log(`  ${f}`);
process.exit(failures.length ? 1 : 0);

/**
 * Plan 017, R5: a turn cut off by a crash continues after a restart. Runs under Node (pi-durable's SQLite backend is
 * `node:sqlite`): bun run test:node
 */
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { AgentStore } from "../daemon/kernel/index.ts";
import { entrySteps } from "../core/attention/pi-steps.ts";
import { foldSteps } from "../core/attention/thread.ts";
import { trialRegistry } from "./trial-registry.ts";

const ctx = BACKGROUND_CONTEXT;
const here = import.meta.dirname;

/** Run the crash child until it says the turn is under way, then SIGKILL it. */
function crashMidTurn(file: string, phase: "generation" | "tool"): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", join(here, "crash-child.ts"), file, phase], { stdio: ["ignore", "pipe", "inherit"], env: { ...process.env, LOKI_CRASH_SIGNAL: "1" } });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("the child never got under way"));
    }, 20_000);
    child.stdout.on("data", (chunk: Buffer) => {
      if (!chunk.toString().includes("under-way")) return;
      clearTimeout(timer);
      child.kill("SIGKILL");
    });
    child.on("exit", () => resolve());
  });
}

/** Reopen the store as a restarted daemon would, with the model answering this time. */
async function reopen(file: string, answer: string) {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage(answer)]);
  const store = await AgentStore.open({ file }, { models, registry: trialRegistry() }, ctx);
  store.harness.resume();
  return store;
}

test("a turn killed while the model streams finishes after the store is reopened, the cut-off part kept as aborted", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loki-resume-"));
  try {
    const file = join(dir, "store.sqlite");
    await crashMidTurn(file, "generation");
    const store = await reopen(file, "finished after the restart");
    const chat = await store.chat("c", ctx);
    assert.ok(chat);
    await chat.waitForIdle(ctx);
    const assistants = (await store.entries(chat, ctx))
      .filter((e) => e.kind === "pi.assistant")
      .map((e) => e.model?.[0] as { stopReason?: string; content?: Array<{ text?: string }> });
    // What streamed before the crash stays, as an aborted answer; the retried answer follows it.
    assert.equal(assistants.length, 2);
    assert.equal(assistants[0].stopReason, "aborted");
    assert.match(assistants[0].content?.[0]?.text ?? "", /^a long answer/);
    assert.equal(assistants[1].stopReason, "stop");
    assert.equal(assistants[1].content?.[0]?.text, "finished after the restart");
    await store.close(ctx);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a tool that is not replay-safe, killed mid-call, is reported to the model as interrupted instead of run again", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loki-resume-"));
  try {
    const file = join(dir, "store.sqlite");
    await crashMidTurn(file, "tool");
    const store = await reopen(file, "the wait was interrupted");
    const chat = await store.chat("c", ctx);
    assert.ok(chat);
    await chat.waitForIdle(ctx);
    const entries = await store.entries(chat, ctx);
    const result = entries.find((e) => e.kind === "pi.tool-result");
    assert.ok(result, "a tool result was written");
    assert.match(JSON.stringify(result.model), /interrupted/i);
    assert.equal(foldSteps(entries.flatMap(entrySteps)).at(-1)?.text, "the wait was interrupted");
    await store.close(ctx);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

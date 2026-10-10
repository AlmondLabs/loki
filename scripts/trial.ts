/**
 * Plan 017, U2: the timed trial. The prompts run on the daemon's kernel (in a throwaway store) with one model on
 * OpenRouter, and every turn is measured from what the store saved (daemon/timing.ts). Writes the raw results as JSON
 * and prints the medians; Letta's numbers from the original trial are in docs/research/2026-10-pi-trial.md.
 *
 *   OPENROUTER_API_KEY=… node --experimental-strip-types --no-warnings scripts/trial.ts --model <model> [--instructions file] [--runs 5] [--out file]
 *
 * The model is an OpenRouter id (e.g. anthropic/claude-haiku-5.5). `--instructions` is a system prompt to run with
 * (an agent's own, to compare like with like); without it, a one-line one.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { parseArgs } from "node:util";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { createRegistry, MemoryStorage } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { AgentStore } from "../daemon/kernel/index.ts";
import { median, turnTimings, type Span, type TurnTimings } from "../daemon/timing.ts";

const { values: args } = parseArgs({
  options: {
    instructions: { type: "string" },
    model: { type: "string", default: "anthropic/claude-haiku-5.5" },
    runs: { type: "string", default: "5" },
    out: { type: "string" },
  },
});
if (!process.env.OPENROUTER_API_KEY) throw new Error("set OPENROUTER_API_KEY");
const MODEL = args.model!;
const RUNS = Number(args.runs);
const ctx = BACKGROUND_CONTEXT;

// ---- the prompts -------------------------------------------------------------------------------------------------

const LONG_DOC = Array.from({ length: 1400 }, (_, i) => `Line ${i + 1}: the quick brown fox ${i % 7 === 0 ? "naps" : "jumps"} over the lazy dog.`).join("\n");

type Prompt = { name: string; text: string };
const PROMPTS: Prompt[] = [
  { name: "plain", text: "In one sentence, what is a monad? Do not use any tools." },
  {
    name: "dependent-tools",
    text: "Using the shell, run these three commands one after another, each as its own tool call, waiting for each before the next: `printf alpha > notes.txt`, then `printf ' beta' >> notes.txt`, then `cat notes.txt`. Then tell me what the file contains.",
  },
  { name: "parallel-reads", text: "Read the files a.txt, b.txt and c.txt in this folder (in parallel if you can) and tell me the three words they contain." },
  { name: "long-context", text: `Here is a document.\n\n${LONG_DOC}\n\nHow many lines say the fox naps? Answer with the number only, no tools.` },
];

/** A fresh working folder per turn, with the files the prompts read. */
function workDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "loki-trial-"));
  writeFileSync(join(dir, "a.txt"), "apple\n");
  writeFileSync(join(dir, "b.txt"), "banana\n");
  writeFileSync(join(dir, "c.txt"), "cherry\n");
  return dir;
}

// ---- shared ------------------------------------------------------------------------------------------------------

type Result = { backend: "daemon"; prompt: string; run: number; ok: boolean; error?: string; timings?: TurnTimings };

/** Spans from pi-ai messages as the store saved them: start, end, and whether it is a model response or a tool. */
type Saved = { role: string; start: number; end: number };

function spansOf(saved: Saved[]): { models: Span[]; tools: Span[] } {
  return {
    models: saved.filter((s) => s.role === "assistant").map(({ start, end }) => ({ start, end })),
    tools: saved.filter((s) => s.role === "toolResult").map(({ start, end }) => ({ start, end })),
  };
}

// ---- the daemon --------------------------------------------------------------------------------------------------

async function daemonStore() {
  const models = createModels();
  models.setProvider(openrouterProvider());
  const registry = createRegistry();
  registry.install(CodingTools);
  return AgentStore.open(
    { storage: new MemoryStorage() },
    { models, registry, env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? process.cwd() }) },
    ctx,
  );
}

let chatSeq = 0;
async function daemonTurn(store: AgentStore, instructions: string, prompt: Prompt): Promise<TurnTimings> {
  const cwd = workDir();
  const chat = await store.createChat(`trial-${chatSeq++}`, { agent: { model: { provider: "openrouter", modelId: MODEL }, instructions, cwd } }, ctx);
  const view = await chat.viewState(ctx);
  let firstOutputAt: number | null = null;
  view.subscribe((value) => {
    if (firstOutputAt !== null) return;
    const live = value.docs["pi.live"] as { generation?: { message?: { content?: Array<{ type?: string; text?: string }> } }; tools?: unknown[] } | undefined;
    const content = live?.generation?.message?.content ?? [];
    // A short answer can arrive whole, with no partial committed first: its entry is then the first output.
    const answered = value.entries.some((e) => e.kind === "pi.assistant");
    if (answered || content.some((p) => (p.type === "text" && p.text) || p.type === "thinking" || p.type === "toolCall") || (live?.tools?.length ?? 0) > 0) firstOutputAt = Date.now();
  });
  const before = (await store.entries(chat, ctx)).length;
  const sentAt = Date.now();
  const submission = await chat.submit({ type: "input", content: prompt.text }, ctx);
  const settled = await submission.wait(ctx);
  const endAt = Date.now();
  view.dispose();
  if (settled.status !== "done") throw new Error(`turn ${settled.status}: ${JSON.stringify(settled).slice(0, 300)}`);
  const saved: Saved[] = [];
  for (const entry of (await store.entries(chat, ctx)).slice(before)) {
    const m = entry.model?.[0] as { role?: string; timestamp?: number; durationMs?: number } | undefined;
    if (!m?.role || typeof m.timestamp !== "number") continue;
    // pi-ai stamps a response when its request starts and records how long it took; a tool result carries its end
    // and its duration.
    if (m.role === "assistant") saved.push({ role: "assistant", start: m.timestamp, end: m.timestamp + (m.durationMs ?? 0) });
    else if (m.role === "toolResult") saved.push({ role: "toolResult", start: m.timestamp - (m.durationMs ?? 0), end: m.timestamp });
  }
  rmSync(cwd, { recursive: true, force: true });
  return turnTimings({ sentAt, firstOutputAt, ...spansOf(saved), endAt });
}

// ---- run ---------------------------------------------------------------------------------------------------------

const results: Result[] = [];
const instructions = args.instructions ? readFileSync(args.instructions, "utf8") : "You are a helpful coding agent. Be brief.";
const backends = ["daemon"];

let eventLoopP99Ms: number | null = null;
{
  const store = await daemonStore();
  try {
    for (let run = 0; run < RUNS; run++) {
      for (const prompt of PROMPTS) {
        try {
          results.push({ backend: "daemon", prompt: prompt.name, run, ok: true, timings: await daemonTurn(store, instructions, prompt) });
        } catch (error) {
          results.push({ backend: "daemon", prompt: prompt.name, run, ok: false, error: String(error) });
        }
        console.error(`daemon ${prompt.name} #${run}: ${JSON.stringify(results.at(-1)?.timings ?? results.at(-1)?.error)}`);
      }
    }
    const histogram = monitorEventLoopDelay({ resolution: 5 });
    histogram.enable();
    const concurrent = await Promise.allSettled([0, 1, 2].map(() => daemonTurn(store, instructions, PROMPTS[0])));
    histogram.disable();
    eventLoopP99Ms = histogram.percentile(99) / 1e6;
    for (const r of concurrent) {
      results.push(r.status === "fulfilled" ? { backend: "daemon", prompt: "concurrent", run: 0, ok: true, timings: r.value } : { backend: "daemon", prompt: "concurrent", run: 0, ok: false, error: String(r.reason) });
    }
  } finally {
    await store.close(ctx);
  }
}

// ---- report ------------------------------------------------------------------------------------------------------

type Summary = Record<string, number | null>;
function summarise(backend: string, prompt?: string): Summary {
  const ok = results.filter((r) => r.backend === backend && r.ok && (!prompt || r.prompt === prompt)).map((r) => r.timings!);
  return {
    turns: ok.length,
    ttftMs: median(ok.flatMap((t) => (t.ttftMs === null ? [] : [t.ttftMs]))),
    overheadMs: median(ok.map((t) => t.overheadMs)),
    afterToolMs: median(ok.flatMap((t) => t.afterToolMs)),
    beforeFirstRequestMs: median(ok.flatMap((t) => (t.beforeFirstRequestMs === null ? [] : [t.beforeFirstRequestMs]))),
    totalMs: median(ok.map((t) => t.totalMs)),
    modelMs: median(ok.map((t) => t.modelMs)),
  };
}

const report = {
  model: MODEL,
  runs: RUNS,
  at: new Date().toISOString(),
  eventLoopP99Ms,
  failures: results.filter((r) => !r.ok).map((r) => `${r.backend} ${r.prompt} #${r.run}: ${r.error}`),
  overall: Object.fromEntries(backends.map((b) => [b, summarise(b)])),
  byPrompt: Object.fromEntries(backends.map((b) => [b, Object.fromEntries([...PROMPTS.map((p) => p.name), "concurrent"].map((p) => [p, summarise(b, p)]))])),
  results,
};
const out = args.out ?? join(tmpdir(), `loki-trial-${Date.now()}.json`);
mkdirSync(join(out, ".."), { recursive: true });
writeFileSync(out, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ out, eventLoopP99Ms, failures: report.failures, overall: report.overall }, null, 2));

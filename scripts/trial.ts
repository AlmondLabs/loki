/**
 * Plan 017, U2: the timed trial. The same prompts run on Letta (through its app-server, in hidden conversations on
 * one agent, archived afterwards) and on the Pi daemon's kernel (in a throwaway store), with one model on one
 * provider, and every turn is measured the same way from what the backend saved (daemon/timing.ts). Writes the raw
 * results as JSON and prints the medians.
 *
 *   node --experimental-strip-types --no-warnings scripts/trial.ts --agent <agent id> --model <provider/model> [--runs 5] [--out file]
 *
 * The model is an OpenRouter id (e.g. anthropic/claude-haiku-5.5); the key is read from Letta's provider store so both
 * backends use the same one. The daemon is given the agent's own compiled system prompt, so both send the same
 * instructions.
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { parseArgs } from "node:util";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { createRegistry, MemoryStorage } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import WebSocket from "ws";
import { AgentStore } from "../daemon/kernel/index.ts";
import { median, turnTimings, type Span, type TurnTimings } from "../daemon/timing.ts";
import { AppServerSocket, type ServerEvent } from "../core/attention/protocol.ts";
import type { Transport } from "../core/attention/transport.ts";
import { conversationDirName } from "../core/desk-core.ts";

const { values: args } = parseArgs({
  options: {
    agent: { type: "string" },
    model: { type: "string", default: "anthropic/claude-haiku-5.5" },
    runs: { type: "string", default: "5" },
    out: { type: "string" },
    letta: { type: "string", default: "ws://127.0.0.1:41600/ws" },
    only: { type: "string" },
  },
});
if (!args.agent) throw new Error("--agent is required");
const AGENT = args.agent;
const MODEL = args.model!;
const RUNS = Number(args.runs);
const BACKEND = join(homedir(), ".letta", "lc-local-backend");
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

type Result = { backend: "letta" | "daemon"; prompt: string; run: number; ok: boolean; error?: string; timings?: TurnTimings };

/** Spans from pi-ai messages as either backend saved them: start, end, and whether it is a model response or a tool. */
type Saved = { role: string; start: number; end: number };

function spansOf(saved: Saved[]): { models: Span[]; tools: Span[] } {
  return {
    models: saved.filter((s) => s.role === "assistant").map(({ start, end }) => ({ start, end })),
    tools: saved.filter((s) => s.role === "toolResult").map(({ start, end }) => ({ start, end })),
  };
}

function openrouterKey(): string {
  const store = JSON.parse(readFileSync(join(BACKEND, "providers", "auth.json"), "utf8")) as { providers: Record<string, { auth?: { key?: string } }> };
  const key = store.providers.openrouter?.auth?.key;
  if (!key) throw new Error("no OpenRouter key in Letta's provider store");
  return key;
}

/** The agent's compiled system prompt, from its newest conversation that has one. */
function agentSystemPrompt(agentId: string): string {
  let best: { at: number; content: string } | null = null;
  for (const dir of readdirSync(join(BACKEND, "conversations"))) {
    const base = join(BACKEND, "conversations", dir);
    if (!existsSync(join(base, "system-prompt.json"))) continue;
    const record = JSON.parse(readFileSync(join(base, "conversation.json"), "utf8")) as { agent_id?: string };
    if (record.agent_id !== agentId) continue;
    const prompt = JSON.parse(readFileSync(join(base, "system-prompt.json"), "utf8")) as { content?: string; compiledAt?: string };
    const at = Date.parse(prompt.compiledAt ?? "") || 0;
    if (prompt.content && (!best || at > best.at)) best = { at, content: prompt.content };
  }
  if (!best) throw new Error(`no compiled system prompt for ${agentId}`);
  return best.content;
}

/** Stream events that carry the model's output: its words, its thinking, or a tool call. */
const OUTPUT_TYPES = new Set(["assistant_message", "reasoning_message", "tool_call_message", "approval_request_message"]);

// ---- Letta -------------------------------------------------------------------------------------------------------

function wsTransport(url: string): Transport {
  const token = readFileSync(join(homedir(), ".letta", "loki", "token"), "utf8").trim();
  let ws: WebSocket | null = null;
  return {
    open(h) {
      ws = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } });
      ws.on("open", h.onOpen);
      ws.on("message", (d) => h.onMessage(String(d)));
      ws.on("close", h.onClose);
      ws.on("error", (e) => h.onError(e instanceof Error ? e : new Error(String(e))));
    },
    send(raw) {
      ws?.send(raw);
    },
    close() {
      ws?.close();
    },
  };
}

/**
 * When each of Letta's model requests started, from its log: Letta stamps an assistant message when its request
 * starts. The line itself is written at the first token, so the end of a response comes from the stream instead.
 */
function lettaRequestStarts(conversationId: string, agentId: string): number[] {
  const file = join(BACKEND, "conversations", conversationDirName(conversationId, agentId), "messages.jsonl");
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { type?: string; message?: { role?: string; timestamp?: number } })
    .flatMap((l) => (l.type === "message" && l.message?.role === "assistant" && typeof l.message.timestamp === "number" ? [l.message.timestamp] : []));
}

async function lettaTurn(sock: AppServerSocket, handle: string, prompt: Prompt): Promise<{ timings: TurnTimings; conversationId: string }> {
  const cwd = workDir();
  const rt = await sock.createConversation(AGENT, cwd, `trial ${prompt.name}`);
  await sock.updateConversation(rt.conversation_id, { hidden: true });
  await sock.updateModel(rt, handle);
  let firstOutputAt: number | null = null;
  let endAt = 0;
  let turns = 0;
  const responseEnds: number[] = [];
  const toolStarts: number[] = [];
  const toolEnds: number[] = [];
  const sentAtRef = { at: 0 };
  const done = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out")), 300_000);
    const off = sock.on((ev: ServerEvent) => {
      if (ev.runtime && ev.runtime.conversation_id !== rt.conversation_id) return;
      const delta = ev.delta as { message_type?: string } | undefined;
      if (process.env.TRIAL_TRACE) console.error(`  +${Date.now() - sentAtRef.at} ${ev.type} ${delta?.message_type ?? ""}`);
      const now = Date.now();
      if (firstOutputAt === null && ev.type === "stream_delta" && OUTPUT_TYPES.has(delta?.message_type ?? "")) firstOutputAt = now;
      if (ev.type === "stream_delta") turns++;
      if (delta?.message_type === "stop_reason") responseEnds.push(now);
      if (delta?.message_type === "client_tool_start") toolStarts.push(now);
      if (delta?.message_type === "client_tool_end") toolEnds.push(now);
      const status = (ev.loop_status as { status?: string } | undefined)?.status;
      if (ev.type === "turn_finished" || (ev.type === "update_loop_status" && status === "WAITING_ON_INPUT" && turns > 0)) {
        endAt = now;
        clearTimeout(timer);
        off();
        resolve();
      }
    });
  });
  const sentAt = Date.now();
  sentAtRef.at = sentAt;
  if (!(await sock.sendUserMessage(rt, prompt.text))) throw new Error("Letta did not accept the prompt");
  await done;
  await new Promise((r) => setTimeout(r, 300)); // the last line reaches the log just after the turn ends
  const starts = lettaRequestStarts(rt.conversation_id, AGENT);
  const models = starts.flatMap((start, i) => (responseEnds[i] === undefined ? [] : [{ start, end: responseEnds[i] }]));
  const tools = toolStarts.flatMap((start, i) => (toolEnds[i] === undefined ? [] : [{ start, end: toolEnds[i] }]));
  const timings = turnTimings({ sentAt, firstOutputAt, models, tools, endAt });
  rmSync(cwd, { recursive: true, force: true });
  return { timings, conversationId: rt.conversation_id };
}

// ---- the daemon --------------------------------------------------------------------------------------------------

async function daemonStore() {
  process.env.OPENROUTER_API_KEY = openrouterKey();
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
const instructions = agentSystemPrompt(AGENT);
const backends = (args.only ?? "letta,daemon").split(",");

if (backends.includes("letta")) {
  const sock = new AppServerSocket(args.letta!, wsTransport);
  await sock.connect();
  const models = await sock.listModels();
  const entry = models.find((m) => m.handle.includes("openrouter") && m.handle.endsWith(MODEL)) ?? models.find((m) => m.handle.endsWith(MODEL));
  if (!entry) throw new Error(`Letta lists no model ending in ${MODEL}: ${models.map((m) => m.handle).slice(0, 20).join(", ")}`);
  const created: string[] = [];
  try {
    for (let run = 0; run < RUNS; run++) {
      for (const prompt of PROMPTS) {
        try {
          const { timings, conversationId } = await lettaTurn(sock, entry.handle, prompt);
          created.push(conversationId);
          results.push({ backend: "letta", prompt: prompt.name, run, ok: true, timings });
        } catch (error) {
          results.push({ backend: "letta", prompt: prompt.name, run, ok: false, error: String(error) });
        }
        console.error(`letta ${prompt.name} #${run}: ${JSON.stringify(results.at(-1)?.timings ?? results.at(-1)?.error)}`);
      }
    }
    const concurrent = await Promise.allSettled([0, 1, 2].map(() => lettaTurn(sock, entry.handle, PROMPTS[0])));
    for (const r of concurrent) {
      if (r.status === "fulfilled") created.push(r.value.conversationId);
      results.push(r.status === "fulfilled" ? { backend: "letta", prompt: "concurrent", run: 0, ok: true, timings: r.value.timings } : { backend: "letta", prompt: "concurrent", run: 0, ok: false, error: String(r.reason) });
    }
  } finally {
    for (const id of created) await sock.updateConversation(id, { archived: true }).catch(() => {});
    sock.close();
  }
}

let eventLoopP99Ms: number | null = null;
if (backends.includes("daemon")) {
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
  agent: AGENT,
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

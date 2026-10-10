import type { Context } from "@earendil-works/chord";
import type { Registry } from "@earendil-works/pi-durable";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ReflectionSettings } from "../core/attention/protocol.ts";
import { readLocalAgent } from "../mod/agents.ts";
import { formatTranscript } from "../mod/recall-worker.ts";
import type { ChatProjection } from "./chats.ts";
import type { StoreManager } from "./kernel/stores.ts";
import { isReflectionChat, MEMORY_TOOLS } from "./memory.ts";
import { isWriterChat } from "../core/recall/model.ts";
import { modelRef } from "./chat-backend.ts";

/**
 * Reflection (plan 017, U9, KTD11): a background pass that reads what happened in a chat since its last pass and
 * updates the agent's memory, never while the chat is busy. It runs once a chat has been quiet for a while, when the
 * settings' trigger says so: after `stepCount` answers since the last pass, or after the chat's context is compacted.
 * The pass is a hidden chat of the same agent (`reflection-<chat>`), offered only the memory tools, whose commits are
 * Reflection's (daemon/memory.ts). Each chat's counters are kept in the state file Letta kept, under the daemon's own
 * transcript root, so the Agents page reads them as it did (mod/reflection.ts).
 */

const DEFAULTS: ReflectionSettings = { trigger: "step-count", stepCount: 25, merge: "auto", mergeInstructions: "" };
export const QUIET_MS = 10 * 60_000;

const INSTRUCTIONS = `You are this agent's reflection. You read a stretch of one of its conversations and keep its memory true and useful: record what it learned about the person, their work and preferences, decisions made, and anything it should do differently next time. Change memory only with the memory tools; edit what is there before adding new files, keep files short and specific, and leave alone what the conversation did not touch. When nothing is worth keeping, change nothing and say so in one line.`;

type State = {
  steps_since_last_successful_reflection: number;
  total_completed_steps: number;
  last_reflection_started_at?: string;
  last_reflection_succeeded_at?: string;
  /** Position in the chat (entries) the last successful pass read up to. */
  reflected_through?: number;
};

type Deps = {
  stores: StoreManager;
  chats: ChatProjection;
  registry: Registry;
  backendDir: string;
  /** Where each chat's reflection counters are kept (LOKI_REFLECTION_DIR for mod/reflection.ts). */
  root: string;
  /** Where the settings are kept. */
  settingsFile: string;
  context: Context;
  quietMs?: number;
  report?: (message: string) => void;
};

export class Reflection {
  private readonly deps: Deps;
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly running = new Set<string>();

  constructor(deps: Deps) {
    this.deps = deps;
    deps.chats.onEntry((agentId, chatId, kind) => {
      if (isReflectionChat(chatId) || isWriterChat(chatId)) return;
      if (kind === "compaction" && this.settings().trigger === "compaction-event") this.later(agentId, chatId, true);
      else if (kind === "answer") this.later(agentId, chatId, false);
    });
  }

  settings(): ReflectionSettings {
    try {
      return { ...DEFAULTS, ...(JSON.parse(readFileSync(this.deps.settingsFile, "utf8")) as Partial<ReflectionSettings>) };
    } catch {
      return DEFAULTS;
    }
  }

  setSettings(s: ReflectionSettings): ReflectionSettings {
    mkdirSync(dirname(this.deps.settingsFile), { recursive: true });
    writeFileSync(`${this.deps.settingsFile}.tmp`, JSON.stringify(s, null, 2));
    renameSync(`${this.deps.settingsFile}.tmp`, this.deps.settingsFile);
    return this.settings();
  }

  private stateFile(agentId: string, chatId: string): string {
    return join(this.deps.root, agentId, chatId, "state.json");
  }

  private state(agentId: string, chatId: string): State {
    try {
      return JSON.parse(readFileSync(this.stateFile(agentId, chatId), "utf8")) as State;
    } catch {
      return { steps_since_last_successful_reflection: 0, total_completed_steps: 0 };
    }
  }

  private saveState(agentId: string, chatId: string, state: State): void {
    const file = this.stateFile(agentId, chatId);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(`${file}.tmp`, JSON.stringify(state, null, 2));
    renameSync(`${file}.tmp`, file);
  }

  /**
   * A chat's history up to `entries` is already reflected on (an imported chat: Letta's reflection read it), so a
   * pass starts after it, and only answers given since count toward the trigger.
   */
  markReflected(agentId: string, chatId: string, entries: number): void {
    const state = this.state(agentId, chatId);
    this.saveState(agentId, chatId, { ...state, reflected_through: Math.max(state.reflected_through ?? 0, entries), steps_since_last_successful_reflection: 0 });
  }

  /** Wait for the chat to go quiet (each new answer starts the wait again), then count and maybe reflect. */
  private later(agentId: string, chatId: string, force: boolean): void {
    const key = `${agentId}\u0000${chatId}`;
    clearTimeout(this.timers.get(key));
    const timer = setTimeout(() => {
      this.timers.delete(key);
      // A pass that fails is reported by run(); it must never take the daemon down.
      this.quiet(agentId, chatId, force).catch((error: unknown) => this.deps.report?.(`reflection on ${chatId} stopped: ${String(error)}`));
    }, this.deps.quietMs ?? QUIET_MS);
    timer.unref?.();
    this.timers.set(key, timer);
  }

  /** The chat went quiet: bring its counters up to date, and reflect when the trigger is met. */
  private async quiet(agentId: string, chatId: string, force: boolean): Promise<void> {
    const state = this.state(agentId, chatId);
    const counts = this.deps.chats.answers(chatId, agentId, state.reflected_through ?? 0);
    const all = this.deps.chats.answers(chatId, agentId, 0);
    this.saveState(agentId, chatId, { ...state, steps_since_last_successful_reflection: counts.since, total_completed_steps: all.since });
    const s = this.settings();
    if (s.trigger === "off") return;
    if (force || (s.trigger === "step-count" && counts.since >= s.stepCount)) await this.run(agentId, chatId);
  }

  /** Reflect on a chat now (also `/reflect`): what it said since the last pass, read by the reflection chat. */
  async run(agentId: string, chatId: string): Promise<"reflected" | "nothing new" | "already running"> {
    const key = `${agentId}\u0000${chatId}`;
    if (this.running.has(key)) return "already running";
    this.running.add(key);
    try {
      const state = this.state(agentId, chatId);
      const from = state.reflected_through ?? 0;
      const { rows, lines } = this.deps.chats.since(chatId, agentId, from);
      if (!rows.length) return "nothing new";
      this.saveState(agentId, chatId, { ...state, last_reflection_started_at: new Date().toISOString() });
      const agentName = readLocalAgent(agentId, this.deps.backendDir)?.name ?? null;
      const store = await this.deps.stores.get(agentId);
      const id = `reflection-${chatId}`;
      const tools = this.deps.registry.snapshot().tools().filter((t) => MEMORY_TOOLS.includes(t.tool.name)).map((t) => t.tool);
      const model = modelRef(readLocalAgent(agentId, this.deps.backendDir)?.model ?? "");
      const agent = { tools, instructions: INSTRUCTIONS, ...(model ? { model } : {}) };
      let chat = await store.chat(id, this.deps.context);
      if (!chat) chat = await store.createChat(id, { title: `reflection on ${chatId}`, hidden: true, agent }, this.deps.context);
      else {
        await chat.configure(agent, this.deps.context);
        await chat.reset(undefined, this.deps.context);
      }
      const text = `Here is what happened in the conversation since you last reflected on it.\n\n${formatTranscript(rows, agentName)}`;
      const settled = await (await chat.submit({ type: "input", content: text, requestId: `reflect:${chatId}:${lines}` }, this.deps.context)).wait(this.deps.context);
      if (settled.status !== "done") throw new Error(`the pass did not finish: ${settled.status}`);
      const after = this.state(agentId, chatId);
      this.saveState(agentId, chatId, { ...after, reflected_through: lines, steps_since_last_successful_reflection: 0, last_reflection_succeeded_at: new Date().toISOString() });
      return "reflected";
    } catch (error) {
      this.deps.report?.(`reflection on ${chatId} failed: ${String(error)}`);
      throw error;
    } finally {
      this.running.delete(key);
    }
  }
}

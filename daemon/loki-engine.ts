import type { Context } from "@earendil-works/chord";
import type { Models } from "@earendil-works/pi-ai/models";
import { LiveDoc, watchEvents, type AgentEventStream, type Conversation } from "@earendil-works/pi-durable";
import { existsSync } from "node:fs";
import type { ChatEvent } from "../core/attention/model.ts";
import type { ImageNamer } from "../core/attention/pi-steps.ts";
import type { ChatState, PayloadOf } from "../core/frames.ts";
import type { ReasoningEffort } from "../core/models.ts";
import { readLocalAgent } from "../mod/agents.ts";
import { isPermissionMode, modeOf, type Approvals } from "./approvals.ts";
import { ChatEventConverter } from "./chat-events.ts";
import type { Delivery, Engine, EngineChat } from "./engine.ts";
import type { AgentStore } from "./kernel/index.ts";
import type { McpTools } from "./mcp/index.ts";
import type { ModRegistry } from "./mods/registry.ts";
import { turnIdOf } from "./telemetry.ts";

/** A model handle (`provider/model`) as pi-durable's model reference. */
export function modelRef(handle: string): { provider: string; modelId: string } | undefined {
  const slash = handle.indexOf("/");
  return slash > 0 && slash < handle.length - 1 ? { provider: handle.slice(0, slash), modelId: handle.slice(slash + 1) } : undefined;
}

/** loki's reasoning effort as pi's thinking level. */
function thinkingLevel(effort: ReasoningEffort | null): string | undefined {
  if (!effort) return undefined;
  return effort === "none" ? "off" : effort;
}

const keyOf = (agentId: string, conversationId: string) => `${agentId}\u0000${conversationId}`;

/**
 * loki's own engine (glossary: Engine): a chat in its agent's pi-durable store, run by pi-durable on one of loki's
 * models (plan 017). A chat a client opens, or a message goes into, is followed through pi-durable's event stream,
 * converted to loki's chat events and pushed to every client, so a client that opened it before the daemon restarted
 * still hears the answer. The person's message passes through every mod's transform before it is sent (loki's own adds
 * what you did on the canvas); one sent while the chat is busy waits its turn, or with `steer` joins it.
 */
export class LokiEngine implements Engine {
  private readonly deps: {
    approvals: Approvals;
    /** MCP (daemon/mcp/): each chat's filter is set before it runs, and emptied by /clear and a compaction. */
    mcp?: McpTools;
    mods: ModRegistry;
    models: Models;
    backendDir: string;
    context: Context;
    push: (agentId: string, conversationId: string, events: ChatEvent[]) => void;
    /** Keeps the person's pictures as files a window loads (plan 029). */
    nameImage?: ImageNamer;
  };
  private readonly following = new Map<string, Promise<AgentEventStream>>();
  /** Each followed chat's event converter, which knows the answer in flight (open hands it to a late client). */
  private readonly converters = new Map<string, ChatEventConverter>();

  constructor(deps: LokiEngine["deps"]) {
    this.deps = deps;
  }

  /** The agent's store reopened after a failure, with new conversations: what followed the old ones follows again on open. */
  forgetAgent(agentId: string): void {
    for (const key of [...this.following.keys()]) if (key.startsWith(`${agentId}\u0000`)) this.following.delete(key);
  }

  async open(c: EngineChat, mode: string | null): Promise<ChatState> {
    if (mode !== null) {
      if (!isPermissionMode(mode)) throw new Error(`not a permission mode: ${mode}`);
      await c.store.updateChat(c.conversationId, { mode }, this.deps.context);
    }
    await this.watch(c);
    return this.state(c);
  }

  async busy(c: EngineChat): Promise<boolean> {
    if (this.deps.approvals.waitingIn(c.agentId, c.conversationId).length > 0) return true;
    return Boolean((await c.store.harness.snapshot(LiveDoc, c.chat.id, this.deps.context))?.run);
  }

  async send(c: EngineChat, p: PayloadOf<"chat_send">): Promise<void> {
    await this.ready(c);
    const images = p.images.map((i) => ({ type: "image" as const, data: i.data, mimeType: i.media_type }));
    const moved = await this.movedNote(c.store, c.chat);
    const parts = [
      ...(moved ? [{ type: "text" as const, text: moved }] : []),
      ...(p.context ? [{ type: "text" as const, text: p.context }] : []),
      ...(p.text.trim() ? [{ type: "text" as const, text: p.text }] : []),
      ...images,
    ];
    const agentName = readLocalAgent(p.agent_id, this.deps.backendDir)?.name ?? "";
    const content = this.deps.mods.transformMessage({
      chatId: p.conversation_id,
      agentId: p.agent_id,
      agentName,
      content: parts.length === 1 && parts[0].type === "text" ? parts[0].text : parts,
      typed: p.text.trim() !== "",
    });
    // Sent during a turn on purpose: placed after the current tool round, inside the turn (pi-durable's steer).
    const whenBusy = p.steer ? { whenBusy: "steer" as const } : {};
    await c.chat.submit({ type: "input", content: content as never, ...whenBusy, ...(p.send_id ? { requestId: p.send_id } : {}) }, this.deps.context);
  }

  async deliver(c: EngineChat, text: string, whenBusy: "steer" | "followUp"): Promise<Delivery> {
    await this.ready(c);
    const submission = await c.chat.submit({ type: "input", content: text, whenBusy }, this.deps.context);
    return {
      outcome: submission
        .wait(this.deps.context)
        .then((s) => (s.status === "done" ? { status: "done" as const } : { status: "unanswered" as const, reason: s.reason })),
    };
  }

  async abort(c: EngineChat): Promise<void> {
    await c.chat.abort(this.deps.context);
  }

  async folder(c: EngineChat, cwd: string): Promise<ChatState> {
    await c.chat.configure({ cwd }, this.deps.context);
    this.deps.push(c.agentId, c.conversationId, [{ kind: "device", cwd }]);
    return this.state(c);
  }

  async setModel(c: EngineChat, p: PayloadOf<"chat_model">): Promise<void> {
    const model = modelRef(p.handle);
    if (!model) throw new Error(`not a model handle: ${p.handle}`);
    const level = thinkingLevel(p.reasoning_effort);
    await c.chat.configure({ model, ...(level ? { thinkingLevel: level as never } : {}) }, this.deps.context);
  }

  /** The chat moved to an ACP agent: stop following it, or the messages that side writes would show a second time. */
  async leave(c: EngineChat): Promise<void> {
    const key = keyOf(c.agentId, c.conversationId);
    const stream = this.following.get(key);
    this.following.delete(key);
    this.converters.delete(key);
    await (await stream)?.stop();
  }

  /** /compact [instructions], /clear and /remember [what], run in pi-durable. */
  async command(c: EngineChat, p: PayloadOf<"chat_command">): Promise<{ success: boolean; output: string }> {
    switch (p.command) {
      case "compact":
        await c.chat.compact(p.args?.trim() || undefined, this.deps.context);
        return { success: true, output: "summarising the conversation so far" };
      case "clear":
        await c.chat.reset(undefined, this.deps.context);
        await this.deps.mcp?.forget(c.chat, this.deps.context);
        return { success: true, output: "the agent starts this chat afresh; what was said stays in the thread" };
      case "remember": {
        const what = p.args?.trim();
        const text = what
          ? `Please remember this in your memory: ${what}`
          : "Look back over this conversation and save to your memory whatever is worth keeping.";
        await this.deps.mcp?.prepare(c.store, c.chat, this.deps.context);
        await c.chat.submit({ type: "input", content: text }, this.deps.context);
        return { success: true, output: "asked the agent to remember" };
      }
      default:
        return { success: false, output: `/${p.command} is not a command loki's daemon runs` };
    }
  }

  /** Before a message goes in: the chat's MCP tools set, and the chat followed. */
  private async ready(c: EngineChat): Promise<void> {
    await this.deps.mcp?.prepare(c.store, c.chat, this.deps.context);
    await this.watch(c);
  }

  /** Follow a chat, once: from now on its events go to every client. */
  private async watch(c: EngineChat): Promise<void> {
    const key = keyOf(c.agentId, c.conversationId);
    if (!this.following.has(key)) this.following.set(key, this.follow(c));
    await this.following.get(key);
  }

  /** Push every event of a chat from now on. */
  private async follow({ store, chat, agentId, conversationId }: EngineChat): Promise<AgentEventStream> {
    const stream = await watchEvents(store.harness, chat.id, this.deps.context);
    const converter = new ChatEventConverter(agentId, this.deps.nameImage);
    this.converters.set(keyOf(agentId, conversationId), converter);
    stream.start(async (batch) => {
      const events = batch.flatMap((ev) => converter.convert(ev));
      if (events.length) this.deps.push(agentId, conversationId, events);
      // A compaction drops what the chat had loaded from MCP with the rest of its context.
      if (batch.some((ev) => ev.type === "compaction_end")) await this.deps.mcp?.forget(chat, this.deps.context).catch(() => {});
    });
    return stream;
  }

  private async state({ store, chat, agentId, conversationId }: EngineChat): Promise<ChatState> {
    const [view, settings, info] = await Promise.all([
      store.harness.snapshot(LiveDoc, chat.id, this.deps.context),
      store.agentSettings(chat.id, this.deps.context),
      store.chatInfo(chat.id, this.deps.context),
    ]);
    const waiting = this.deps.approvals.waitingIn(agentId, conversationId).length > 0;
    // The answer in flight so far: the client that opens now missed its first pieces (they went out before it listened).
    const streaming = view?.run ? (this.converters.get(keyOf(agentId, conversationId))?.inFlight() ?? null) : null;
    return {
      agent_id: agentId,
      conversation_id: conversationId,
      loop: waiting ? "approval" : view?.run ? "running" : "idle",
      turn_id: view?.run ? turnIdOf(agentId, view.run.inputs) : null,
      mode: modeOf(info?.mode),
      cwd: (settings as { cwd?: string } | undefined)?.cwd ?? null,
      ...(streaming ? { streaming } : {}),
    };
  }

  /**
   * What the agent is told, once, with the first message after its chat moved here (addendum A5): the two Macs, and
   * what did not come along. Cleared as it is read, so it goes with one message only. Null when the chat did not move.
   */
  private async movedNote(store: AgentStore, chat: Conversation): Promise<string | null> {
    const info = await store.chatInfo(chat.id, this.deps.context);
    if (!info?.moved) return null;
    const { from, to, files_left: filesLeft } = info.moved;
    await store.updateChat(info.id, { moved: null }, this.deps.context);
    const cwd = ((await store.agentSettings(chat.id, this.deps.context)) as { cwd?: string } | undefined)?.cwd;
    const lines = [`This chat moved from ${from} to ${to}: you now run on ${to}, with its files, tools and sign-ins.`];
    if (filesLeft > 0) lines.push(`${filesLeft === 1 ? "A file" : `${filesLeft} files`} attached before the move stayed on ${from} and cannot be read here.`);
    if (cwd && !existsSync(cwd)) lines.push(`This chat's folder, ${cwd}, is not on ${to}.`);
    return `<system-reminder>\n${lines.join("\n")}\n</system-reminder>`;
  }
}

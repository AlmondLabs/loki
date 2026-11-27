import { MOVE_OUT_OF_REACH, MOVE_TIMEOUT_MS, type Replies } from "../core/frames.ts";
import { readJson, writeJsonAtomic } from "./json-file.ts";
import type { MovedChat } from "../daemon/chat-move.ts";
import type { ChatBackend } from "./frames/chat.ts";
import type { PeerMoves } from "./frames/peers.ts";
import type { PeerLink } from "./peer-link.ts";
import { log } from "./log.ts";
import { messageOf } from "../core/errors.ts";

export class ChatMoves implements PeerMoves {
  private readonly opts: {
    here: string;
    chat: Pick<ChatBackend, "moveCandidates" | "exportChat" | "importChat" | "finishMove">;
    link: (macId: string) => PeerLink | null;
    name: (macId: string | null) => string | null;
    done: (macId: string) => boolean;
    markDone: (macId: string) => void;
    onMoved: (macId: string) => void;
    onLeft: (chat: { agent_id: string; conversation_id: string }, to: string) => void;
    file?: string;
    now?: () => number;
  };
  private readonly moving: Map<string, Hold>;
  private readonly running = new Set<string>();

  constructor(opts: ChatMoves["opts"]) {
    this.opts = opts;
    this.moving = new Map(opts.file ? readHolds(opts.file) : []);
  }

  blocked(agentId: string, conversationId: string): string | null {
    const hold = this.moving.get(`${agentId}/${conversationId}`);
    if (!hold || hold.kept) return null;
    const name = this.opts.name(hold.to) ?? "another Mac";
    if (this.opts.link(hold.to)) return `this chat is moving to ${name}; it opens there in a moment`;
    return `this chat is moving to ${name}, ${MOVE_OUT_OF_REACH} to use it on this Mac`;
  }

  keepHere(agentId: string, conversationId: string): string | null {
    const key = `${agentId}/${conversationId}`;
    const hold = this.moving.get(key);
    if (!hold || hold.kept) return "this chat is not moving";
    this.hold(key, { ...hold, kept: true });
    log("peers:chat-kept-here", { agent: agentId, chat: conversationId, was_to: hold.to });
    return null;
  }

  async settle(macId: string): Promise<void> {
    const link = this.opts.link(macId);
    if (!link) return;
    await this.settleHolds(macId, link);
  }

  private async settleHolds(macId: string, link: PeerLink): Promise<void> {
    for (const [key, hold] of [...this.moving].filter(([, h]) => h.to === macId)) {
      try {
        // react-doctor-disable-next-line react-doctor/async-await-in-loop
        const where = (await link.request({ type: "peer_where", agent_id: hold.agent_id, conversation_id: hold.conversation_id })) as { held?: boolean };
        if (hold.kept) {
          if (where.held) await link.request({ type: "peer_chat_moved", agent_id: hold.agent_id, conversation_id: hold.conversation_id });
          this.drop(key);
          log("peers:chat-kept-settled", { agent: hold.agent_id, chat: hold.conversation_id, to: macId });
        } else if (where.held) {
          await this.moved(macId, hold.agent_id, hold.conversation_id);
        } else {
          this.drop(key);
          log("peers:chat-move-undone", { agent: hold.agent_id, chat: hold.conversation_id, to: macId });
        }
      } catch (err) {
        log.error("peers:chat-settle-failed", { agent: hold.agent_id, chat: hold.conversation_id, error: messageOf(err) });
      }
    }
  }

  private hold(key: string, hold: Hold): void {
    this.moving.set(key, hold);
    this.save();
  }

  private drop(key: string): void {
    if (this.moving.delete(key)) this.save();
  }

  private save(): void {
    if (this.opts.file) writeJsonAtomic(this.opts.file, { version: 1, holds: [...this.moving.values()] });
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  async takeOver(macId: string, again = false): Promise<void> {
    if ((this.opts.done(macId) && !again) || this.running.has(macId)) return;
    const link = this.opts.link(macId);
    if (!link) return;
    this.running.add(macId);
    try {
      const { chats } = (await link.request({ type: "peer_moves_get" })) as { chats?: Array<{ agent_id: string; conversation_id: string }> };
      let waiting = false;
      let moved = 0;
      for (const c of chats ?? []) {
        const out = await this.pull(macId, link, c.agent_id, c.conversation_id, false);
        if (out === "busy") waiting = true;
        if (out === "moved") moved++;
      }
      if (moved) {
        log("peers:chats-taken", { from: macId, moved, waiting });
        this.opts.onMoved(macId);
      }
      if (!waiting) this.opts.markDone(macId);
    } catch (err) {
      log.error("peers:chat-move-failed", { from: macId, error: messageOf(err) });
    } finally {
      this.running.delete(macId);
    }
  }

  async offer(to: string, agentId: string, conversationId: string): Promise<string | null> {
    if (to === this.opts.here) return null;
    const name = this.opts.name(to);
    if (name === null) return "that Mac is not paired with this one";
    const link = this.opts.link(to);
    if (!link) return `${name} is out of reach: move the chat once it is back`;
    return this.send(to, name, link, agentId, conversationId);
  }

  private async send(to: string, name: string, link: PeerLink, agentId: string, conversationId: string): Promise<string | null> {
    try {
      const out = (await link.request({ type: "peer_chat_take", agent_id: agentId, conversation_id: conversationId }, MOVE_TIMEOUT_MS)) as {
        moved?: boolean;
        busy?: boolean;
      };
      if (out.busy) return "the chat is answering or waiting for you: move it once it is done";
      if (!out.moved) return "the chat is not on this Mac";
      this.opts.onMoved(to);
      return null;
    } catch (err) {
      return `the move to ${name} did not finish: ${messageOf(err)}`;
    }
  }

  candidates(macId: string): Promise<Replies["peer_moves"]["chats"]> {
    return this.opts.chat.moveCandidates(macId);
  }

  async export(macId: string, agentId: string, conversationId: string): Promise<Replies["peer_chat"]> {
    const key = `${agentId}/${conversationId}`;
    const held = this.moving.has(key);
    this.hold(key, { agent_id: agentId, conversation_id: conversationId, to: macId, at: new Date(this.now()).toISOString() });
    let out: Awaited<ReturnType<ChatBackend["exportChat"]>>;
    try {
      out = await this.opts.chat.exportChat(agentId, conversationId);
    } catch (err) {
      if (!held) this.drop(key);
      throw err;
    }
    if (!out.chat) {
      if (!held) this.drop(key);
      return out;
    }
    return out;
  }

  async moved(macId: string, agentId: string, conversationId: string): Promise<void> {
    await this.opts.chat.finishMove(agentId, conversationId);
    this.drop(`${agentId}/${conversationId}`);
    log("peers:chat-moved", { agent: agentId, chat: conversationId, to: macId });
    this.opts.onLeft({ agent_id: agentId, conversation_id: conversationId }, macId);
  }

  async take(macId: string, agentId: string, conversationId: string): Promise<Replies["peer_chat_taken"]> {
    const link = this.opts.link(macId);
    if (!link) return { moved: false, busy: false };
    const out = await this.pull(macId, link, agentId, conversationId, true);
    if (out === "moved") {
      log("peers:chat-taken", { from: macId, agent: agentId, chat: conversationId });
      this.opts.onMoved(macId);
    }
    return { moved: out === "moved", busy: out === "busy" };
  }

  private async pull(macId: string, link: PeerLink, agentId: string, conversationId: string, placed: boolean): Promise<"moved" | "busy" | "none"> {
    const reply = (await link.request({ type: "peer_chat_export", agent_id: agentId, conversation_id: conversationId }, 120_000)) as {
      chat?: MovedChat | null;
      busy?: boolean;
    };
    if (reply.busy) return "busy";
    if (!reply.chat) return "none";
    const names = { from: this.opts.name(macId) ?? "another Mac", to: this.opts.name(null) ?? "this Mac" };
    await this.opts.chat.importChat(placed ? { ...reply.chat, info: { ...reply.chat.info, placed: true } } : reply.chat, names);
    await link.request({ type: "peer_chat_moved", agent_id: agentId, conversation_id: conversationId });
    return "moved";
  }
}

interface Hold {
  agent_id: string;
  conversation_id: string;
  /** The Mac it moves to. */
  to: string;
  /** When the hold began (ISO). */
  at: string;
  /** The person kept it here while `to` was out of reach: `to` lets go of its copy at the next contact. */
  kept?: boolean;
}

function readHolds(file: string): Array<[string, Hold]> {
  const raw = readJson(file);
  const list = typeof raw === "object" && raw !== null ? (raw as { holds?: unknown }).holds : null;
  if (!Array.isArray(list)) return [];
  return list.flatMap((v: unknown) => {
    if (typeof v !== "object" || v === null) return [];
    const h = v as Record<string, unknown>;
    if (typeof h.agent_id !== "string" || typeof h.conversation_id !== "string" || typeof h.to !== "string" || typeof h.at !== "string") return [];
    const hold: Hold = { agent_id: h.agent_id, conversation_id: h.conversation_id, to: h.to, at: h.at, ...(h.kept === true ? { kept: true } : {}) };
    return [[`${hold.agent_id}/${hold.conversation_id}`, hold] as [string, Hold]];
  });
}

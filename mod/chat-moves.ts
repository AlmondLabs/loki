import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { scopeFor } from "../core/desk-core.ts";
import { MOVE_TIMEOUT_MS, type Replies } from "../core/frames.ts";
import type { MovedChat } from "../daemon/chat-move.ts";
import type { ChatBackend } from "./frames/chat.ts";
import type { PeerMoves } from "./frames/peers.ts";
import type { PeerLink } from "./peer-link.ts";
import { log } from "./log.ts";

/**
 * Moving chats between paired Macs (plan 023, U9, R9, KTD11, addendum A1), both sides of it in one place. A chat has
 * one writer, the Mac it lives on, so a move is a hand-over: the Mac it leaves copies it out (or says it is busy, and
 * it waits), the Mac it moves to writes it in under the same id with its canvas files, and only then does the first
 * Mac let go, hiding its copy and stopping its schedules. Meanwhile the chat takes no message on the Mac it leaves.
 *
 * Two kinds of move run on it: the takeover of an agent's chats by its home Mac, once after pairing (and again when an
 * agent's home is set to this Mac), and one chat moved by the person, which arrives `placed` so the takeover leaves it
 * where it was put. A move cut short is tried again at the next contact, and a chat already here is not written twice.
 * The frames between Macs (mod/frames/peers.ts) call it as their `moves`; the peer link carries it, and tests join two
 * of these with an in-memory link.
 */
export class ChatMoves implements PeerMoves {
  private readonly opts: {
    /** This Mac's id. */
    here: string;
    chat: Pick<ChatBackend, "moveCandidates" | "exportChat" | "importChat" | "finishMove">;
    /** The link to a paired Mac in reach; null when it is out of reach or not paired. */
    link: (macId: string) => PeerLink | null;
    widgetsDir: string;
    /** A Mac's name, this one's for null; null for a Mac not paired with this one. */
    name: (macId: string | null) => string | null;
    /** Whether this Mac already took its agents' chats over from that Mac. */
    done: (macId: string) => boolean;
    markDone: (macId: string) => void;
    /** Chats moved between this Mac and `macId`, either way: both Macs' lists should be read again. */
    onMoved: (macId: string) => void;
    /** This Mac let a chat go to `to`: frames for it go there now. */
    onLeft: (chat: { agent_id: string; conversation_id: string }, to: string) => void;
  };
  /** Chats this Mac is handing over, which take no message meanwhile. */
  private readonly moving = new Map<string, string>();
  private readonly running = new Set<string>();

  constructor(opts: ChatMoves["opts"]) {
    this.opts = opts;
  }

  /** Why a chat takes no message now: it is moving to another Mac. */
  blocked(agentId: string, conversationId: string): string | null {
    return this.moving.has(`${agentId}/${conversationId}`) ? "this chat is moving to the Mac its agent lives on; it opens there in a moment" : null;
  }

  /**
   * The new home's side: take over this Mac's agents' chats from `macId`, unless that was done. `again` asks once more
   * after it was: an agent's home was just set to this Mac, so its chats there come here too.
   */
  async takeOver(macId: string, again = false): Promise<void> {
    if ((this.opts.done(macId) && !again) || this.running.has(macId)) return;
    const link = this.opts.link(macId);
    if (!link) return;
    this.running.add(macId);
    try {
      const { chats } = (await link.request({ type: "peer_moves_get" })) as { chats?: Array<{ agent_id: string; conversation_id: string }> };
      let waiting = false;
      let moved = 0;
      // One chat at a time: each copies a whole log, and a Mac just paired is not flooded.
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
      // Out of reach halfway: what moved stays moved, the rest goes at the next contact.
      log("peers:chat-move-failed", { from: macId, error: err instanceof Error ? err.message : String(err) });
    } finally {
      this.running.delete(macId);
    }
  }

  /** The person moves a chat living here to the paired Mac `to`: null once it moved, else why not, in their words. */
  async offer(to: string, agentId: string, conversationId: string): Promise<string | null> {
    if (to === this.opts.here) return null;
    const name = this.opts.name(to);
    if (name === null) return "that Mac is not paired with this one";
    const link = this.opts.link(to);
    if (!link) return `${name} is out of reach: move the chat once it is back`;
    try {
      // That Mac takes it: it copies the chat out of this one and tells this one to let go (take, below, over there).
      const out = (await link.request({ type: "peer_chat_take", agent_id: agentId, conversation_id: conversationId }, MOVE_TIMEOUT_MS)) as {
        moved?: boolean;
        busy?: boolean;
      };
      if (out.busy) return "the chat is answering or waiting for you: move it once it is done";
      if (!out.moved) return "the chat is not on this Mac";
      this.opts.onMoved(to);
      return null;
    } catch (err) {
      return `the move to ${name} did not finish: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  /** The chats here whose agent lives on `macId`, for that Mac's takeover. */
  candidates(macId: string): Promise<Replies["peer_moves"]["chats"]> {
    return this.opts.chat.moveCandidates(macId);
  }

  /** The side a chat leaves: copy it out for `macId`, with its canvas files, and hold it meanwhile. */
  async export(macId: string, agentId: string, conversationId: string): Promise<Replies["peer_chat"]> {
    const out = await this.opts.chat.exportChat(agentId, conversationId);
    if (!out.chat) return { ...out, widgets: {} };
    this.moving.set(`${agentId}/${conversationId}`, macId);
    return { ...out, widgets: readWidgets(join(this.opts.widgetsDir, scopeFor(conversationId, agentId))) };
  }

  /** The side a chat leaves: `macId` holds it now, so let go of it here. */
  async moved(macId: string, agentId: string, conversationId: string): Promise<void> {
    await this.opts.chat.finishMove(agentId, conversationId);
    rmSync(join(this.opts.widgetsDir, scopeFor(conversationId, agentId)), { recursive: true, force: true });
    this.moving.delete(`${agentId}/${conversationId}`);
    log("peers:chat-moved", { agent: agentId, chat: conversationId, to: macId });
    this.opts.onLeft({ agent_id: agentId, conversation_id: conversationId }, macId);
  }

  /**
   * The side a chat moves to: take one chat over from `macId`, where it lives, because the person moved it here. It
   * arrives placed, so the takeover of its agent's chats leaves it here. `busy` while a turn runs or an approval waits.
   */
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

  /** Copy one chat out of the Mac at the link's end, write it in here with its canvas files, and have that Mac let go. */
  private async pull(macId: string, link: PeerLink, agentId: string, conversationId: string, placed: boolean): Promise<"moved" | "busy" | "none"> {
    const reply = (await link.request({ type: "peer_chat_export", agent_id: agentId, conversation_id: conversationId }, 120_000)) as {
      chat?: MovedChat | null;
      busy?: boolean;
      widgets?: Record<string, string>;
    };
    if (reply.busy) return "busy";
    if (!reply.chat) return "none";
    const names = { from: this.opts.name(macId) ?? "another Mac", to: this.opts.name(null) ?? "this Mac" };
    await this.opts.chat.importChat(placed ? { ...reply.chat, info: { ...reply.chat.info, placed: true } } : reply.chat, names);
    writeWidgets(join(this.opts.widgetsDir, scopeFor(conversationId, agentId)), reply.widgets ?? {});
    await link.request({ type: "peer_chat_moved", agent_id: agentId, conversation_id: conversationId });
    return "moved";
  }
}

/** A canvas's files, by path under its folder, as base64. */
function readWidgets(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    let names: string[];
    try {
      names = readdirSync(d);
    } catch {
      return;
    }
    for (const name of names) {
      const full = join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      else out[relative(dir, full).split(sep).join("/")] = readFileSync(full).toString("base64");
    }
  };
  walk(dir);
  return out;
}

/**
 * A canvas's files written into its folder here; a path that would leave the folder is skipped. Checked where it
 * lands, not only by its parts: on Windows `..\x` or `C:\x` is one part with no ".." in it.
 */
export function writeWidgets(dir: string, files: Record<string, string>): void {
  for (const [path, data] of Object.entries(files)) {
    if (path.split("/").some((p) => p === ".." || p === "") || path.startsWith("/")) continue;
    const full = join(dir, ...path.split("/"));
    const rel = relative(resolve(dir), resolve(full));
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) continue;
    mkdirSync(dirname(full), { recursive: true });
    if (!existsSync(full)) writeFileSync(full, Buffer.from(data, "base64"));
  }
}

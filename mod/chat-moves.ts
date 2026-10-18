import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { scopeFor } from "../core/desk-core.ts";
import type { MovedChat } from "../daemon/chat-move.ts";
import type { ChatBackend } from "./frames/chat.ts";
import type { PeerLink } from "./peer-link.ts";
import { log } from "./log.ts";

/** How long moving one chat may take, end to end: a long chat's whole log crosses the link. */
export const MOVE_TIMEOUT_MS = 180_000;

/**
 * Taking over this Mac's agents' chats from a Mac they were made on, once, after pairing (plan 023, U9, R9, KTD11):
 * the mini, home of Ira, takes Ira's chats from the MacBook. One chat at a time: the old Mac copies it out (or says
 * it is busy, and it waits for the next contact), this Mac writes it in under the same id with its canvas files, and
 * then the old Mac lets go, hiding its copy and stopping its schedules. A move cut short is tried again at the next
 * contact, and a chat already here is not written twice. Done for a Mac once nothing is left to take.
 */
export class ChatMoves {
  private readonly opts: {
    chat: ChatBackend;
    link: (macId: string) => PeerLink | null;
    widgetsDir: string;
    /** Whether this Mac already took its chats over from that Mac. */
    done: (macId: string) => boolean;
    markDone: (macId: string) => void;
    /** Chats moved here: the lists should be asked for again. */
    onMoved: (macId: string) => void;
    /** A Mac's name, this one's included, for the mark a moved chat's thread keeps (addendum A5); absent, no mark. */
    name?: (macId: string | null) => string;
  };
  /** Chats this Mac is handing over, which take no message meanwhile. */
  private readonly moving = new Map<string, string>();
  private running = new Set<string>();

  constructor(opts: ChatMoves["opts"]) {
    this.opts = opts;
  }

  /** Why a chat takes no message now: it is moving to another Mac. */
  blocked(agentId: string, conversationId: string): string | null {
    return this.moving.has(`${agentId}/${conversationId}`) ? "this chat is moving to the Mac its agent lives on; it opens there in a moment" : null;
  }

  /** The old Mac's side: copy a chat out for the Mac it moves to, with its canvas files, and hold it meanwhile. */
  async export(macId: string, agentId: string, conversationId: string): Promise<{ chat: MovedChat | null; busy: boolean; widgets: Record<string, string> }> {
    const out = await this.opts.chat.exportChat(agentId, conversationId);
    if (!out.chat) return { ...out, widgets: {} };
    this.moving.set(`${agentId}/${conversationId}`, macId);
    return { ...out, widgets: readWidgets(join(this.opts.widgetsDir, scopeFor(conversationId, agentId))) };
  }

  /** The old Mac's side: the other Mac holds the chat now, so let go of it here. */
  async moved(agentId: string, conversationId: string): Promise<void> {
    await this.opts.chat.finishMove(agentId, conversationId);
    rmSync(join(this.opts.widgetsDir, scopeFor(conversationId, agentId)), { recursive: true, force: true });
    this.moving.delete(`${agentId}/${conversationId}`);
    log("peers:chat-moved", { agent: agentId, chat: conversationId });
  }

  /**
   * The new home's side: take over this Mac's agents' chats from `macId`, unless that was done. `again` asks once more
   * after it was: an agent's home was just set to this Mac, so its chats there come here too.
   */
  async run(macId: string, again = false): Promise<void> {
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
      // Out of reach halfway: what moved stays moved, the rest goes at the next contact.
      log("peers:chat-move-failed", { from: macId, error: err instanceof Error ? err.message : String(err) });
    } finally {
      this.running.delete(macId);
    }
  }

  /**
   * Take one chat over from `macId`, where it lives, because the person moved it here (addendum A1): it is placed, so
   * the hand-over of its agent's chats leaves it here. `busy` while a turn runs or an approval waits there.
   */
  async take(macId: string, agentId: string, conversationId: string): Promise<{ moved: boolean; busy: boolean }> {
    const link = this.opts.link(macId);
    if (!link) return { moved: false, busy: false };
    const out = await this.pull(macId, link, agentId, conversationId, true);
    if (out === "moved") {
      log("peers:chat-taken", { from: macId, agent: agentId, chat: conversationId });
      this.opts.onMoved(macId);
    }
    return { moved: out === "moved", busy: out === "busy" };
  }

  /** Copy one chat out of the Mac at the link's end, write it in here with its canvas files, and let that Mac go of it. */
  private async pull(macId: string, link: PeerLink, agentId: string, conversationId: string, placed: boolean): Promise<"moved" | "busy" | "none"> {
    const reply = (await link.request({ type: "peer_chat_export", agent_id: agentId, conversation_id: conversationId }, 120_000)) as {
      chat?: MovedChat | null;
      busy?: boolean;
      widgets?: Record<string, string>;
    };
    if (reply.busy) return "busy";
    if (!reply.chat) return "none";
    const name = this.opts.name;
    const names = name ? { from: name(macId), to: name(null) } : undefined;
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

/** A canvas's files written into its folder here; a path that would leave the folder is skipped. */
function writeWidgets(dir: string, files: Record<string, string>): void {
  for (const [path, data] of Object.entries(files)) {
    if (path.split("/").some((p) => p === ".." || p === "") || path.startsWith("/")) continue;
    const full = join(dir, ...path.split("/"));
    mkdirSync(dirname(full), { recursive: true });
    if (!existsSync(full)) writeFileSync(full, Buffer.from(data, "base64"));
  }
}

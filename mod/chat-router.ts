import { isAbsolute, relative, sep } from "node:path";
import { basename } from "node:path";
import type { FrameName } from "../core/frames.ts";
import type { PeerLink } from "./peer-link.ts";
import type { RemoteHome } from "./remote-chats.ts";
import { MOVE_TIMEOUT_MS } from "./chat-moves.ts";

/**
 * Each chat answered by the Mac it lives on (plan 023, U5, KTD3). A frame from this Mac's tabs or phones about a chat
 * (or its canvas) that lives on a paired Mac goes over that Mac's link as it is, and the answer comes back to the one
 * who asked; what the home pushes about that chat (its events, its canvas) is passed on here. The app and the phone
 * keep talking to their own Mac only. A paired Mac's own frames are never sent on: a chat is one hop from its home.
 */

/** The chat frames routed by the chat they name (`conversation_id`, with `agent_id` when given). */
export const CHAT_ROUTED: ReadonlySet<FrameName> = new Set([
  "history_get",
  "chat_open",
  "chat_approve",
  "chat_answer",
  "chat_send",
  "chat_abort",
  "chat_update",
  "chat_folder",
  "chat_model",
  "chat_move",
]);

/** The canvas frames routed by the desk they name: its scope, or a widget id's leading scope. */
export const SCOPE_ROUTED: ReadonlySet<FrameName> = new Set(["desk_get", "gesture", "measure", "widget_status"]);

/** The pushes about one desk, passed on when they come from the Mac that desk lives on. */
const SCOPED_PUSHES = new Set(["state", "widgets", "desk", "widget_change"]);

/** What the router is built from: where chats and desks live, the links, and sending a file on to a Mac. */
export interface ChatRouterOptions {
  /** This Mac's id: a new chat asked to live here stays here. */
  here?: string;
  /** A paired Mac as a home, and whether it is in reach; null for a Mac that is not paired. */
  peer?: (macId: string) => RemoteHome | null;
  /** The Mac an agent lives on, from its record; null when it names none. */
  agentHome?: (agentId: string) => string | null;
  homeOf: (conversationId: string, agentId: string | null) => RemoteHome | null;
  homeOfScope: (scope: string) => RemoteHome | null;
  link: (macId: string) => PeerLink | null;
  /** A paired Mac's name, for "waiting for <Mac>". */
  name: (macId: string) => string;
  /** This Mac's uploads folder: files attached here to a remote chat are sent on from it. */
  uploadsDir: string;
  /** Send an uploaded file to a Mac; its path there, or null. */
  upload: (macId: string, file: { path: string; name: string; mime: string }) => Promise<string | null>;
}

/** Where a frame goes: here (null), or the paired Mac it names. */
export type Target = RemoteHome | null;

/** How a forwarded frame ended: the home's reply frame, nothing (a send), or why it could not be forwarded. */
export type Forwarded = { ok: true; reply: Record<string, unknown> | null } | { ok: false; message: string };

/** The router between this Mac's clients and the Macs their chats live on. */
export class ChatRouter {
  private readonly opts: ChatRouterOptions;

  constructor(opts: ChatRouterOptions) {
    this.opts = opts;
  }

  /** The Mac a frame is about, when it is another Mac's chat or desk; null when it is this Mac's, or not about one. */
  target(msg: Record<string, unknown>): Target {
    const type = msg.type as FrameName;
    if (type === "chat_create") return this.newChatHome(msg);
    // The folders of the Mac a new chat will live on (U6).
    if (type === "folders_get" || type === "folder_complete" || type === "folder_check" || type === "chat_requirements") return this.askedHome(msg.home);
    if (CHAT_ROUTED.has(type) && typeof msg.conversation_id === "string")
      return this.opts.homeOf(msg.conversation_id, typeof msg.agent_id === "string" ? msg.agent_id : null);
    if (SCOPE_ROUTED.has(type)) {
      const scope = scopeOfFrame(msg);
      return scope ? this.opts.homeOfScope(scope) : null;
    }
    return null;
  }

  /**
   * Where a new chat lives (R7): the Mac it names, else its agent's home while that Mac is in reach, else here. A
   * named Mac out of reach is still the answer, so the chat is not made anywhere and the person hears why.
   */
  private newChatHome(msg: Record<string, unknown>): Target {
    const named = this.askedHome(msg.home);
    if (named || (typeof msg.home === "string" && msg.home)) return named;
    const agentHome = typeof msg.agent_id === "string" ? this.opts.agentHome?.(msg.agent_id) : null;
    if (!agentHome || agentHome === this.opts.here) return null;
    const home = this.opts.peer?.(agentHome) ?? null;
    return home?.reachable ? home : null;
  }

  /** The paired Mac a frame's `home` names; null for this Mac, no Mac, or one not paired. */
  private askedHome(home: unknown): Target {
    if (typeof home !== "string" || !home || home === this.opts.here) return null;
    return this.opts.peer?.(home) ?? null;
  }

  /**
   * Send a frame to the Mac it is about: a request comes back with the home's reply (or why not), a send with nothing.
   * A message's files attached here go to the home first, and the message names them where they now are.
   */
  async forward(home: RemoteHome, msg: Record<string, unknown>, kind: "request" | "send"): Promise<Forwarded> {
    const name = this.opts.name(home.mac);
    const link = this.opts.link(home.mac);
    if (!home.reachable || !link)
      return {
        ok: false,
        message: msg.type === "chat_create" ? `${name} is out of reach: the chat was not started` : `waiting for ${name}: this chat lives there`,
      };
    const frame = { ...msg } as { type: string } & Record<string, unknown>;
    delete frame.request_id;
    if (frame.type === "chat_send" && typeof frame.text === "string") {
      const text = await this.carryFiles(home.mac, frame.text);
      if (text === null) return { ok: false, message: `a file could not be sent to ${name}; try again` };
      frame.text = text;
    }
    if (kind === "send") return link.send(frame) ? { ok: true, reply: null } : { ok: false, message: `waiting for ${name}: this chat lives there` };
    try {
      // A move waits for the whole chat to cross to the Mac it moves to.
      return { ok: true, reply: await link.request(frame, frame.type === "chat_move" ? MOVE_TIMEOUT_MS : 30_000) };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Whether a push from a paired Mac is about one of its own chats or desks, so this Mac's clients should hear it:
   * the scope to send it to (undefined for every client), or false to leave it.
   */
  relay(fromMac: string, frame: Record<string, unknown>): { scope?: string } | false {
    if (frame.type === "chat_event" && typeof frame.conversation_id === "string") {
      const home = this.opts.homeOf(frame.conversation_id, typeof frame.agent_id === "string" ? frame.agent_id : null);
      return home?.mac === fromMac ? {} : false;
    }
    if (typeof frame.type === "string" && SCOPED_PUSHES.has(frame.type)) {
      const scope = typeof frame.scope === "string" ? frame.scope : scopeOfEntry(frame.entry);
      if (!scope) return false;
      return this.opts.homeOfScope(scope)?.mac === fromMac ? { scope } : false;
    }
    return false;
  }

  /** The message with each file attached here sent to `mac` and named by its path there; null when one could not be sent. */
  private async carryFiles(mac: string, text: string): Promise<string | null> {
    let out = text;
    for (const m of text.matchAll(/<attachment kind="file" local_path="([^"]*)" name="([^"]*)" mime_type="([^"]*)"/g)) {
      const path = unescapeAttr(m[1]);
      if (!insideDir(this.opts.uploadsDir, path)) continue;
      const there = await this.opts.upload(mac, { path, name: unescapeAttr(m[2]) || basename(path), mime: unescapeAttr(m[3]) || "application/octet-stream" });
      if (!there) return null;
      out = out.replace(`local_path="${m[1]}"`, `local_path="${escapeAttr(there)}"`);
    }
    return out;
  }
}

/** The desk a canvas frame names: `scope`, or the scope a widget id starts with (`<scope>/<name>`). */
export function scopeOfFrame(msg: Record<string, unknown>): string | null {
  if (typeof msg.scope === "string") return msg.scope;
  const gesture = msg.gesture as { id?: unknown } | undefined;
  const id = typeof msg.id === "string" ? msg.id : typeof gesture?.id === "string" ? gesture.id : null;
  if (!id) return null;
  const slash = id.indexOf("/");
  return slash > 0 ? id.slice(0, slash) : null;
}

const scopeOfEntry = (entry: unknown): string | null => {
  const e = entry as { scope?: unknown } | undefined;
  return typeof e?.scope === "string" ? e.scope : null;
};

const insideDir = (dir: string, path: string): boolean => {
  const rel = relative(dir, path);
  return !!rel && !rel.startsWith("..") && !isAbsolute(rel) && !rel.split(sep).includes("..");
};

const unescapeAttr = (s: string) =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
const escapeAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

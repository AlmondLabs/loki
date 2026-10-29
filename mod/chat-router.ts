import { isAbsolute, relative, sep } from "node:path";
import { basename } from "node:path";
import { peerMeaning, pushMeaning } from "../core/frames.ts";
import type { PeerLink } from "./peer-link.ts";
import { scopeFor } from "../core/desk-core.ts";
import type { ChatDirectory, ChatRef, Location } from "./chat-directory.ts";
import { PeerRefusal } from "./peer-link.ts";
import { messageOf } from "../core/errors.ts";

/**
 * Each chat answered by the Mac it lives on (plan 023, U5, KTD3). A frame from this Mac's tabs or phones about a chat
 * (or its canvas) that lives on a paired Mac goes over that Mac's link as it is, and the answer comes back to the one
 * who asked; what the home pushes about that chat (its events, its canvas) is passed on here. The app and the phone
 * keep talking to their own Mac only. A paired Mac's own frames are never sent on: a chat is one hop from its home.
 */

/** What the router is built from: where chats and desks live, the links, and sending a file on to a Mac. */
export interface ChatRouterOptions {
  /** This Mac's id: a new chat asked to live here stays here. */
  here?: string;
  /** A paired Mac as a home, and whether it is in reach; null for a Mac that is not paired. */
  peer?: (macId: string) => RemoteHome | null;
  /** The Mac an agent lives on, from its record; null when it names none. */
  agentHome?: (agentId: string) => string | null;
  /** Where each chat lives (addendum B): asked for every chat and desk frame, told of every redirect. */
  directory: Pick<ChatDirectory, "peek" | "locate" | "heard" | "answer">;
  link: (macId: string) => PeerLink | null;
  /** A paired Mac's name, for "waiting for <Mac>". */
  name: (macId: string) => string;
  /** This Mac's uploads folder: files attached here to a remote chat are sent on from it. */
  uploadsDir: string;
  /** Send an uploaded file to a Mac; its path there, or null. */
  upload: (macId: string, file: { path: string; name: string; mime: string }) => Promise<string | null>;
  /** Read a Mac's chats again, so a rename or a move made there shows here before the person is answered. */
  relist?: (macId: string) => Promise<void>;
}

/** A paired Mac a frame goes to, and whether it is in reach. */
export interface RemoteHome {
  mac: string;
  reachable: boolean;
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

  /**
   * The Mac a frame is about, when it is another Mac's chat or desk; null when it is this Mac's, or not about one. A
   * chat no Mac claimed yet is asked for (the promise); a desk is never asked for, since most desks name no chat.
   */
  target(msg: Record<string, unknown>): Target | Promise<Target> {
    // How each frame finds its Mac is the frame table's (core/frames.ts, addendum C).
    const route = peerMeaning(msg.type)?.route;
    if (route === "new-chat") return this.newChatHome(msg);
    // The folders of the Mac a new chat will live on (U6).
    if (route === "home") return this.askedHome(msg.home);
    const chat = chatOfFrame(msg);
    if (route === "chat" && chat) {
      const known = this.opts.directory.peek(chat);
      return known ? toTarget(known) : this.opts.directory.locate(chat).then(toTarget);
    }
    if (route === "scope") {
      const scope = scopeOfFrame(msg);
      const known = scope ? this.opts.directory.peek(scope) : null;
      return known ? toTarget(known) : null;
    }
    return null;
  }

  /**
   * A paired Mac's frame about a chat that does not live here (addendum B3): the error that redirects it, naming where
   * the chat went when this Mac let it go. Null for every other frame, which is answered as usual.
   */
  redirect(msg: Record<string, unknown>): { message: string; moved_to: string | null } | null {
    const chat = chatOfFrame(msg);
    if (!chat || peerMeaning(msg.type)?.route !== "chat") return null;
    const { held, moved_to: movedTo } = this.opts.directory.answer(chat);
    if (held) return null;
    return { message: movedTo ? `this chat moved to ${this.opts.name(movedTo)}` : "this chat is not on this Mac", moved_to: movedTo };
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
  async forward(home: RemoteHome, msg: Record<string, unknown>, kind: "request" | "send", again = false): Promise<Forwarded> {
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
    const meaning = peerMeaning(frame.type);
    try {
      // A move waits for the whole chat to cross to the Mac it moves to (its timeout_ms).
      const reply = await link.request(frame, meaning?.timeout_ms ?? 30_000);
      if (meaning?.relists) await this.opts.relist?.(home.mac);
      return { ok: true, reply };
    } catch (err) {
      const chat = chatOfFrame(msg);
      // The chat left that Mac (addendum B3): learn where it went, and send once more, there.
      if (err instanceof PeerRefusal && "moved_to" in err.frame && chat && !again) {
        const movedTo = typeof err.frame.moved_to === "string" ? err.frame.moved_to : null;
        this.opts.directory.heard(home.mac, { kind: "answer", scope: scopeFor(chat.conversation_id, chat.agent_id ?? null), held: false, moved_to: movedTo });
        const now = await this.opts.directory.locate(chat);
        if (now.at === "mac" && now.mac !== home.mac) return this.forward({ mac: now.mac, reachable: now.reachable }, msg, kind, true);
        return { ok: false, message: now.at === "here" ? "this chat is on this Mac now: open it again" : "this chat is not on any of your Macs" };
      }
      return { ok: false, message: messageOf(err) };
    }
  }

  /**
   * Whether a push from a paired Mac is about one of its own chats or desks, so this Mac's clients should hear it:
   * the scope to send it to (undefined for every client), or false to leave it.
   */
  relay(fromMac: string, frame: Record<string, unknown>): { scope?: string } | false {
    const from = (where: Location | null) => where?.at === "mac" && where.mac === fromMac;
    const relay = pushMeaning(frame.type)?.relay;
    const chat = chatOfFrame(frame);
    if (relay === "chat") return chat && from(this.opts.directory.peek(chat)) ? {} : false;
    if (relay === "scope") {
      const scope = typeof frame.scope === "string" ? frame.scope : scopeOfEntry(frame.entry);
      if (!scope) return false;
      return from(this.opts.directory.peek(scope)) ? { scope } : false;
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

/** The chat a frame names: its conversation, with its agent when given. */
function chatOfFrame(msg: Record<string, unknown>): ChatRef | null {
  if (typeof msg.conversation_id !== "string" || !msg.conversation_id) return null;
  return { conversation_id: msg.conversation_id, agent_id: typeof msg.agent_id === "string" ? msg.agent_id : null };
}

/** A location as the router sends to it: this Mac (and a chat no Mac has) is null, answered here. */
const toTarget = (where: Location): Target => (where.at === "mac" ? { mac: where.mac, reachable: where.reachable } : null);

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

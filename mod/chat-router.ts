import { isAbsolute, relative, sep } from "node:path";
import { basename } from "node:path";
import { peerMeaning, pushMeaning } from "../core/frames.ts";
import type { PeerLink } from "./peer-link.ts";
import { scopeFor } from "../core/desk-core.ts";
import type { ChatDirectory, ChatRef, Location } from "./chat-directory.ts";
import { PeerRefusal } from "./peer-link.ts";
import { messageOf } from "../core/errors.ts";

export interface ChatRouterOptions {
  here?: string;
  peer?: (macId: string) => RemoteHome | null;
  agentHome?: (agentId: string) => string | null;
  directory: Pick<ChatDirectory, "peek" | "locate" | "heard" | "answer">;
  link: (macId: string) => PeerLink | null;
  name: (macId: string) => string;
  uploadsDir: string;
  upload: (macId: string, file: { path: string; name: string; mime: string }) => Promise<string | null>;
  relist?: (macId: string) => Promise<void>;
}

export interface RemoteHome {
  mac: string;
  reachable: boolean;
}

export type Target = RemoteHome | null;

export type Forwarded = { ok: true; reply: Record<string, unknown> | null } | { ok: false; message: string };

export class ChatRouter {
  private readonly opts: ChatRouterOptions;

  constructor(opts: ChatRouterOptions) {
    this.opts = opts;
  }

  target(msg: Record<string, unknown>): Target | Promise<Target> {
    const route = peerMeaning(msg.type)?.route;
    if (route === "new-chat") return this.newChatHome(msg);
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

  redirect(msg: Record<string, unknown>): { message: string; moved_to: string | null } | null {
    const chat = chatOfFrame(msg);
    if (!chat || peerMeaning(msg.type)?.route !== "chat") return null;
    const { held, moved_to: movedTo } = this.opts.directory.answer(chat);
    if (held) return null;
    return { message: movedTo ? `this chat moved to ${this.opts.name(movedTo)}` : "this chat is not on this Mac", moved_to: movedTo };
  }

  private newChatHome(msg: Record<string, unknown>): Target {
    const named = this.askedHome(msg.home);
    if (named || (typeof msg.home === "string" && msg.home)) return named;
    const agentHome = typeof msg.agent_id === "string" ? this.opts.agentHome?.(msg.agent_id) : null;
    if (!agentHome || agentHome === this.opts.here) return null;
    const home = this.opts.peer?.(agentHome) ?? null;
    return home?.reachable ? home : null;
  }

  private askedHome(home: unknown): Target {
    if (typeof home !== "string" || !home || home === this.opts.here) return null;
    return this.opts.peer?.(home) ?? null;
  }

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
      const reply = await link.request(frame, meaning?.timeout_ms ?? 30_000);
      if (meaning?.relists) await this.opts.relist?.(home.mac);
      return { ok: true, reply };
    } catch (err) {
      const chat = chatOfFrame(msg);
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

function chatOfFrame(msg: Record<string, unknown>): ChatRef | null {
  if (typeof msg.conversation_id !== "string" || !msg.conversation_id) return null;
  return { conversation_id: msg.conversation_id, agent_id: typeof msg.agent_id === "string" ? msg.agent_id : null };
}

const toTarget = (where: Location): Target => (where.at === "mac" ? { mac: where.mac, reachable: where.reachable } : null);

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

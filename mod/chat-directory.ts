import { scopeFor, type Scope } from "../core/desk-core.ts";

/**
 * Where each chat lives, as this Mac knows it (plan 023, addendum B). A chat is a single writer at its home, and each
 * home is the authority on its own chats: this Mac's come from its store (`holds`), and each paired Mac's from its own
 * word, the chats it lists and its `chat_left` when one moves away. A chat no one claimed is asked of the paired Macs
 * in reach. A Mac that let a chat go keeps a forwarding note, so a frame that still reaches it is redirected rather
 * than refused. Nothing is kept on disk: a lost note costs one more question. Addresses only; what the lists show is
 * the remote chats' (mod/remote-chats.ts).
 */

/** A chat as a frame names it: its conversation, and its agent when given (an agent's main chat needs it). */
export interface ChatRef {
  agent_id?: string | null;
  conversation_id: string;
}

/** Where a frame about a chat goes: this Mac, a paired Mac (in reach or not), or nowhere any Mac knows. */
export type Location = { at: "here" } | { at: "mac"; mac: string; reachable: boolean } | { at: "nowhere" };

/** A paired Mac's word about where chats live. */
export type AddressNews =
  /** The chats it holds, as its list says (each one's scope): they replace what it said before. */
  | { kind: "holds"; scopes: Scope[] }
  /** It let a chat go to `to`. */
  | { kind: "left"; scope: Scope; to: string }
  /** Asked about a chat: it holds it, or not (and, when it let it go, where to). */
  | { kind: "answer"; scope: Scope; held: boolean; moved_to: string | null };

/** What the directory is built from: this Mac, its store, the paired Macs, and asking and telling them. */
export interface ChatDirectoryOptions {
  /** This Mac's id. */
  here: string;
  /** Whether this Mac's store holds the chat behind a desk (not hidden, not let go). */
  holds: (scope: Scope) => boolean;
  /** The paired Macs. */
  macs: () => string[];
  reachable: (mac: string) => boolean;
  /** Ask a paired Mac whether it holds a chat (`peer_where`); rejects when it cannot answer. */
  ask: (mac: string, chat: ChatRef) => Promise<{ held: boolean; moved_to: string | null }>;
  /** Tell every paired Mac that this one let a chat go (`chat_left`). */
  tell: (frame: { type: "chat_left"; agent_id: string | null; conversation_id: string; to: string }) => void;
}

/** The chat directory: `locate` for routing, `peek` for relaying, `answer` for the Macs that ask, `heard` and `left` to keep it current. */
export class ChatDirectory {
  private readonly opts: ChatDirectoryOptions;
  /** Each paired Mac's chats, by scope, as it last said. */
  private readonly claims = new Map<Scope, string>();
  /** The chats this Mac let go, and where to. */
  private readonly notes = new Map<Scope, string>();

  constructor(opts: ChatDirectoryOptions) {
    this.opts = opts;
  }

  /** Where a chat lives, for routing a frame to it: what is known now, else what the paired Macs in reach answer. */
  async locate(chat: ChatRef | Scope): Promise<Location> {
    const scope = scopeOf(chat);
    const known = this.peek(scope);
    if (known) return known;
    const macs = this.opts.macs().filter((m) => this.opts.reachable(m));
    const answers = await Promise.all(
      macs.map((mac) =>
        this.opts.ask(mac, typeof chat === "string" ? { conversation_id: chat } : chat).then(
          (a) => ({ mac, ...a }),
          () => null,
        ),
      ),
    );
    for (const a of answers) if (a) this.heard(a.mac, { kind: "answer", scope, held: a.held, moved_to: a.moved_to });
    return this.peek(scope) ?? { at: "nowhere" };
  }

  /** Where a chat lives as known now, never asking: null for a chat no one claimed. */
  peek(chat: ChatRef | Scope): Location | null {
    const scope = scopeOf(chat);
    if (this.opts.holds(scope)) return { at: "here" };
    const mac = this.notes.get(scope) ?? this.claims.get(scope);
    return mac ? this.at(mac) : null;
  }

  /**
   * This Mac's answer about a chat, for a paired Mac's `peer_where` and for a frame that reached it for a chat it does
   * not hold: whether it holds the chat, and where it went when this Mac let it go (null with no note, after a restart).
   */
  answer(chat: ChatRef | Scope): { held: boolean; moved_to: string | null } {
    const scope = scopeOf(chat);
    return { held: this.opts.holds(scope), moved_to: this.notes.get(scope) ?? null };
  }

  /** A paired Mac's word about where chats live. */
  heard(mac: string, news: AddressNews): void {
    if (news.kind === "holds") {
      for (const [scope, m] of this.claims) if (m === mac) this.claims.delete(scope);
      for (const scope of news.scopes) this.claim(scope, mac);
      return;
    }
    if (news.kind === "left") {
      if (this.claims.get(news.scope) === mac || !this.claims.has(news.scope)) this.claim(news.scope, news.to);
      return;
    }
    if (news.held) this.claim(news.scope, mac);
    else if (news.moved_to) this.claim(news.scope, news.moved_to);
    else if (this.claims.get(news.scope) === mac) this.claims.delete(news.scope);
  }

  /** This Mac let a chat go to `to`: keep a note for frames that still come here, and tell the paired Macs. */
  left(chat: ChatRef, to: string): void {
    const scope = scopeOf(chat);
    this.notes.set(scope, to);
    this.claims.delete(scope);
    this.opts.tell({ type: "chat_left", agent_id: chat.agent_id ?? null, conversation_id: chat.conversation_id, to });
  }

  /** A Mac is no longer paired: what it said goes, and so do notes pointing at it. */
  forget(mac: string): void {
    for (const [scope, m] of this.claims) if (m === mac) this.claims.delete(scope);
    for (const [scope, m] of this.notes) if (m === mac) this.notes.delete(scope);
  }

  /** A chat claimed by `mac`; one that came back here is this Mac's own again, known from its store. */
  private claim(scope: Scope, mac: string): void {
    if (mac === this.opts.here) {
      this.claims.delete(scope);
      this.notes.delete(scope);
      return;
    }
    this.claims.set(scope, mac);
  }

  private at(mac: string): Location {
    return mac === this.opts.here ? { at: "nowhere" } : { at: "mac", mac, reachable: this.opts.reachable(mac) };
  }
}

/** A chat's key here: its desk's scope, which tells an agent's main chat from another's. */
export const scopeOf = (chat: ChatRef | Scope): Scope => (typeof chat === "string" ? chat : scopeFor(chat.conversation_id, chat.agent_id ?? null));

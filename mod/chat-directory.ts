import { parentChatOfSubagent } from "../core/subagents.ts";
import { scopeFor, type Scope } from "../core/chat-scope.ts";

export interface ChatRef {
  agent_id?: string | null;
  conversation_id: string;
}

export type Location = { at: "here" } | { at: "mac"; mac: string; reachable: boolean } | { at: "nowhere" };

export type AddressNews =
  | { kind: "holds"; scopes: Scope[] }
  | { kind: "left"; scope: Scope; to: string }
  | { kind: "answer"; scope: Scope; held: boolean; moved_to: string | null };

export interface ChatDirectoryOptions {
  here: string;
  holds: (scope: Scope) => boolean;
  macs: () => string[];
  reachable: (mac: string) => boolean;
  ask: (mac: string, chat: ChatRef) => Promise<{ held: boolean; moved_to: string | null }>;
  tell: (frame: { type: "chat_left"; agent_id: string | null; conversation_id: string; to: string }) => void;
}

export class ChatDirectory {
  private readonly opts: ChatDirectoryOptions;
  private readonly claims = new Map<Scope, string>();
  private readonly notes = new Map<Scope, string>();

  constructor(opts: ChatDirectoryOptions) {
    this.opts = opts;
  }

  async locate(chat: ChatRef | Scope): Promise<Location> {
    const scope = scopeOf(chat);
    const known = this.peek(scope);
    if (known) return known;
    const macs = this.opts.macs().filter((m) => this.opts.reachable(m));
    const asked = typeof chat === "string" ? { conversation_id: chat } : holderOf(chat);
    const answers = await Promise.all(
      macs.map((mac) =>
        this.opts.ask(mac, asked).then(
          (a) => ({ mac, ...a }),
          () => null,
        ),
      ),
    );
    for (const a of answers) if (a) this.heard(a.mac, { kind: "answer", scope, held: a.held, moved_to: a.moved_to });
    return this.peek(scope) ?? { at: "nowhere" };
  }

  peek(chat: ChatRef | Scope): Location | null {
    const scope = scopeOf(chat);
    if (this.opts.holds(scope)) return { at: "here" };
    const mac = this.notes.get(scope) ?? this.claims.get(scope);
    return mac ? this.at(mac) : null;
  }

  answer(chat: ChatRef | Scope): { held: boolean; moved_to: string | null } {
    const scope = scopeOf(chat);
    return { held: this.opts.holds(scope), moved_to: this.notes.get(scope) ?? null };
  }

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

  left(chat: ChatRef, to: string): void {
    const scope = scopeOf(chat);
    this.notes.set(scope, to);
    this.claims.delete(scope);
    this.opts.tell({ type: "chat_left", agent_id: chat.agent_id ?? null, conversation_id: chat.conversation_id, to });
  }

  forget(mac: string): void {
    for (const [scope, m] of this.claims) if (m === mac) this.claims.delete(scope);
    for (const [scope, m] of this.notes) if (m === mac) this.notes.delete(scope);
  }

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

const holderOf = (chat: ChatRef): ChatRef => {
  const parent = parentChatOfSubagent(chat.conversation_id);
  return parent === null ? chat : { ...chat, conversation_id: parent };
};

export const scopeOf = (chat: ChatRef | Scope): Scope => {
  if (typeof chat === "string") return chat;
  const holder = holderOf(chat);
  return scopeFor(holder.conversation_id, holder.agent_id ?? null);
};

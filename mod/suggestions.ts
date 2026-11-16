import { randomUUID } from "node:crypto";
import type { ChatEvent } from "../core/attention/model.ts";
import type { DeskStatus, SavedDraft, Suggestion, SuggestionTarget } from "../core/frame-types.ts";
import { DRAFT_HELD, FRAMES, type ChatState, type SuggestionAction } from "../core/frames.ts";
import { suggestedMark } from "../core/harness.ts";
import type { ChatBackend } from "./frames/chat.ts";
import type { ChatRouter } from "./chat-router.ts";
import { keyedQueue } from "../core/serial.ts";
import { messageOf } from "../core/errors.ts";

export interface ChatKey {
  agent_id: string;
  conversation_id: string;
}

export interface SuggestionRecords {
  read(agentId: string, conversationId: string): Promise<{ suggestions: Suggestion[]; archived: boolean } | null>;
  write(agentId: string, conversationId: string, suggestions: Suggestion[]): Promise<void>;
}

export interface TargetChat {
  title: string | null;
  status: DeskStatus;
  has_draft: boolean;
}

export type ChatCall =
  | { type: "chat_send"; agent_id: string; conversation_id: string; text: string; images: never[]; send_id: string; context: string | null }
  | { type: "chat_create"; agent_id: string; cwd: string; title: string; home?: string }
  | { type: "chat_update"; agent_id: string; conversation_id: string; archived?: boolean; draft?: SavedDraft };

export type CallOutcome = { ok: true; reply: Record<string, unknown> } | { ok: false; message: string };

export interface SuggestionsOptions {
  records: SuggestionRecords;
  chat(ref: ChatKey): TargetChat | null;
  agentExists(agentId: string): boolean;
  agentHome?(agentId: string): string | null;
  call(frame: ChatCall): Promise<CallOutcome>;
  push(agentId: string, conversationId: string, events: ChatEvent[]): void;
  track?(event: string, properties: Record<string, unknown>): void;
  now?(): Date;
  newId?(): string;
}

export interface Decided {
  suggestion: Suggestion;
  done: boolean;
  message: string | null;
}

export interface SuggestionInput {
  title: string;
  text: string;
  target: SuggestionTarget;
}

const HELD_WORDS = `${DRAFT_HELD}: send it there first, or pick another chat`;

const UNFINISHED = "that did not finish: try again";

const INTERRUPTED = "interrupted: try again";

const quotable = (title: string) => {
  const plain = title.replace(/[<>"]/g, "").replace(/\s+/g, " ").trim();
  return plain.length > 80 ? `${plain.slice(0, 79)}…` : plain || "another chat";
};

const isOpen = (s: Suggestion) => s.status === "pending" || s.status === "sending";

const byWords = (by: string | null | undefined) => (by === "phone" || by === "desktop" ? `the ${by}` : by || "another device");

function settledWords(s: Suggestion): string {
  switch (s.status) {
    case "sending":
      return "already being sent";
    case "sent":
      return `already sent from ${byWords(s.decided_by)}`;
    case "drafted":
      return `already saved as a draft from ${byWords(s.decided_by)}`;
    case "rejected":
      return `already rejected from ${byWords(s.decided_by)}`;
    case "withdrawn":
      return "the agent took this suggestion back";
    case "pending":
      return "still waiting";
  }
}

export class Suggestions {
  private readonly opts: SuggestionsOptions;
  private readonly locks = keyedQueue();
  private readonly inFlight = new Set<string>();

  constructor(opts: SuggestionsOptions) {
    this.opts = opts;
  }

  async add(source: ChatKey, input: SuggestionInput, options: { id?: string } = {}): Promise<Suggestion> {
    if (!input.title.trim()) throw new Error("a suggestion needs a title");
    if (!input.text.trim()) throw new Error("a suggestion needs a text");
    const suggestion: Suggestion = {
      id: options.id ?? this.opts.newId?.() ?? `sugg-${randomUUID()}`,
      title: input.title.trim(),
      text: input.text,
      target: input.target,
      status: "pending",
      reason: null,
      created_at: this.now(),
      made_conversation_id: null,
    };
    const added = await this.locked(source, async () => {
      const record = await this.record(source);
      const existing = options.id ? record.suggestions.find((s) => s.id === options.id) : undefined;
      if (existing) return { existing, archived: false };
      await this.save(source, [...record.suggestions, suggestion]);
      return { existing: null, archived: record.archived };
    });
    if (added.existing) return added.existing;
    if (added.archived) {
      const out = await this.opts.call({ type: "chat_update", ...source, archived: false });
      if (!out.ok) throw new Error(out.message);
    }
    this.opts.track?.("suggestion_made", { agent: source.agent_id, target: "conversation_id" in input.target ? "existing" : "new" });
    return suggestion;
  }

  async list(source: ChatKey): Promise<Suggestion[]> {
    return (await this.record(source)).suggestions;
  }

  async open(source: ChatKey): Promise<Suggestion[]> {
    return (await this.list(source)).filter(isOpen);
  }

  async retarget(source: ChatKey, id: string, target: SuggestionTarget): Promise<Decided> {
    return this.change(source, id, (s) => {
      if (s.status !== "pending") return { done: false, message: settledWords(s) };
      const same = JSON.stringify(s.target) === JSON.stringify(target);
      return { done: true, message: null, next: { ...s, target, reason: null, ...(same ? {} : { made_conversation_id: null }) } };
    });
  }

  async decide(source: ChatKey, id: string, action: SuggestionAction, by: string): Promise<Decided> {
    if (action === "reject") return this.reject(source, id, by);
    const flight = `${source.agent_id}/${source.conversation_id}/${id}`;
    // A field rather than a local, as the claim sets it inside the change.
    const mine = { claimed: false };
    let claim: Decided;
    try {
      claim = await this.change(source, id, (s) => {
        if (s.status !== "pending") return { done: false, message: settledWords(s) };
        const unfit = this.unfit(s.target, action);
        if (unfit) return { done: false, message: unfit, next: { ...s, reason: unfit } };
        mine.claimed = true;
        this.inFlight.add(flight);
        return { done: true, message: null, next: { ...s, status: "sending", reason: null } };
      });
    } catch (err) {
      if (mine.claimed) this.inFlight.delete(flight);
      throw err;
    }
    if (!claim.done) return claim;
    try {
      const carried = await this.carry(source, claim.suggestion, action).catch(() => ({ ok: false as const, message: UNFINISHED }));
      return await this.change(source, id, (s) =>
        carried.ok
          ? { done: true, message: null, next: { ...s, status: action === "send" ? "sent" : "drafted", reason: null, decided_by: by, decided_at: this.now() } }
          : { done: false, message: carried.message, next: { ...s, status: "pending", reason: carried.message } },
      ).catch(() => this.change(source, id, (s) => ({ done: false, message: UNFINISHED, next: { ...s, status: "pending", reason: UNFINISHED } })));
    } finally {
      this.inFlight.delete(flight);
    }
  }

  private unfit(target: SuggestionTarget, action: SuggestionAction): string | null {
    if (!this.opts.agentExists(target.agent_id)) return "the agent this was for is gone: pick another chat";
    if (!("conversation_id" in target)) return null;
    const chat = this.opts.chat(target);
    if (!chat || chat.status === "deleted" || chat.status === "none") return "the chat this was for is gone: pick another chat";
    if (chat.status === "archived") return "the chat this was for is archived: pick another chat";
    if (action === "draft" && chat.has_draft) return HELD_WORDS;
    return null;
  }

  private async carry(source: ChatKey, s: Suggestion, action: "send" | "draft"): Promise<{ ok: true } | { ok: false; message: string }> {
    let conversationId: string;
    if ("conversation_id" in s.target) conversationId = s.target.conversation_id;
    else if (s.made_conversation_id) conversationId = s.made_conversation_id;
    else {
      const home = this.opts.agentHome?.(s.target.agent_id) ?? null;
      const made = await this.opts.call({ type: "chat_create", agent_id: s.target.agent_id, cwd: s.target.folder, title: s.title, ...(home ? { home } : {}) });
      if (!made.ok) return made;
      if (typeof made.reply.conversation_id !== "string") return { ok: false, message: "the new chat was not made" };
      conversationId = made.reply.conversation_id;
      await this.change(source, s.id, (now) => ({ done: true, message: null, next: { ...now, made_conversation_id: conversationId } }));
    }
    const target = { agent_id: s.target.agent_id, conversation_id: conversationId };
    if (action === "draft") {
      const out = await this.opts.call({ type: "chat_update", ...target, draft: { text: s.text, suggestion_id: s.id, source } });
      if (!out.ok) return out.message.includes(DRAFT_HELD) ? { ok: false, message: HELD_WORDS } : out;
      return out.reply.draft_suggestion_id === s.id
        ? { ok: true }
        : { ok: false, message: "that chat's Mac runs an older loki: send it instead, or pick another chat" };
    }
    const out = await this.opts.call({ type: "chat_send", ...target, text: s.text, images: [], send_id: s.id, context: this.context(source, s) });
    if (!out.ok) return out;
    return out.reply.accepted === false ? { ok: false, message: "the chat did not take the message: try again" } : { ok: true };
  }

  private context(source: ChatKey, s: Suggestion): string {
    const title = quotable(this.opts.chat(source)?.title ?? "");
    return [
      suggestedMark({ from_agent: source.agent_id, from_chat: source.conversation_id, title: s.title }),
      `<system-reminder>The person sent this message from a suggestion an agent made in the chat "${title}".</system-reminder>`,
    ].join("\n");
  }

  private reject(source: ChatKey, id: string, by: string): Promise<Decided> {
    return this.change(source, id, (s) =>
      s.status === "pending"
        ? { done: true, message: null, next: { ...s, status: "rejected", reason: null, decided_by: by, decided_at: this.now() } }
        : { done: false, message: settledWords(s) },
    );
  }

  private change(source: ChatKey, id: string, fn: (s: Suggestion) => { done: boolean; message: string | null; next?: Suggestion }): Promise<Decided> {
    return this.locked(source, async () => {
      const { suggestions } = await this.record(source);
      const at = suggestions.findIndex((s) => s.id === id);
      if (at < 0) throw new Error(`no suggestion ${id} in this chat`);
      const out = fn(suggestions[at]);
      if (!out.next) return { suggestion: suggestions[at], done: out.done, message: out.message };
      const next = out.next;
      await this.save(
        source,
        suggestions.map((s, i) => (i === at ? next : s)),
      );
      return { suggestion: next, done: out.done, message: out.message };
    });
  }

  private async record(source: ChatKey): Promise<{ suggestions: Suggestion[]; archived: boolean }> {
    const record = await this.opts.records.read(source.agent_id, source.conversation_id);
    if (!record) throw new Error(`no chat ${source.conversation_id}`);
    const left = (s: Suggestion) => s.status === "sending" && !this.inFlight.has(`${source.agent_id}/${source.conversation_id}/${s.id}`);
    return { ...record, suggestions: record.suggestions.map((s) => (left(s) ? { ...s, status: "pending", reason: INTERRUPTED } : s)) };
  }

  private async save(source: ChatKey, suggestions: Suggestion[]): Promise<void> {
    await this.opts.records.write(source.agent_id, source.conversation_id, suggestions);
    this.opts.push(source.agent_id, source.conversation_id, [{ kind: "suggestions", suggestions: suggestions.filter(isOpen) }]);
  }

  private locked<T>(source: ChatKey, work: () => Promise<T>): Promise<T> {
    return this.locks(`${source.agent_id}/${source.conversation_id}`, work);
  }

  private now(): string {
    return (this.opts.now?.() ?? new Date()).toISOString();
  }
}

export interface ChatCallerOptions {
  route: Pick<ChatRouter, "target" | "forward">;
  backend: Pick<ChatBackend, "send" | "create" | "update">;
  blocked?: (agentId: string, conversationId: string) => string | null;
}

export function chatCaller(opts: ChatCallerOptions): (frame: ChatCall) => Promise<CallOutcome> {
  return async (frame) => {
    try {
      const home = await opts.route.target(frame);
      if (home) {
        const out = await opts.route.forward(home, frame, "request");
        return out.ok ? { ok: true, reply: out.reply ?? {} } : out;
      }
      return await here(opts, frame);
    } catch (err) {
      return { ok: false, message: messageOf(err) };
    }
  };
}

async function here(opts: ChatCallerOptions, frame: ChatCall): Promise<CallOutcome> {
  switch (frame.type) {
    case "chat_send": {
      const p = FRAMES.chat_send.parse(frame);
      if (typeof p === "string") return { ok: false, message: p };
      const blocked = opts.blocked?.(p.agent_id, p.conversation_id);
      if (blocked) return { ok: false, message: blocked };
      return { ok: true, reply: { accepted: await opts.backend.send(p) } };
    }
    case "chat_create": {
      const made = await opts.backend.create(frame.agent_id, frame.cwd, frame.title, frame.home ?? null);
      return { ok: true, reply: { agent_id: made.agentId, conversation_id: made.conversationId } };
    }
    case "chat_update": {
      const p = FRAMES.chat_update.parse(frame);
      if (typeof p === "string") return { ok: false, message: p };
      return { ok: true, reply: await opts.backend.update(p) };
    }
  }
}

export function withSuggestionsOnOpen(backend: ChatBackend, suggestions: Pick<Suggestions, "open">): ChatBackend {
  const open = async (agentId: string, conversationId: string, mode: string | null): Promise<ChatState> => {
    const [state, open] = await Promise.all([
      backend.open(agentId, conversationId, mode),
      suggestions.open({ agent_id: agentId, conversation_id: conversationId }).catch(() => null),
    ]);
    return open ? { ...state, suggestions: open } : state;
  };
  return new Proxy(backend, {
    get: (target, prop, receiver) => {
      if (prop === "open") return open;
      const value: unknown = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

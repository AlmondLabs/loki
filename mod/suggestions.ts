import { randomUUID } from "node:crypto";
import type { ChatEvent } from "../core/attention/model.ts";
import type { DeskStatus, SavedDraft, Suggestion, SuggestionTarget } from "../core/frame-types.ts";
import { DRAFT_HELD, FRAMES, type ChatState, type SuggestionAction } from "../core/frames.ts";
import { suggestedMark } from "../core/harness.ts";
import type { ChatBackend } from "./frames/chat.ts";
import type { ChatRouter } from "./chat-router.ts";

/**
 * Suggestions (plan 049, U2): messages agents suggest for other chats, kept on the record of the chat they were made
 * in, on the Mac that chat lives on (KTD1). That Mac carries out every action on them (KTD2): it moves each one from
 * pending to sending to sent, drafted, rejected or withdrawn in one step under the chat's lock, so the first action
 * wins and a second is told what already happened (R17). A send to a chat on another Mac is a request that waits for
 * that Mac's reply (KTD3), and the suggestion's id is the message's `send_id`, so a retry never sends twice.
 */

/** A chat as a key: the agent and the conversation. */
export interface ChatKey {
  agent_id: string;
  conversation_id: string;
}

/** Where the suggestions are kept: the chat records in this Mac's stores (daemon/kernel's ChatInfo). */
export interface SuggestionRecords {
  /** A chat's suggestions, settled ones included, and whether it is archived; null when there is no such chat here. */
  read(agentId: string, conversationId: string): Promise<{ suggestions: Suggestion[]; archived: boolean } | null>;
  write(agentId: string, conversationId: string, suggestions: Suggestion[]): Promise<void>;
}

/** A chat as a suggestion's target finds it in the lists (this Mac's and the paired Macs'). */
export interface TargetChat {
  title: string | null;
  status: DeskStatus;
  has_draft: boolean;
}

/** The chat frames a suggestion's action sends, answered by the Mac their chat lives on. */
export type ChatCall =
  | { type: "chat_send"; agent_id: string; conversation_id: string; text: string; images: never[]; send_id: string; context: string | null }
  | { type: "chat_create"; agent_id: string; cwd: string; title: string; home?: string }
  | { type: "chat_update"; agent_id: string; conversation_id: string; archived?: boolean; draft?: SavedDraft };

/** How a chat frame ended: the reply of the Mac that answered it, or why it did not go. */
export type CallOutcome = { ok: true; reply: Record<string, unknown> } | { ok: false; message: string };

/** What the suggestions are built from. `now` and `newId` exist for tests. */
export interface SuggestionsOptions {
  records: SuggestionRecords;
  /** A chat as the lists know it now; null when no Mac lists it. */
  chat(ref: ChatKey): TargetChat | null;
  agentExists(agentId: string): boolean;
  /** The Mac an agent lives on, which a new chat for it must be made on (R12, AE4); null when its record names none. */
  agentHome?(agentId: string): string | null;
  /** A chat frame sent where its chat lives, here or on a paired Mac, awaited (chatCaller below). */
  call(frame: ChatCall): Promise<CallOutcome>;
  /** Tell every client what happened in a chat, as the daemon's chat events do. */
  push(agentId: string, conversationId: string, events: ChatEvent[]): void;
  /** An analytics event the suggestions caused on their own (made, withdrawn by its agent). */
  track?(event: string, properties: Record<string, unknown>): void;
  now?(): Date;
  newId?(): string;
}

/** What an action left: the suggestion as it now stands, whether the action took, and why not when it did not. */
export interface Decided {
  suggestion: Suggestion;
  done: boolean;
  message: string | null;
}

/** A suggestion as an agent makes it (U3's suggestion_create): its title, the message, and where it goes. */
export interface SuggestionInput {
  title: string;
  text: string;
  target: SuggestionTarget;
}

/** Why a draft is refused where it was to be saved: the chat holds another suggestion's (KTD7). */
const HELD_WORDS = `${DRAFT_HELD}: send it there first, or pick another chat`;

/** A send or a draft that threw before it was settled: it is pending again, and the send_id keeps a retry single. */
const UNFINISHED = "that did not finish: try again";

/** A suggestion left sending by a daemon that stopped before it was settled. */
const INTERRUPTED = "interrupted: try again";

/**
 * A chat's title as it is quoted inside the context's system reminder: no angle brackets or double quotes, which could
 * close the reminder or the quote, on one line and not too long.
 */
const quotable = (title: string) => {
  const plain = title.replace(/[<>"]/g, "").replace(/\s+/g, " ").trim();
  return plain.length > 80 ? `${plain.slice(0, 79)}…` : plain || "another chat";
};

/** The statuses that still show in the chat screen: waiting on the person, or being carried out. */
const isOpen = (s: Suggestion) => s.status === "pending" || s.status === "sending";

/** Who settled a suggestion, as a refused action says it. */
const byWords = (by: string | null | undefined) => (by === "phone" || by === "desktop" ? `the ${by}` : by || "another device");

/** What a second action is told: what already happened, and where (R17). */
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

/** The suggestions of every chat on this Mac, and the person's actions on them. */
export class Suggestions {
  private readonly opts: SuggestionsOptions;
  /** One change at a time per chat: the tail of each chat's queue of changes. */
  private readonly locks = new Map<string, Promise<unknown>>();
  /** The suggestions this process is sending now; one stored as sending that is not here was left by a daemon that stopped. */
  private readonly inFlight = new Set<string>();

  constructor(opts: SuggestionsOptions) {
    this.opts = opts;
  }

  /**
   * A new suggestion in a chat, pending. Only its shape is checked: whether its target can take it is asked when it
   * is sent (R16). A suggestion in an archived chat brings the chat back, so it has a screen to show in (R15).
   * `options.id` is the caller's own id for it: when the chat already holds a suggestion with that id, that one is
   * returned and nothing is added, so a repeated add (a move of Tasks run again) makes no second one.
   */
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

  /** A chat's suggestions, settled ones included, oldest first. */
  async list(source: ChatKey): Promise<Suggestion[]> {
    return (await this.record(source)).suggestions;
  }

  /** A chat's suggestions that still show in its screen, as a client opening it replays them. */
  async open(source: ChatKey): Promise<Suggestion[]> {
    return (await this.list(source)).filter(isOpen);
  }

  /** The agent takes back a suggestion the person has not acted on (U3's suggestion_withdraw). */
  async withdraw(source: ChatKey, id: string): Promise<Decided> {
    const out = await this.settle(source, id, "withdrawn", "agent");
    this.opts.track?.("suggestion_decided", { action: "withdraw", outcome: out.done ? "done" : "refused", by: "agent" });
    return out;
  }

  /** The person points a pending suggestion at another chat (R4); a new chat made for the old target is left as it is. */
  async retarget(source: ChatKey, id: string, target: SuggestionTarget): Promise<Decided> {
    return this.change(source, id, (s) => {
      if (s.status !== "pending") return { done: false, message: settledWords(s) };
      const same = JSON.stringify(s.target) === JSON.stringify(target);
      return { done: true, message: null, next: { ...s, target, reason: null, ...(same ? {} : { made_conversation_id: null }) } };
    });
  }

  /** The person's action on a suggestion: send it now, save it as a draft in its target's box, or reject it (R3). */
  async decide(source: ChatKey, id: string, action: SuggestionAction, by: string): Promise<Decided> {
    if (action === "reject") return this.settle(source, id, "rejected", by);
    const flight = `${source.agent_id}/${source.conversation_id}/${id}`;
    // A field rather than a local, as the claim sets it inside the change.
    const mine = { claimed: false };
    let claim: Decided;
    // Claimed in one step: from here a second action is told it is under way.
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
      // Whatever throws on the way leaves it pending again rather than sending for good.
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

  /** Why a target cannot take the suggestion now, asking the person for another chat (R16); null when it can. */
  private unfit(target: SuggestionTarget, action: SuggestionAction): string | null {
    if (!this.opts.agentExists(target.agent_id)) return "the agent this was for is gone: pick another chat";
    if (!("conversation_id" in target)) return null;
    const chat = this.opts.chat(target);
    if (!chat || chat.status === "deleted" || chat.status === "none") return "the chat this was for is gone: pick another chat";
    if (chat.status === "archived") return "the chat this was for is archived: pick another chat";
    // A saved draft is never replaced (KTD7): the person decides what happens to the one waiting there.
    if (action === "draft" && chat.has_draft) return HELD_WORDS;
    return null;
  }

  /**
   * Carry out a send or a draft for a suggestion now being sent: make its new chat first when it has none yet, and
   * keep that chat's id on the suggestion before anything goes there, so a retry never makes a second one (KTD3).
   */
  private async carry(source: ChatKey, s: Suggestion, action: "send" | "draft"): Promise<{ ok: true } | { ok: false; message: string }> {
    let conversationId: string;
    if ("conversation_id" in s.target) conversationId = s.target.conversation_id;
    else if (s.made_conversation_id) conversationId = s.made_conversation_id;
    else {
      const home = this.opts.agentHome?.(s.target.agent_id) ?? null;
      // Its agent's Mac named, so a Mac out of reach refuses rather than the chat being made here instead (AE4).
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
      // A loki from before plan 049 drops the draft and still says done; only one that names the draft has kept it.
      return out.reply.draft_suggestion_id === s.id
        ? { ok: true }
        : { ok: false, message: "that chat's Mac runs an older loki: send it instead, or pick another chat" };
    }
    // No steer: a chat mid-turn takes it after the turn, as it would a message typed there (AE1).
    const out = await this.opts.call({ type: "chat_send", ...target, text: s.text, images: [], send_id: s.id, context: this.context(source, s) });
    if (!out.ok) return out;
    return out.reply.accepted === false ? { ok: false, message: "the chat did not take the message: try again" } : { ok: true };
  }

  /**
   * What rides with a sent suggestion in `chat_send`'s context (KTD6): the mark the transcript links back from, and
   * one sentence telling the agent where the message came from.
   */
  private context(source: ChatKey, s: Suggestion): string {
    const title = quotable(this.opts.chat(source)?.title ?? "");
    return [
      suggestedMark({ from_agent: source.agent_id, from_chat: source.conversation_id, title: s.title }),
      `<system-reminder>The person sent this message from a suggestion an agent made in the chat "${title}".</system-reminder>`,
    ].join("\n");
  }

  /** Settle a pending suggestion as rejected or withdrawn, by whom; anything else is told what already happened. */
  private settle(source: ChatKey, id: string, status: "rejected" | "withdrawn", by: string): Promise<Decided> {
    return this.change(source, id, (s) =>
      s.status === "pending"
        ? { done: true, message: null, next: { ...s, status, reason: null, decided_by: by, decided_at: this.now() } }
        : { done: false, message: settledWords(s) },
    );
  }

  /**
   * One suggestion changed under its chat's lock: `fn` sees it as stored and says whether the action took and what
   * it becomes (`next`, when anything changes). Every change is written and told to every client.
   */
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

  /** A chat's record, with any suggestion a stopped daemon left sending read as pending again, its made chat kept. */
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

  /** Run `work` after every earlier change to the chat, so a read and its write are never split by another's. */
  private locked<T>(source: ChatKey, work: () => Promise<T>): Promise<T> {
    const key = `${source.agent_id}/${source.conversation_id}`;
    const run = (this.locks.get(key) ?? Promise.resolve()).then(work, work);
    const tail = run.then(
      () => {},
      () => {},
    );
    this.locks.set(key, tail);
    void tail.then(() => {
      if (this.locks.get(key) === tail) this.locks.delete(key);
    });
    return run;
  }

  private now(): string {
    return (this.opts.now?.() ?? new Date()).toISOString();
  }
}

/** What a chat frame from a suggestion goes through: the router's view of where chats live, and this Mac's backend. */
export interface ChatCallerOptions {
  route: Pick<ChatRouter, "target" | "forward">;
  backend: Pick<ChatBackend, "send" | "create" | "update">;
  /** Why a chat takes no message now (it is moving to another Mac), or null. */
  blocked?: (agentId: string, conversationId: string) => string | null;
}

/**
 * A chat frame sent where its chat lives and awaited (KTD3): to the paired Mac the router names, as a request whose
 * reply (or failure) comes back, or answered by this Mac's backend. A new chat goes to its `home`, or its agent's.
 */
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
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  };
}

/** A chat frame answered by this Mac's backend, parsed by the frame table as one from a client would be. */
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

/**
 * The chat backend with each opened chat's open suggestions in the state it opens with, so a client that opens a chat
 * late sees them as one that was listening does. Every other call goes to the backend as it is.
 */
export function withSuggestionsOnOpen(backend: ChatBackend, suggestions: Pick<Suggestions, "open">): ChatBackend {
  const open = async (agentId: string, conversationId: string, mode: string | null): Promise<ChatState> => {
    const state = await backend.open(agentId, conversationId, mode);
    // A chat with no record here (one moving away) opens without them rather than not at all.
    const open = await suggestions.open({ agent_id: agentId, conversation_id: conversationId }).catch(() => null);
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

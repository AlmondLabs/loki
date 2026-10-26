import type { Conversation } from "@earendil-works/pi-durable";
import type { ChatState, PayloadOf } from "../core/frames.ts";
import type { AgentStore, ChatEngine } from "./kernel/index.ts";

/** One chat as an engine is handed it: its ids, its agent's store and conversation, and its saved engine (null: loki's). */
export interface EngineChat {
  agentId: string;
  conversationId: string;
  store: AgentStore;
  chat: Conversation;
  engine: ChatEngine | null;
}

/** How a message loki delivered fared: its turn's end, once the turn is over (plan 037). */
export interface Delivery {
  outcome: Promise<{ status: "done" | "unanswered"; reason?: string }>;
}

/**
 * What a chat runs on (glossary: Engine), as the daemon's chats drive it: loki's own engine on pi-durable
 * (daemon/loki-engine.ts) or an ACP agent (daemon/acp/engine.ts). The daemon's chats (daemon/chat-backend.ts) find each
 * chat's engine, and decide when a chat may move to another; everything that differs between the two lives behind
 * this interface, so no caller asks which one a chat is on.
 */
export interface Engine {
  /** A client opens the chat: its mode set when one is given, and from now on its events go to every client. */
  open(c: EngineChat, mode: string | null): Promise<ChatState>;
  /** Whether a turn is running, or waits on the person. */
  busy(c: EngineChat): Promise<boolean>;
  /** The person's message, after every mod's transform where the engine runs them. */
  send(c: EngineChat, p: PayloadOf<"chat_send">): Promise<void>;
  /**
   * A message from loki itself; `steer` puts it into a running turn where the engine can. Resolves once it is handed
   * over, with how its turn ends where the engine can tell (loki's own; null for an ACP agent's), for a schedule that
   * tries again after a model error (plan 037).
   */
  deliver(c: EngineChat, text: string, whenBusy: "steer" | "followUp"): Promise<Delivery | null>;
  abort(c: EngineChat): Promise<void>;
  /** The chat's working folder, changed; refused where the engine cannot move a running session. */
  folder(c: EngineChat, cwd: string): Promise<ChatState>;
  /** The chat's model and effort on this engine, the chat moved onto it first when it ran on the other. */
  setModel(c: EngineChat, p: PayloadOf<"chat_model">, started: boolean): Promise<void>;
  /** The chat moves to the other engine, before its first message: this one lets it go. */
  leave(c: EngineChat): Promise<void>;
  /** A slash command other than loki's passes (/reflect, /doctor), run the engine's way. */
  command(c: EngineChat, p: PayloadOf<"chat_command">): Promise<{ success: boolean; output: string }>;
}

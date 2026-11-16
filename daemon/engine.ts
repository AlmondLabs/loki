import type { Conversation } from "@earendil-works/pi-durable";
import type { ChatState, PayloadOf } from "../core/frames.ts";
import type { AgentStore, ChatEngine } from "./kernel/index.ts";

export interface EngineChat {
  agentId: string;
  conversationId: string;
  store: AgentStore;
  chat: Conversation;
  engine: ChatEngine | null;
}

export interface Delivery {
  outcome: Promise<{ status: "done" | "unanswered"; reason?: string }>;
}

export interface Engine {
  open(c: EngineChat, mode: string | null): Promise<ChatState>;
  busy(c: EngineChat): Promise<boolean>;
  send(c: EngineChat, p: PayloadOf<"chat_send">): Promise<void>;
  deliver(c: EngineChat, text: string, whenBusy: "steer" | "followUp"): Promise<Delivery | null>;
  abort(c: EngineChat): Promise<void>;
  folder(c: EngineChat, cwd: string): Promise<ChatState>;
  setModel(c: EngineChat, p: PayloadOf<"chat_model">, started: boolean): Promise<void>;
  leave(c: EngineChat): Promise<void>;
  command(c: EngineChat, p: PayloadOf<"chat_command">): Promise<{ success: boolean; output: string }>;
}

export function engineMoveRefused(current: ChatEngine | null, wanted: string | null, started: boolean): string | null {
  const moves = wanted !== null ? current?.agent !== wanted : current !== null;
  if (!moves || !started) return null;
  return wanted !== null
    ? "this chat has started on another engine; start a new chat to use this one"
    : "this chat has started on an ACP agent; start a new chat to use loki's models";
}

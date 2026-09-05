/**
 * Canvas chat — sends into the LIVE conversation so the canvas and the app
 * window share ONE transcript. No forking (deliberate product call): if the
 * conversation is mid-turn, the message is QUEUED and flushed on turn_end.
 * Trade-off accepted: the reply arrives aggregated, not streamed, because the
 * app's turn loop is the primary stream consumer.
 */

import type { ConversationHandle } from "./letta-types.ts";
import { stripHarnessMarkup } from "../shared/harness.ts";
export type { ConversationHandle };

export interface ChatHistoryMessage {
  role: "user" | "assistant" | "tool" | "event";
  text: string;
  summary?: string | null;
  detail?: string | null;
}

export type ChatFrame =
  | { type: "chat_state"; state: "thinking" | "streaming" | "idle" }
  | { type: "chat_delta"; text: string }
  | { type: "chat_done" }
  | { type: "chat_error"; message: string };

export interface ChatBridge {
  /** Handle one user message; frames go to `emit` as they happen. */
  send(text: string, emit: (frame: ChatFrame) => void): Promise<void>;
  /** turn_start: a turn began — cancel any pending flush. */
  onMainBusy(): void;
  /** turn_end: a turn ended — schedule a debounced flush of the queue. */
  onMainIdle(): void;
  busy(): boolean;
  /** Conversation history mapped for the canvas chat window. */
  history(limit?: number): Promise<ChatHistoryMessage[]>;
}

export interface ChatBridgeOptions {
  getConversation: () => ConversationHandle | null;
  /** Is the main conversation mid-turn right now? (tracked via turn events) */
  isMainBusy: () => boolean;
}

/**
 * Shared-transcript chat, no forking. Sends into the live conversation only
 * when it is genuinely idle. A tool call produces a brief turn_end/turn_start
 * gap; sending in that gap would interrupt the tool call ("Turn did not
 * complete"). So a queued message is flushed only after a debounce with NO new
 * turn starting — turn_start cancels the pending flush. One send in flight.
 */
const FLUSH_DEBOUNCE_MS = 1200;

export function createChatBridge({ getConversation, isMainBusy }: ChatBridgeOptions): ChatBridge {
  let inFlight = false;
  let queued: { text: string; emit: (frame: ChatFrame) => void } | null = null;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  const cancelFlush = () => {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
  };

  const deliver = async (text: string, emit: (frame: ChatFrame) => void): Promise<void> => {
    const source = getConversation();
    if (!source) {
      emit({
        type: "chat_error",
        message: "no conversation captured yet — run /canvas from a conversation once",
      });
      emit({ type: "chat_state", state: "idle" });
      return;
    }

    inFlight = true;
    emit({ type: "chat_state", state: "thinking" });
    try {
      const stream = await source.sendMessageStream([{ role: "user", content: text }]);
      let streamed = false;
      for await (const chunk of stream) {
        const delta = assistantTextFromChunk(chunk);
        if (delta) {
          if (!streamed) {
            streamed = true;
            emit({ type: "chat_state", state: "streaming" });
          }
          emit({ type: "chat_delta", text: delta });
        }
      }
      emit({ type: "chat_done" });
    } catch (err) {
      emit({ type: "chat_error", message: err instanceof Error ? err.message : String(err) });
    } finally {
      inFlight = false;
      emit({ type: "chat_state", state: "idle" });
    }
  };

  return {
    busy: () => inFlight,

    async send(text, emit) {
      if (inFlight) {
        emit({ type: "chat_error", message: "still thinking — one message at a time" });
        return;
      }
      // Never send into a busy conversation; queue and flush on turn_end.
      if (isMainBusy()) {
        if (queued) {
          emit({ type: "chat_error", message: "a message is already queued for when this turn ends" });
          return;
        }
        queued = { text, emit };
        emit({ type: "chat_state", state: "thinking" });
        return;
      }
      await deliver(text, emit);
    },

    onMainBusy() {
      // A turn started (possibly just a tool-call continuation) — do not flush
      // into it; wait for a real settled idle.
      cancelFlush();
    },

    onMainIdle() {
      cancelFlush();
      if (!queued) return;
      // Only flush if no new turn starts during the debounce window, and the
      // conversation is actually idle when the timer fires.
      flushTimer = setTimeout(() => {
        flushTimer = null;
        if (queued && !inFlight && !isMainBusy()) {
          const { text, emit } = queued;
          queued = null;
          void deliver(text, emit);
        }
      }, FLUSH_DEBOUNCE_MS);
    },

    async history(limit = 100) {
      const source = getConversation();
      if (!source?.getHistory) return [];
      try {
        const messages = await source.getHistory({ limit, order: "asc" });
        return messagesToChatHistory(messages);
      } catch {
        return [];
      }
    },
  };
}

/** Map raw conversation messages to canvas chat entries (text turns only). */
export function messagesToChatHistory(
  messages: Array<Record<string, unknown>>,
): ChatHistoryMessage[] {
  const out: ChatHistoryMessage[] = [];
  for (const m of messages) {
    if (m.message_type === "user_message") {
      const text = stripSystemTags(textFromContent(m.content)).trim();
      if (text) out.push({ role: "user", text });
    } else if (m.message_type === "assistant_message") {
      const text = textFromContent(m.content).trim();
      if (text) out.push({ role: "assistant", text });
    }
  }
  return out;
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const part of content) {
    if (
      typeof part === "object" &&
      part !== null &&
      (part as { type?: string }).type === "text" &&
      typeof (part as { text?: unknown }).text === "string"
    ) {
      out += (part as { text: string }).text;
    }
  }
  return out;
}

/** Drop harness machinery (system reminders/alerts, our own desk context) from user-visible text. */
function stripSystemTags(text: string): string {
  return stripHarnessMarkup(text);
}
export { stripHarnessMarkup, decodeEntities, extractHarnessEvents } from "../shared/harness.ts";

/** Extract assistant text from a stream chunk (string or parts content). */
export function assistantTextFromChunk(chunk: Record<string, unknown>): string {
  if (chunk.message_type !== "assistant_message") return "";
  const content = chunk.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const part of content) {
    if (
      typeof part === "object" &&
      part !== null &&
      (part as { type?: string }).type === "text" &&
      typeof (part as { text?: unknown }).text === "string"
    ) {
      out += (part as { text: string }).text;
    }
  }
  return out;
}

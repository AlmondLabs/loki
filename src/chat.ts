/**
 * Canvas chat — sends into the LIVE conversation so the canvas and the app
 * window share ONE transcript. No forking (deliberate product call): if the
 * conversation is mid-turn, the message is QUEUED and flushed on turn_end.
 * Trade-off accepted: the reply arrives aggregated, not streamed, because the
 * app's turn loop is the primary stream consumer.
 */

export interface ConversationHandle {
  id: string | null;
  sendMessageStream(
    messages: Array<{ role: "user"; content: string }>,
    options?: Record<string, unknown>,
  ): Promise<AsyncIterable<Record<string, unknown>>>;
  getHistory?(options?: {
    limit?: number;
    order?: "asc" | "desc";
  }): Promise<Array<Record<string, unknown>>>;
}

export interface ChatHistoryMessage {
  role: "user" | "assistant";
  text: string;
}

export type ChatFrame =
  | { type: "chat_state"; state: "thinking" | "streaming" | "idle" }
  | { type: "chat_delta"; text: string }
  | { type: "chat_done" }
  | { type: "chat_error"; message: string };

export interface ChatBridge {
  /** Handle one user message; frames go to `emit` as they happen. */
  send(text: string, emit: (frame: ChatFrame) => void): Promise<void>;
  /** Called on turn_end so any message queued while busy can now go out. */
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
 * Always sends into the live conversation (shared transcript, no forking).
 * If the conversation is mid-turn, the message is queued and flushed when the
 * turn ends. One in-flight send at a time.
 */
export function createChatBridge({ getConversation, isMainBusy }: ChatBridgeOptions): ChatBridge {
  let inFlight = false;
  let queued: { text: string; emit: (frame: ChatFrame) => void } | null = null;

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

    onMainIdle() {
      if (queued && !inFlight) {
        const { text, emit } = queued;
        queued = null;
        void deliver(text, emit);
      }
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

/** Drop harness machinery (system reminders/alerts) from user-visible text. */
function stripSystemTags(text: string): string {
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .replace(/<system-alert>[\s\S]*?<\/system-alert>/g, "");
}

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

/**
 * Canvas chat — runs on a hidden fork of the active conversation (the
 * supported streaming path; direct sends to the live conversation bypass
 * the app's turn loop). One fork per activation, created lazily on the
 * first message so it inherits current conversation context.
 */

export interface ConversationHandle {
  id: string | null;
  fork(options?: { hidden?: boolean }): Promise<ConversationHandle>;
  sendMessageStream(
    messages: Array<{ role: "user"; content: string }>,
    options?: Record<string, unknown>,
  ): Promise<AsyncIterable<Record<string, unknown>>>;
  updateTitle?(title: string): Promise<unknown>;
}

export type ChatFrame =
  | { type: "chat_state"; state: "thinking" | "streaming" | "idle" }
  | { type: "chat_delta"; text: string }
  | { type: "chat_done" }
  | { type: "chat_error"; message: string };

export interface ChatBridge {
  /** Handle one user message; frames go to `emit` as they happen. */
  send(text: string, emit: (frame: ChatFrame) => void): Promise<void>;
  busy(): boolean;
}

export interface ChatBridgeOptions {
  getConversation: () => ConversationHandle | null;
  /** Is the main conversation mid-turn right now? (tracked via turn events) */
  isMainBusy: () => boolean;
}

/**
 * Chat mode: send directly into the LIVE conversation when it's idle, so the
 * canvas and the app window share one transcript. Fall back to a labeled fork
 * while the main conversation is mid-turn (direct sends would conflict).
 */
export function createChatBridge({ getConversation, isMainBusy }: ChatBridgeOptions): ChatBridge {
  let forked: ConversationHandle | null = null;
  let inFlight = false;

  return {
    busy: () => inFlight,

    async send(text, emit) {
      if (inFlight) {
        emit({ type: "chat_error", message: "still thinking — one message at a time" });
        return;
      }
      const source = getConversation();
      if (!source) {
        emit({
          type: "chat_error",
          message: "no conversation captured yet — run /canvas from a conversation once",
        });
        return;
      }

      inFlight = true;
      emit({ type: "chat_state", state: "thinking" });
      try {
        let target: ConversationHandle;
        if (!isMainBusy()) {
          target = source; // same conversation, same transcript
        } else {
          if (!forked) {
            forked = await source.fork({ hidden: true });
            // Sidebars may list the fork even when hidden — label it clearly.
            await forked.updateTitle?.("loci · canvas chat").catch?.(() => {});
          }
          target = forked;
        }
        const stream = await target.sendMessageStream([{ role: "user", content: text }]);

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
        // A dead fork (e.g. deleted conversation) shouldn't wedge chat forever.
        forked = null;
        emit({
          type: "chat_error",
          message: err instanceof Error ? err.message : String(err),
        });
      } finally {
        inFlight = false;
        emit({ type: "chat_state", state: "idle" });
      }
    },
  };
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

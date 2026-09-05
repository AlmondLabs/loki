import type { Scope } from "../shared/desk-core.ts";
import type { ChatBridge, ChatFrame, ChatHistoryMessage } from "./chat.ts";

/**
 * What the WS bridge needs from a chat implementation. Frames reach tabs
 * through `broadcast(frame, scope)`, not through the send call, so a live
 * mirror (app-server) and a request/response bridge (conversation handle)
 * look the same to the canvas.
 */
export type ChatOutFrame =
  | ChatFrame
  | { type: "chat_user"; text: string }
  | { type: "chat_tool"; text: string }
  | { type: "chat_history"; messages: ChatHistoryMessage[] };

export interface ChatTransport {
  readonly mode: "app-server" | "conversation-handle";
  /** A tab for `scope` connected. Start mirroring if the desk is bound to a conversation. */
  attach(scope: Scope): Promise<void>;
  /** A canvas user typed `text` on desk `scope`. */
  send(scope: Scope, text: string): Promise<void>;
  history(scope: Scope): Promise<ChatHistoryMessage[]>;
}

/** The v1 path: direct sends on the captured conversation handle, replies as a block. */
export function createLegacyChatTransport(
  chat: ChatBridge,
  broadcast: (frame: ChatOutFrame, scope: Scope) => void,
): ChatTransport {
  return {
    mode: "conversation-handle",
    async attach() {},
    async send(scope, text) {
      await chat.send(text, (frame) => broadcast(frame, scope));
    },
    history: () => chat.history(),
  };
}

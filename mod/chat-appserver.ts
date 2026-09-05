import type { Scope } from "../shared/desk-core.ts";
import { scopeFor } from "../shared/desk-core.ts";
import type { AppServerClient, AppServerEvent, Runtime } from "./app-server.ts";
import { deltaText } from "./app-server.ts";
import type { ChatHistoryMessage } from "./chat.ts";
import { stripHarnessMarkup } from "./chat.ts";
import type { ChatOutFrame, ChatTransport } from "./chat-transport.ts";
import type { DeskRegistry } from "./desks.ts";
import { log } from "./log.ts";

/**
 * Live mirror of a desk's conversation through the app-server. Every turn on
 * the conversation — typed in Desktop, sent from the canvas, or started by a
 * schedule — streams to the tabs showing that desk. Canvas messages go in as
 * ordinary user input; Letta queues them if a turn is running.
 */
export interface AppServerChatDeps {
  client: Pick<AppServerClient, "on" | "runtimeStart" | "isSubscribed" | "sendUserMessage">;
  desks: Pick<DeskRegistry, "get">;
  broadcast: (frame: ChatOutFrame, scope: Scope) => void;
  /** Transcript for a desk, for hydration on connect. */
  history: (scope: Scope) => Promise<ChatHistoryMessage[]>;
  cwd?: string;
}

const IDLE = "WAITING_ON_INPUT";

export function createAppServerChat(deps: AppServerChatDeps): ChatTransport {
  const streaming = new Set<Scope>();
  const thinking = new Set<Scope>();
  /** Texts we submitted ourselves, so their echo as user_message is not shown twice. */
  const ownSends = new Map<Scope, string[]>();
  /** Tool calls already announced per desk (a call streams as several deltas). */
  const toolsSeen = new Map<Scope, Set<string>>();

  const emit = (scope: Scope, frame: ChatOutFrame) => deps.broadcast(frame, scope);

  const setIdle = (scope: Scope) => {
    if (streaming.has(scope)) emit(scope, { type: "chat_done" });
    streaming.delete(scope);
    thinking.delete(scope);
    emit(scope, { type: "chat_state", state: "idle" });
  };
  const setThinking = (scope: Scope) => {
    if (streaming.has(scope) || thinking.has(scope)) return;
    thinking.add(scope);
    emit(scope, { type: "chat_state", state: "thinking" });
  };

  deps.client.on((ev: AppServerEvent) => {
    const conv = ev.runtime?.conversation_id;
    if (!conv || !ev.runtime || !deps.client.isSubscribed(ev.runtime)) return; // only desks we mirror
    const scope = scopeFor(conv, ev.runtime.agent_id);
    switch (ev.type) {
      case "stream_delta": {
        const d = ev.delta as Record<string, unknown> | undefined;
        const mt = d?.message_type;
        if (mt === "assistant_message") {
          const text = deltaText(d);
          if (!text) return;
          if (!streaming.has(scope)) {
            streaming.add(scope);
            thinking.delete(scope);
            emit(scope, { type: "chat_state", state: "streaming" });
          }
          emit(scope, { type: "chat_delta", text });
        } else if (mt === "user_message") {
          const text = stripHarnessMarkup(deltaText(d)).trim();
          if (!text) return;
          const own = ownSends.get(scope) ?? [];
          const i = own.indexOf(text);
          if (i >= 0) {
            own.splice(i, 1);
            return; // already shown when it was sent
          }
          // A new user turn ends the previous assistant message.
          if (streaming.has(scope)) {
            streaming.delete(scope);
            emit(scope, { type: "chat_done" });
          }
          emit(scope, { type: "chat_user", text });
          setThinking(scope);
        } else if (mt === "reasoning_message" || mt === "tool_call_message" || mt === "approval_request_message") {
          if (streaming.has(scope)) {
            // assistant text may resume after a tool call; close this bubble
            streaming.delete(scope);
            emit(scope, { type: "chat_done" });
          }
          setThinking(scope);
          if (mt === "tool_call_message" || mt === "approval_request_message") {
            const tc = d?.tool_call as { name?: string; tool_call_id?: string } | undefined;
            const key = tc?.tool_call_id ?? (tc?.name ? `${tc.name}:${Date.now()}` : null);
            if (tc?.name && key) {
              const seen = toolsSeen.get(scope) ?? new Set<string>();
              if (!seen.has(key)) {
                seen.add(key);
                toolsSeen.set(scope, seen);
                emit(scope, { type: "chat_tool", text: tc.name });
              }
            }
          }
        }
        return;
      }
      case "update_loop_status": {
        const status = (ev.loop_status as { status?: string } | undefined)?.status;
        if (status === IDLE) setIdle(scope);
        else if (status) setThinking(scope);
        return;
      }
      case "turn_finished":
        setIdle(scope);
        return;
      default:
        return;
    }
  });

  const ensure = async (scope: Scope): Promise<Runtime | null> => {
    const rt = deps.desks.get(scope);
    if (!rt) return null;
    if (!deps.client.isSubscribed(rt)) {
      await deps.client.runtimeStart(rt, deps.cwd);
      log("chat:subscribed", { scope, ...rt });
    }
    return rt;
  };

  return {
    mode: "app-server",
    async attach(scope) {
      try {
        const rt = await ensure(scope);
        if (!rt) log("chat:attach:unbound", { scope });
      } catch (err) {
        log("chat:attach:error", { scope, error: err instanceof Error ? err.message : String(err) });
        emit(scope, { type: "chat_error", message: `could not attach to conversation: ${err instanceof Error ? err.message : String(err)}` });
      }
    },
    async send(scope, text) {
      const rt = await ensure(scope).catch((err) => {
        emit(scope, { type: "chat_error", message: err instanceof Error ? err.message : String(err) });
        return null;
      });
      if (!rt) {
        emit(scope, { type: "chat_error", message: "this desk is not bound to a conversation yet — run /canvas from the conversation once" });
        return;
      }
      const own = ownSends.get(scope) ?? [];
      own.push(text.trim());
      if (own.length > 10) own.shift();
      ownSends.set(scope, own);
      setThinking(scope);
      try {
        const res = await deps.client.sendUserMessage(rt, text);
        log("chat:sent", { scope, ...res });
        if (!res.accepted) {
          emit(scope, { type: "chat_error", message: "the conversation did not accept the message" });
          setIdle(scope);
        }
      } catch (err) {
        emit(scope, { type: "chat_error", message: err instanceof Error ? err.message : String(err) });
        setIdle(scope);
      }
    },
    history: (scope) => deps.history(scope),
  };
}

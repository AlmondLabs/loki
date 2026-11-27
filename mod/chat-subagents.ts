import type { ChatEvent } from "../core/attention/model.ts";
import { messageOf } from "../core/errors.ts";
import type { ChatState } from "../core/frames.ts";
import { isSubagentChat, parentChatOfSubagent, type SubagentView } from "../core/subagents.ts";
import type { ChatBackend } from "./frames/chat.ts";
import { log } from "./log.ts";

type Push = (agentId: string, chatId: string, events: ChatEvent[]) => void;

const TURNS: ReadonlySet<ChatEvent["kind"]> = new Set(["loop", "turn_end"]);

export function withSubagentsOnOpen(backend: ChatBackend): ChatBackend {
  const open = async (agentId: string, conversationId: string, mode: string | null): Promise<ChatState> => {
    const [state, subagents] = await Promise.all([
      backend.open(agentId, conversationId, mode),
      isSubagentChat(conversationId) ? [] : backend.subagentViews(agentId, conversationId),
    ]);
    return { ...state, subagents };
  };
  return new Proxy(backend, {
    get: (target, prop, receiver) => {
      if (prop === "open") return open;
      const value: unknown = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

export class SubagentStrips {
  private readonly backend: Pick<ChatBackend, "subagentViews" | "onSubagentChange">;
  private readonly push: Push;
  private readonly asked = new Map<string, number>();

  constructor(backend: Pick<ChatBackend, "subagentViews" | "onSubagentChange">, push: Push) {
    this.backend = backend;
    this.push = push;
  }

  start(): () => void {
    return this.backend.onSubagentChange((agentId, chatId) => this.refresh(agentId, chatId));
  }

  heard(agentId: string, conversationId: string, events: readonly ChatEvent[]): void {
    const chatId = parentChatOfSubagent(conversationId);
    if (chatId !== null && events.some((e) => TURNS.has(e.kind))) this.refresh(agentId, chatId);
  }

  private refresh(agentId: string, chatId: string): void {
    const key = `${agentId}/${chatId}`;
    const n = (this.asked.get(key) ?? 0) + 1;
    this.asked.set(key, n);
    this.backend.subagentViews(agentId, chatId).then(
      (subagents: SubagentView[]) => {
        if (this.asked.get(key) === n) this.push(agentId, chatId, [{ kind: "subagents", subagents }]);
      },
      (err: unknown) => log.error("subagent:views-failed", { chat: chatId, error: messageOf(err) }),
    );
  }
}

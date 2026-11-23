import { advisedChat, isAdvisorChat, type AdvisorView } from "../core/advisor.ts";
import type { ChatEvent } from "../core/attention/model.ts";
import { messageOf } from "../core/errors.ts";
import type { ChatState } from "../core/frames.ts";
import type { ChatBackend } from "./frames/chat.ts";
import { log } from "./log.ts";

type Push = (agentId: string, chatId: string, events: ChatEvent[]) => void;

const TURNS: ReadonlySet<ChatEvent["kind"]> = new Set(["loop", "turn_end"]);

export function withAdvisorOnOpen(backend: ChatBackend): ChatBackend {
  const open = async (agentId: string, conversationId: string, mode: string | null): Promise<ChatState> => {
    const [state, advisor] = await Promise.all([
      backend.open(agentId, conversationId, mode),
      isAdvisorChat(conversationId) ? null : backend.advisorView(agentId, conversationId),
    ]);
    return { ...state, advisor };
  };
  return new Proxy(backend, {
    get: (target, prop, receiver) => {
      if (prop === "open") return open;
      const value: unknown = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

export class AdvisorStrips {
  private readonly backend: Pick<ChatBackend, "advisorView" | "onAdvisorChange">;
  private readonly push: Push;
  private readonly asked = new Map<string, number>();

  constructor(backend: Pick<ChatBackend, "advisorView" | "onAdvisorChange">, push: Push) {
    this.backend = backend;
    this.push = push;
  }

  start(): () => void {
    return this.backend.onAdvisorChange((agentId, chatId) => this.refresh(agentId, chatId));
  }

  heard(agentId: string, conversationId: string, events: readonly ChatEvent[]): void {
    const chatId = advisedChat(conversationId);
    if (chatId !== null && events.some((e) => TURNS.has(e.kind))) this.refresh(agentId, chatId);
  }

  private refresh(agentId: string, chatId: string): void {
    const key = `${agentId}/${chatId}`;
    const n = (this.asked.get(key) ?? 0) + 1;
    this.asked.set(key, n);
    this.backend.advisorView(agentId, chatId).then(
      (advisor: AdvisorView | null) => {
        if (this.asked.get(key) === n) this.push(agentId, chatId, [{ kind: "advisor", advisor }]);
      },
      (err: unknown) => log("advisor:view-failed", { chat: chatId, error: messageOf(err) }),
    );
  }
}

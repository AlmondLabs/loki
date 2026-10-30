import type { Context } from "@earendil-works/chord";
import type { ChatEvent } from "../../core/attention/model.ts";
import type { ChatState, PayloadOf } from "../../core/frames.ts";
import { modeOf } from "../approvals.ts";
import type { Engine, EngineChat } from "../engine.ts";
import type { ChatEngine } from "../kernel/index.ts";
import { acpHandle } from "./agents.ts";
import type { AcpChats } from "./chats.ts";

/**
 * An ACP agent as a chat's engine (glossary: Engine; plan 020): the daemon's chats drive it as they drive loki's own,
 * and it hands each call to the agent's session (daemon/acp/chats.ts). The agent takes one prompt at a time, so a
 * message sent during a turn waits for it; its modes and its slash commands are its own (KD10).
 */
export class AcpEngine implements Engine {
  private readonly deps: {
    acp: AcpChats;
    context: Context;
    push: (agentId: string, conversationId: string, events: ChatEvent[]) => void;
  };

  constructor(deps: AcpEngine["deps"]) {
    this.deps = deps;
  }

  async open(c: EngineChat, mode: string | null): Promise<ChatState> {
    if (mode !== null) await this.deps.acp.setMode(c.agentId, c.conversationId, mode);
    return this.deps.acp.state(c.agentId, c.conversationId);
  }

  busy(c: EngineChat): Promise<boolean> {
    return Promise.resolve(this.deps.acp.busy(c.agentId, c.conversationId));
  }

  send(c: EngineChat, p: PayloadOf<"chat_send">): Promise<void> {
    this.deps.acp.send(p, engineOf(c));
    return Promise.resolve();
  }

  deliver(c: EngineChat, text: string): Promise<null> {
    this.deps.acp.deliver(c.agentId, c.conversationId, text, engineOf(c));
    return Promise.resolve(null);
  }

  abort(c: EngineChat): Promise<void> {
    this.deps.acp.abort(c.agentId, c.conversationId);
    return Promise.resolve();
  }

  /** An agent's session runs in the folder it was opened in; before its session opens, the chat's folder can change. */
  async folder(c: EngineChat, cwd: string): Promise<ChatState> {
    if (engineOf(c).session_id) throw new Error("this chat runs on an ACP agent in the folder it started in; start a new chat for another folder");
    await c.chat.configure({ cwd }, this.deps.context);
    this.deps.push(c.agentId, c.conversationId, [{ kind: "device", cwd }]);
    return this.deps.acp.state(c.agentId, c.conversationId);
  }

  /** The chat on this agent and model: kept on the chat, set on its session, and the session opened early when nothing was said. */
  async setModel(c: EngineChat, p: PayloadOf<"chat_model">, started: boolean): Promise<void> {
    const wanted = acpHandle(p.handle);
    if (!wanted) throw new Error(`not an ACP model: ${p.handle}`);
    const sameAgent = c.engine?.agent === wanted.agent;
    const next: ChatEngine = {
      kind: "acp",
      agent: wanted.agent,
      model: wanted.model,
      effort: p.reasoning_effort,
      session_id: sameAgent ? (c.engine?.session_id ?? null) : null,
    };
    await c.store.updateChat(c.conversationId, { engine: next }, this.deps.context);
    // A session opened early (`warm`) may be open already, from an earlier pick of this agent.
    await this.deps.acp.setModel(c.agentId, c.conversationId, wanted.model, p.reasoning_effort);
    if (!sameAgent) {
      // The agent's own modes replace loki's: its first until its session says which one it is in.
      const view = this.deps.acp.view(next);
      this.deps.push(c.agentId, c.conversationId, [{ kind: "device", engine: view, ...(view.modes.length ? { mode: view.modes[0].id } : {}) }]);
    }
    // Its session opened now, before anything is said, tells the picker the agent's models and effort levels.
    if (!started) this.deps.acp.warm(c.agentId, c.conversationId, next);
  }

  /** The chat goes back to loki's models, before its first message: loki's permission modes are its own again. */
  async leave(c: EngineChat): Promise<void> {
    await c.store.updateChat(c.conversationId, { engine: null }, this.deps.context);
    const mode = (await c.store.chatInfo(c.chat.id, this.deps.context))?.mode;
    this.deps.push(c.agentId, c.conversationId, [{ kind: "device", engine: null, mode: modeOf(mode) }]);
  }

  /** Every command but loki's passes is the agent's: it goes to the agent as it was typed. */
  command(c: EngineChat, p: PayloadOf<"chat_command">): Promise<{ success: boolean; output: string }> {
    const typed = `/${p.command}${p.args?.trim() ? ` ${p.args.trim()}` : ""}`;
    this.deps.acp.deliver(c.agentId, c.conversationId, typed, engineOf(c));
    return Promise.resolve({ success: true, output: `sent ${typed} to the agent` });
  }
}

/** The chat's ACP engine: the daemon's chats hand this adapter only chats that have one. */
function engineOf(c: EngineChat): ChatEngine {
  if (!c.engine) throw new Error(`chat ${c.conversationId} does not run on an ACP agent`);
  return c.engine;
}

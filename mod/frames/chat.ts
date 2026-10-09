import type { ChatEvent } from "../../core/attention/model.ts";
import type { ChatState, PayloadOf, Replies } from "../../core/frames.ts";
import { errorMessage, fail, reply, type FrameHandlers, type Outcome } from "./context.ts";

/**
 * Chats on loki's daemon (plan 017, U5): what the app asked Letta's app-server for, as frames on the mod's socket.
 * The daemon brings a ChatBackend on the mod's host; under Letta there is none, the app-server serves chats, and
 * every request here answers that it is the daemon's.
 */
export interface ChatBackend {
  /** Tell every socket what happened in a chat; the backend calls it as events arrive. */
  attach(push: (agentId: string, conversationId: string, events: ChatEvent[]) => void): void;
  open(agentId: string, conversationId: string, mode: string | null): Promise<ChatState>;
  approve(p: PayloadOf<"chat_approve">): Promise<boolean>;
  answer(p: PayloadOf<"chat_answer">): Promise<boolean>;
  create(agentId: string, cwd: string | null, title: string | null): Promise<{ agentId: string; conversationId: string }>;
  send(p: PayloadOf<"chat_send">): Promise<boolean>;
  abort(agentId: string, conversationId: string): Promise<void>;
  update(p: PayloadOf<"chat_update">): Promise<void>;
  folder(agentId: string, conversationId: string, cwd: string): Promise<ChatState>;
  model(p: PayloadOf<"chat_model">): Promise<void>;
  models(): Promise<Replies["chat_models"]["entries"]>;
  agents(): Promise<Replies["chat_agents"]["agents"]>;
  createAgent(p: PayloadOf<"chat_agent_create">): Promise<{ id: string; name: string }>;
  updateAgent(p: PayloadOf<"chat_agent_update">): Promise<void>;
  deleteAgent(agentId: string): Promise<void>;
}

export type ChatDeps = { chat?: ChatBackend };

const NOT_HERE = "chats are served by loki's daemon, not this host";
const DONE = {} as Record<never, never>;

/** Run `work` against the backend: its reply, or why not. */
async function served<R>(backend: ChatBackend | undefined, work: (b: ChatBackend) => Promise<R>): Promise<Outcome<R>> {
  if (!backend) return fail(NOT_HERE);
  try {
    return reply(await work(backend));
  } catch (err) {
    return fail(errorMessage(err));
  }
}

export function chatFrames(deps: ChatDeps): FrameHandlers {
  const b = deps.chat;
  return {
    chat_open: ({ agentId, conversationId, mode }) => served(b, (x) => x.open(agentId, conversationId, mode)),
    chat_approve: (p) => served(b, async (x) => ({ accepted: await x.approve(p) })),
    chat_answer: (p) => served(b, async (x) => ({ accepted: await x.answer(p) })),
    chat_create: ({ agentId, cwd, title }) => served(b, (x) => x.create(agentId, cwd, title)),
    chat_send: (p) => served(b, async (x) => ({ accepted: await x.send(p) })),
    chat_abort: ({ agentId, conversationId }) => served(b, async (x) => (await x.abort(agentId, conversationId), DONE)),
    chat_update: (p) => served(b, async (x) => (await x.update(p), DONE)),
    chat_folder: ({ agentId, conversationId, cwd }) => served(b, (x) => x.folder(agentId, conversationId, cwd)),
    chat_model: (p) => served(b, async (x) => (await x.model(p), DONE)),
    chat_models: () => served(b, async (x) => ({ entries: await x.models() })),
    chat_agents: () => served(b, async (x) => ({ agents: await x.agents() })),
    chat_agent_create: (p) => served(b, (x) => x.createAgent(p)),
    chat_agent_update: (p) => served(b, async (x) => (await x.updateAgent(p), DONE)),
    chat_agent_delete: ({ agentId }) => served(b, async (x) => (await x.deleteAgent(agentId), DONE)),
  };
}

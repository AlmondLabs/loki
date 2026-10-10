import type { ChatEvent } from "../../core/attention/model.ts";
import type { ChatState, PayloadOf, Replies } from "../../core/frames.ts";
import { errorMessage, fail, reply, type FrameHandlers, type Outcome } from "./context.ts";

/**
 * Chats on loki's daemon (plan 017, U5), as frames on the mod's socket: the app's FrameChatClient asks, and the
 * daemon's ChatBackend (daemon/chat-backend.ts) on the mod's host answers. A host with no backend (a test that
 * hosts the mod alone) answers every request that chats are the daemon's.
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
  providers(): Promise<Replies["chat_providers"]["providers"]>;
  connectProvider(providerId: string, apiKey: string): Promise<void>;
  disconnectProvider(providerId: string): Promise<void>;
  signIn(providerId: string, code: string | null): Promise<Replies["chat_signin"]>;
  reflection(): Promise<Replies["chat_reflection"]>;
  setReflection(s: PayloadOf<"chat_reflection_set">): Promise<Replies["chat_reflection"]>;
  command(p: PayloadOf<"chat_command">): Promise<Replies["chat_command_done"]>;
  writeMemory(p: PayloadOf<"chat_memory_write">): Promise<void>;
  enableSkill(path: string): Promise<{ name: string; linkPath: string }>;
  disableSkill(name: string): Promise<void>;
  /** One prompt in a hidden chat of loki's own (Learn's writer), its whole reply back (mod/recall-worker.ts). */
  ask(agentId: string, conversationId: string, prompt: string, model: string | null): Promise<string>;
  importLetta(): Promise<Replies["chat_imported"]>;
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
    chat_reflection_get: () => served(b, (x) => x.reflection()),
    chat_import: () => served(b, (x) => x.importLetta()),
    chat_reflection_set: (p) => served(b, (x) => x.setReflection(p)),
    chat_command: (p) => served(b, (x) => x.command(p)),
    chat_skill_enable: ({ path }) => served(b, (x) => x.enableSkill(path)),
    chat_skill_disable: ({ name }) => served(b, async (x) => (await x.disableSkill(name), DONE)),
    chat_memory_write: (p) => served(b, async (x) => (await x.writeMemory(p), DONE)),
    chat_providers: () => served(b, async (x) => ({ providers: await x.providers() })),
    chat_provider_connect: ({ providerId, apiKey }) => served(b, async (x) => (await x.connectProvider(providerId, apiKey), { providers: await x.providers() })),
    chat_provider_disconnect: ({ providerId }) => served(b, async (x) => (await x.disconnectProvider(providerId), { providers: await x.providers() })),
    chat_provider_signin: ({ providerId, code }) => served(b, (x) => x.signIn(providerId, code)),
  };
}

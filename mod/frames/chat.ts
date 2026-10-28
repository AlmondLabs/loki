import type { MovedChat } from "../../daemon/chat-move.ts";
import { missingFor } from "../requirements.ts";
import type { LabelColorsSnapshot } from "../../daemon/labels.ts";
import type { ChatEvent } from "../../core/attention/model.ts";
import type { ChatState, PayloadOf, Replies } from "../../core/frames.ts";
import { errorMessage, fail, reply, type FrameContext, type FrameHandlers, type Outcome } from "./context.ts";

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
  /** `home`: the Mac the person picked for it, which places it when its agent lives elsewhere (plan 023, addendum A2). */
  create(agentId: string, cwd: string | null, title: string | null, home?: string | null): Promise<{ agentId: string; conversationId: string }>;
  send(p: PayloadOf<"chat_send">): Promise<boolean>;
  abort(agentId: string, conversationId: string): Promise<void>;
  /** Its reply names the saved draft's suggestion when it saved one. */
  update(p: PayloadOf<"chat_update">): Promise<Replies["chat_done"]>;
  folder(agentId: string, conversationId: string, cwd: string): Promise<ChatState>;
  model(p: PayloadOf<"chat_model">): Promise<void>;
  models(): Promise<Replies["chat_models"]["entries"]>;
  agents(): Promise<Replies["chat_agents"]["agents"]>;
  createAgent(p: PayloadOf<"chat_agent_create">): Promise<{ id: string; name: string }>;
  updateAgent(p: PayloadOf<"chat_agent_update">): Promise<void>;
  deleteAgent(agentId: string): Promise<void>;
  /** Remove an agent here because another Mac deleted it (plan 023): no tombstone of this Mac's. */
  removeAgent(agentId: string): Promise<void>;
  /** Moving a chat to the Mac its agent lives on (plan 023, U9): which, copying out, writing in, and letting go. */
  moveCandidates(mac: string): Promise<Array<{ agent_id: string; conversation_id: string }>>;
  exportChat(agentId: string, chatId: string): Promise<{ chat: MovedChat | null; busy: boolean }>;
  /** `names`: the Macs it moved between, to mark its thread and tell its agent (plan 023, addendum A5). */
  importChat(moved: MovedChat, names?: { from: string; to: string }): Promise<boolean>;
  finishMove(agentId: string, chatId: string): Promise<void>;
  /** The person's label colours for a paired Mac, and taking that Mac's (plan 023, U8). */
  labelColors(): LabelColorsSnapshot;
  applyLabelColors(theirs: LabelColorsSnapshot): boolean;
  providers(): Promise<Replies["chat_providers"]["providers"]>;
  connectProvider(providerId: string, apiKey: string): Promise<void>;
  disconnectProvider(providerId: string): Promise<void>;
  signIn(providerId: string, code: string | null): Promise<Replies["chat_signin"]>;
  passes(): Promise<Replies["chat_passes"]>;
  setPasses(s: PayloadOf<"chat_passes_set">): Promise<Replies["chat_passes"]>;
  /** Learn's "Run now" (daemon/passes.ts). */
  runLearn(): Promise<void>;
  command(p: PayloadOf<"chat_command">): Promise<Replies["chat_command_done"]>;
  writeMemory(p: PayloadOf<"chat_memory_write">): Promise<void>;
  revertMemory(p: PayloadOf<"chat_memory_revert">): Promise<void>;
  approvals(): Promise<Replies["chat_approvals"]>;
  setApproval(p: PayloadOf<"chat_approvals_set">): Promise<Replies["chat_approvals"]>;
  /** Labels on chats (plan 022): every label with its colour and count, and renaming, recolouring or deleting one. */
  labels(): Promise<Replies["chat_labels"]>;
  setLabel(p: PayloadOf<"chat_label_set">): Promise<Replies["chat_labels"]>;
  /** Settings › Engines (daemon/acp/, plan 020): the ACP agents, and adding, changing, removing and trying one. */
  engines(): Promise<Replies["chat_engines"]>;
  setEngine(p: PayloadOf<"chat_engine_set">): Promise<Replies["chat_engines"]>;
  removeEngine(id: string): Promise<Replies["chat_engines"]>;
  checkEngine(id: string): Promise<Replies["chat_engines"]>;
  mcp(): Promise<Replies["chat_mcp"]>;
  mcpServer(p: PayloadOf<"chat_mcp_server">): Promise<Replies["chat_mcp"]>;
  mcpAlwaysLoad(p: PayloadOf<"chat_mcp_always_load">): Promise<Replies["chat_mcp"]>;
  mcpRestart(name: string): Promise<Replies["chat_mcp"]>;
  mcpSignOut(name: string): Promise<Replies["chat_mcp"]>;
  /** The browser back from an MCP server's sign-in page (mod/server.ts's callback route); not a frame. */
  mcpOauthCallback(params: Record<string, string>): Promise<{ ok: boolean; server: string | null; message: string }>;
  mcpAgent(p: PayloadOf<"chat_mcp_agent">): Promise<Replies["chat_mcp"]>;
  mcpSecret(p: PayloadOf<"chat_mcp_secret">): Promise<Replies["chat_mcp_secret"]>;
  enableSkill(path: string): Promise<{ name: string; linkPath: string }>;
  disableSkill(name: string): Promise<void>;
}

/** What the chat frame handler needs from its host: the daemon's ChatBackend, absent when the mod runs alone. */
export interface ChatDeps {
  chat?: ChatBackend;
  /** Why an agent may not be deleted now (a paired Mac out of reach would keep its chats), or null (plan 023). */
  agentDeleteBlocked?: (agentId: string) => string | null;
  /** Why a chat takes no message now (it is moving to another Mac), or null (plan 023, U9). */
  chatBlocked?: (agentId: string, conversationId: string) => string | null;
}

const NOT_HERE = "chats are served by loki's daemon, not this host";
const DONE: Replies["chat_done"] = {};

/** Run `work` against the backend: its reply, or why not. */
async function served<R>(backend: ChatBackend | undefined, work: (b: ChatBackend) => Promise<R>): Promise<Outcome<R>> {
  if (!backend) return fail(NOT_HERE);
  try {
    return reply(await work(backend));
  } catch (err) {
    return fail(errorMessage(err));
  }
}

/**
 * A change to the agents, told to every client once it is done. Only the client that made it knew before, so another
 * window or a paired phone kept the old list (an agent shown as "Agent", a renamed one under its old name) until its
 * next poll.
 */
async function agentsChange<R>(work: Promise<Outcome<R>>, ctx: FrameContext): Promise<Outcome<R>> {
  const out = await work;
  if (out.ok) ctx.broadcast({ type: "agents_changed" });
  return out;
}

/**
 * The chat frames: each one passed to the daemon's ChatBackend and its result returned as the reply, or `error` with why.
 * A change to the agents (create, update, delete, import) is also told to every client as `agents_changed`.
 */
export function chatFrames(deps: ChatDeps): FrameHandlers {
  const b = deps.chat;
  return {
    chat_open: ({ agent_id: agentId, conversation_id: conversationId, mode }) => served(b, (x) => x.open(agentId, conversationId, mode)),
    chat_approve: (p) => served(b, async (x) => ({ accepted: await x.approve(p) })),
    chat_answer: (p) => served(b, async (x) => ({ accepted: await x.answer(p) })),
    chat_create: ({ agent_id: agentId, cwd, title, home }) =>
      served(b, async (x) => {
        const made = await x.create(agentId, cwd, title, home);
        return { agent_id: made.agentId, conversation_id: made.conversationId };
      }),
    chat_send: (p) => {
      const blocked = deps.chatBlocked?.(p.agent_id, p.conversation_id);
      return blocked ? fail(blocked) : served(b, async (x) => ({ accepted: await x.send(p) }));
    },
    chat_abort: ({ agent_id: agentId, conversation_id: conversationId }) => served(b, async (x) => (await x.abort(agentId, conversationId), DONE)),
    chat_update: (p) => served(b, (x) => x.update(p)),
    chat_folder: ({ agent_id: agentId, conversation_id: conversationId, cwd }) => served(b, (x) => x.folder(agentId, conversationId, cwd)),
    chat_model: (p) => served(b, async (x) => (await x.model(p), DONE)),
    chat_models: () => served(b, async (x) => ({ entries: await x.models() })),
    chat_agents: () => served(b, async (x) => ({ agents: await x.agents() })),
    chat_agent_create: (p, ctx) =>
      agentsChange(
        served(b, (x) => x.createAgent(p)),
        ctx,
      ),
    chat_agent_update: (p, ctx) =>
      agentsChange(
        served(b, async (x) => (await x.updateAgent(p), DONE)),
        ctx,
      ),
    chat_agent_delete: ({ agent_id: agentId }, ctx) => {
      const blocked = deps.agentDeleteBlocked?.(agentId);
      if (blocked) return fail(blocked);
      return agentsChange(
        served(b, async (x) => (await x.deleteAgent(agentId), DONE)),
        ctx,
      );
    },
    chat_passes_get: () => served(b, (x) => x.passes()),
    // Asked of the Mac a new chat will live on (plan 023, U10); the router sends it there when `home` is another Mac.
    chat_requirements: ({ agent_id: agentId }) => served(b, async (x) => ({ agent_id: agentId, missing: await missingFor(x, agentId) })),
    chat_passes_set: (p) => served(b, (x) => x.setPasses(p)),
    chat_command: (p) => served(b, (x) => x.command(p)),
    chat_skill_enable: ({ path }) =>
      served(b, async (x) => {
        const { name, linkPath } = await x.enableSkill(path);
        return { name, link_path: linkPath };
      }),
    chat_skill_disable: ({ name }) => served(b, async (x) => (await x.disableSkill(name), DONE)),
    chat_memory_write: (p) => served(b, async (x) => (await x.writeMemory(p), DONE)),
    chat_memory_revert: (p) => served(b, async (x) => (await x.revertMemory(p), DONE)),
    chat_approvals_get: () => served(b, (x) => x.approvals()),
    chat_approvals_set: (p) => served(b, (x) => x.setApproval(p)),
    chat_labels_get: () => served(b, (x) => x.labels()),
    chat_label_set: (p) => served(b, (x) => x.setLabel(p)),
    chat_engines_get: () => served(b, (x) => x.engines()),
    chat_engine_set: (p) => served(b, (x) => x.setEngine(p)),
    chat_engine_remove: ({ id }) => served(b, (x) => x.removeEngine(id)),
    chat_engine_check: ({ id }) => served(b, (x) => x.checkEngine(id)),
    chat_mcp_get: () => served(b, (x) => x.mcp()),
    chat_mcp_server: (p) => served(b, (x) => x.mcpServer(p)),
    chat_mcp_always_load: (p) => served(b, (x) => x.mcpAlwaysLoad(p)),
    chat_mcp_restart: ({ name }) => served(b, (x) => x.mcpRestart(name)),
    chat_mcp_signout: ({ name }) => served(b, (x) => x.mcpSignOut(name)),
    chat_mcp_agent: (p) => served(b, (x) => x.mcpAgent(p)),
    chat_mcp_secret: (p) => served(b, (x) => x.mcpSecret(p)),
    chat_providers: () => served(b, async (x) => ({ providers: await x.providers() })),
    chat_provider_connect: ({ provider_id: providerId, api_key: apiKey }) =>
      served(b, async (x) => (await x.connectProvider(providerId, apiKey), { providers: await x.providers() })),
    chat_provider_disconnect: ({ provider_id: providerId }) =>
      served(b, async (x) => (await x.disconnectProvider(providerId), { providers: await x.providers() })),
    chat_provider_signin: ({ provider_id: providerId, code }) => served(b, (x) => x.signIn(providerId, code)),
  };
}

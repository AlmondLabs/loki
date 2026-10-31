import type { FrameRequest } from "./attention/chat-client.ts";
import type { InputOf, ReplyOf, RequestName } from "./frames.ts";

/**
 * The daemon's settings and agent calls, grouped by what they are about rather than by their frame names (plan 052):
 * an agent's memory and skills, Preferences › Engines, and Preferences › MCP servers with its always-allowed tools. Each is one
 * request through the mod's socket (core/frames.ts), so none needs the chat client: the chat client keeps the chats.
 * A call answers in Settings' words, never by throwing: what it was asked for, or why not as a sentence.
 */

/** How long a settings call waits for the daemon, as the chat client's calls do. */
const WAIT_MS = 15_000;

/** One request's reply, or the reason it failed. */
async function attempt<N extends RequestName>(request: FrameRequest, type: N, payload: InputOf<N>): Promise<ReplyOf<N> | string> {
  const r = await request(type, payload, WAIT_MS);
  return r.ok ? r.reply : r.error;
}

/** One request that answers only whether it took: null, or the reason it failed. */
async function done<N extends RequestName>(request: FrameRequest, type: N, payload: InputOf<N>): Promise<string | null> {
  const r = await request(type, payload, WAIT_MS);
  return r.ok ? null : r.error;
}

/** Each of the daemon's settings and agent calls, over the mod socket's `request`. */
export function daemonCalls(request: FrameRequest) {
  return {
    /** An agent's memory repo: a file written or removed, or a commit reverted, each one commit (daemon/memory.ts). */
    memory: {
      write: (agentId: string, path: string, content: string, message?: string) =>
        done(request, "chat_memory_write", { agent_id: agentId, path, content, message }),
      remove: (agentId: string, path: string, message?: string) => done(request, "chat_memory_write", { agent_id: agentId, path, content: null, message }),
      revert: (agentId: string, sha: string) => done(request, "chat_memory_revert", { agent_id: agentId, sha }),
    },
    /** The global skills (~/.agents/skills) turned on or off for every agent. */
    skills: {
      enable: (path: string) => done(request, "chat_skill_enable", { path }),
      disable: (name: string) => done(request, "chat_skill_disable", { name }),
    },
    /** Preferences › Engines: each answers with the ACP agents as they now stand. */
    engines: {
      get: () => attempt(request, "chat_engines_get", {}),
      set: (engine: InputOf<"chat_engine_set">) => attempt(request, "chat_engine_set", engine),
      remove: (id: string) => attempt(request, "chat_engine_remove", { id }),
      check: (id: string) => attempt(request, "chat_engine_check", { id }),
    },
    /** Preferences › MCP servers, Agents › Profile and Preferences › Chat's always-allowed tools: each answers with what now stands. */
    mcp: {
      get: () => attempt(request, "chat_mcp_get", {}),
      server: (entry: string, edit: InputOf<"chat_mcp_server">["edit"], rename?: string) =>
        attempt(request, "chat_mcp_server", { entry, edit, rename: rename ?? null }),
      alwaysLoad: (entry: string, tools: string[]) => attempt(request, "chat_mcp_always_load", { entry, tools }),
      restart: (name: string) => attempt(request, "chat_mcp_restart", { name }),
      signOut: (name: string) => attempt(request, "chat_mcp_signout", { name }),
      agent: (agentId: string, server: string, on: boolean) => attempt(request, "chat_mcp_agent", { agent_id: agentId, server, on }),
      /** A reference on success, an error message otherwise: never confusable, since one would land in mcp.json. */
      secret: async (name: string, value: string): Promise<{ ref: string } | string> => {
        const r = await request("chat_mcp_secret", { name, value }, WAIT_MS);
        return r.ok ? { ref: r.reply.ref } : r.error;
      },
      approvals: {
        list: async (): Promise<string[] | string> => {
          const r = await request("chat_approvals_get", {}, WAIT_MS);
          return r.ok ? r.reply.always : r.error;
        },
        set: async (tool: string, on: boolean): Promise<string[] | string> => {
          const r = await request("chat_approvals_set", { tool, on }, WAIT_MS);
          return r.ok ? r.reply.always : r.error;
        },
      },
    },
  };
}

/** The daemon's settings and agent calls, as `daemonCalls` makes them. */
export type DaemonCalls = ReturnType<typeof daemonCalls>;

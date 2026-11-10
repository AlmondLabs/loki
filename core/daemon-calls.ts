import type { FrameRequest } from "./attention/chat-client.ts";
import type { AccountView } from "./frame-types.ts";
import type { InputOf, MacAccountView, ReplyOf, RequestName } from "./frames.ts";

/**
 * The daemon's settings and agent calls, grouped by what they are about rather than by their frame names (plan 052):
 * an agent's memory and skills, Preferences › Engines, Preferences › MCP servers with its always-allowed tools, and Preferences ›
 * Inbox's accounts. Each is one
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

/** An accounts reply as Settings takes it: the accounts as they now stand (plan 067, U2), or the reason it failed. */
const listed = (r: { accounts: AccountView[] } | string): AccountView[] | string => (typeof r === "string" ? r : r.accounts);

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
    /**
     * Preferences › Accounts (plan 067, U11): each Gmail mailbox or Slack workspace on this Mac and the agent that
     * owns it. Listing, moving and disconnecting answer with the accounts as they now stand; connecting Gmail answers with
     * Google's page to open, and connecting Slack with the desktop app's workspaces, or the account once one is picked.
     */
    accounts: {
      list: () => attempt(request, "account_list", {}).then(listed),
      /** This Mac's accounts and every paired Mac's, for picking accounts in a lane (plan 087, KTD9); Accounts' rows use `list`. */
      everywhere: async (): Promise<{ accounts: AccountView[]; other_macs: MacAccountView[] } | string> => {
        const r = await attempt(request, "account_list", {});
        return typeof r === "string" ? r : { accounts: r.accounts, other_macs: r.other_macs ?? [] };
      },
      move: (accountId: string, ownerAgentId: string) => attempt(request, "account_move", { account_id: accountId, owner_agent_id: ownerAgentId }).then(listed),
      disconnect: (accountId: string) => attempt(request, "account_disconnect", { account_id: accountId }).then(listed),
      connectGmail: async (ownerAgentId: string, ownApp: { client_id: string; client_secret: string } | null): Promise<{ url: string } | string> => {
        const r = await request("account_connect_gmail", { owner_agent_id: ownerAgentId, own_app: ownApp }, WAIT_MS);
        return r.ok ? { url: r.reply.url } : r.error;
      },
      connectSlack: (ownerAgentId: string, teamId?: string) =>
        attempt(request, "account_connect_slack", { owner_agent_id: ownerAgentId, team_id: teamId ?? null }),
    },
  };
}

/** The daemon's settings and agent calls, as `daemonCalls` makes them. */
export type DaemonCalls = ReturnType<typeof daemonCalls>;

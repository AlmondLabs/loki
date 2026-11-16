import type { FrameRequest } from "./attention/chat-client.ts";
import type { AccountView } from "./frame-types.ts";
import type { InputOf, MacAccountView, ReplyOf, RequestName } from "./frames.ts";

const WAIT_MS = 15_000;

async function attempt<N extends RequestName>(request: FrameRequest, type: N, payload: InputOf<N>): Promise<ReplyOf<N> | string> {
  const r = await request(type, payload, WAIT_MS);
  return r.ok ? r.reply : r.error;
}

async function done<N extends RequestName>(request: FrameRequest, type: N, payload: InputOf<N>): Promise<string | null> {
  const r = await request(type, payload, WAIT_MS);
  return r.ok ? null : r.error;
}

const listed = (r: { accounts: AccountView[] } | string): AccountView[] | string => (typeof r === "string" ? r : r.accounts);

export function daemonCalls(request: FrameRequest) {
  return {
    memory: {
      write: (agentId: string, path: string, content: string, message?: string) =>
        done(request, "chat_memory_write", { agent_id: agentId, path, content, message }),
      remove: (agentId: string, path: string, message?: string) => done(request, "chat_memory_write", { agent_id: agentId, path, content: null, message }),
      revert: (agentId: string, sha: string) => done(request, "chat_memory_revert", { agent_id: agentId, sha }),
    },
    skills: {
      enable: (path: string) => done(request, "chat_skill_enable", { path }),
      disable: (name: string) => done(request, "chat_skill_disable", { name }),
    },
    engines: {
      get: () => attempt(request, "chat_engines_get", {}),
      set: (engine: InputOf<"chat_engine_set">) => attempt(request, "chat_engine_set", engine),
      remove: (id: string) => attempt(request, "chat_engine_remove", { id }),
      check: (id: string) => attempt(request, "chat_engine_check", { id }),
    },
    mcp: {
      get: () => attempt(request, "chat_mcp_get", {}),
      server: (entry: string, edit: InputOf<"chat_mcp_server">["edit"], rename?: string) =>
        attempt(request, "chat_mcp_server", { entry, edit, rename: rename ?? null }),
      alwaysLoad: (entry: string, tools: string[]) => attempt(request, "chat_mcp_always_load", { entry, tools }),
      restart: (name: string) => attempt(request, "chat_mcp_restart", { name }),
      signOut: (name: string) => attempt(request, "chat_mcp_signout", { name }),
      agent: (agentId: string, server: string, on: boolean) => attempt(request, "chat_mcp_agent", { agent_id: agentId, server, on }),
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
    accounts: {
      list: () => attempt(request, "account_list", {}).then(listed),
      everywhere: async (): Promise<{ accounts: AccountView[]; other_macs: MacAccountView[] } | string> => {
        const r = await attempt(request, "account_list", {});
        return typeof r === "string" ? r : { accounts: r.accounts, other_macs: r.other_macs ?? [] };
      },
      move: (accountId: string, ownerAgentId: string) => attempt(request, "account_move", { account_id: accountId, owner_agent_id: ownerAgentId }).then(listed),
      disconnect: (accountId: string) => attempt(request, "account_disconnect", { account_id: accountId }).then(listed),
      connectGmail: async (
        ownerAgentId: string,
        ownApp: { client_id: string; client_secret: string } | null,
        accountId: string | null = null,
      ): Promise<{ url: string } | string> => {
        const r = await request("account_connect_gmail", { owner_agent_id: ownerAgentId, own_app: ownApp, account_id: accountId }, WAIT_MS);
        return r.ok ? { url: r.reply.url } : r.error;
      },
      connectSlack: (ownerAgentId: string, teamId?: string) =>
        attempt(request, "account_connect_slack", { owner_agent_id: ownerAgentId, team_id: teamId ?? null }),
      connectJira: (input: InputOf<"account_connect_jira">) => attempt(request, "account_connect_jira", input).then(listed),
    },
  };
}

export type DaemonCalls = ReturnType<typeof daemonCalls>;

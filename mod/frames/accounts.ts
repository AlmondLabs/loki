import type { AccountThreads } from "../account-threads.ts";
import { accountIdOf, accountView, type Accounts } from "../accounts.ts";
import type { Handoff } from "../handoff.ts";
import type { OutsideThreads } from "../outside-threads.ts";
import type { GoogleSignIn } from "../google-signin.ts";
import type { SlackSessions } from "../slack-session.ts";
import { SlackClient } from "../slack.ts";
import { errorMessage, fail, reply, type FrameHandlers } from "./context.ts";

/** What connecting an account takes (plan 067, U5): whether an owner exists, Google's sign-in, and the Slack desktop app's sessions. */
export interface AccountConnectDeps {
  agentExists: (agentId: string) => boolean;
  googleSignIn: Pick<GoogleSignIn, "start">;
  slackSessions: Pick<SlackSessions, "available" | "workspaces" | "get">;
  /** The fetch Slack's auth.test goes through; default fetch. */
  slackFetch?: typeof fetch;
}

/**
 * What the account frames need from their host: this Mac's accounts (mod/accounts.ts), their threads
 * (mod/account-threads.ts) and the ways to connect one; without them every frame fails.
 */
export interface AccountsDeps {
  accounts?: Pick<Accounts, "list" | "get" | "add" | "setStatus" | "moveOwner" | "disconnect">;
  threads?: Pick<AccountThreads, "archive">;
  /** Handing a card's thread to its owner's chat (mod/handoff.ts). */
  handoff?: Pick<Handoff, "propose" | "handOff">;
  /** Reading a card's whole thread and sending the person's reply in it (mod/outside-threads.ts, plan 068). */
  outside?: Pick<OutsideThreads, "read" | "reply">;
  connect?: AccountConnectDeps;
}

const NO_OWNER = "an account needs an owner: pick the agent it belongs to";

/**
 * Preferences › Accounts on the mod's socket (plan 067, U2, U5): the accounts here and their owners, connecting
 * a Gmail account (a sign-in) or a Slack workspace (the desktop app's session), moving one to another agent, and
 * disconnecting one; and a paired Mac asking which accounts this Mac holds (KTD14). Every list answer is the list as it
 * now stands, without secrets or the watcher's cursor; the host tells every client when it changed. Archiving an
 * outside card (U3) writes back to its account here, on the Mac the account lives on, and answers with the reason when
 * that failed, so the card comes back. Handing a card off (U8) is proposed and carried out on that Mac too.
 */
export function accountFrames(deps: AccountsDeps): FrameHandlers {
  const need = () => {
    if (!deps.accounts) throw new Error("Inbox accounts are not available in this mod");
    return deps.accounts;
  };
  const listed = () => reply({ accounts: need().list().map(accountView) });
  return {
    account_list: listed,
    peer_accounts_get: listed,
    account_connect_gmail: ({ owner_agent_id: ownerAgentId, own_app: ownApp }) => {
      if (!deps.connect) return fail("connecting Gmail is not available in this mod");
      if (!deps.connect.agentExists(ownerAgentId)) return fail(NO_OWNER);
      try {
        return reply({ url: deps.connect.googleSignIn.start({ owner_agent_id: ownerAgentId, ...(ownApp ? { own_app: ownApp } : {}) }) });
      } catch (err) {
        return fail(errorMessage(err));
      }
    },
    account_connect_slack: async ({ owner_agent_id: ownerAgentId, team_id: teamId }) => {
      const connect = deps.connect;
      if (!connect) return fail("connecting Slack is not available in this mod");
      if (!connect.agentExists(ownerAgentId)) return fail(NO_OWNER);
      const available = connect.slackSessions.available();
      if (!available.supported) return fail(available.reason);
      try {
        if (!teamId) return reply({ workspaces: await connect.slackSessions.workspaces(), account: null });
        // Slack says who the session is, so the account is the workspace and person the session calls as.
        const client = new SlackClient({
          session: (fresh) => connect.slackSessions.get(teamId, fresh),
          setStatus: () => {},
          ...(connect.slackFetch ? { fetch: connect.slackFetch } : {}),
        });
        const me = await client.authTest();
        const accounts = need();
        const accountId = accountIdOf({ provider: "slack", team_id: me.team_id, user_id: me.user_id });
        const existing = accounts.get(accountId);
        // A workspace here that signed out (R22) is connected again, keeping its owner and its records.
        const account =
          existing && existing.status !== "connected"
            ? accounts.setStatus(accountId, "connected")
            : await accounts.add({ account_id: accountId, provider: "slack", address: me.team || teamId, owner_agent_id: ownerAgentId });
        return reply({ workspaces: [], account: accountView(account) });
      } catch (err) {
        return fail(errorMessage(err));
      }
    },
    account_move: ({ account_id: accountId, owner_agent_id: ownerAgentId }) => {
      try {
        need().moveOwner(accountId, ownerAgentId);
      } catch (err) {
        return fail(errorMessage(err));
      }
      return listed();
    },
    account_thread_archive: async ({ account_id: accountId, thread_id: threadId }) => {
      if (!deps.threads) return fail("Inbox accounts are not available in this mod");
      try {
        await deps.threads.archive(accountId, threadId);
      } catch (err) {
        return fail(errorMessage(err));
      }
      return reply({ account_id: accountId, thread_id: threadId });
    },
    account_thread_read: async ({ account_id: accountId, thread_id: threadId }) => {
      if (!deps.outside) return fail("reading threads is not available in this mod");
      try {
        return reply({ account_id: accountId, thread_id: threadId, messages: await deps.outside.read(accountId, threadId) });
      } catch (err) {
        return fail(errorMessage(err));
      }
    },
    account_thread_reply: async ({ account_id: accountId, thread_id: threadId, text }) => {
      if (!deps.outside) return fail("replying is not available in this mod");
      try {
        await deps.outside.reply(accountId, threadId, text);
      } catch (err) {
        return fail(errorMessage(err));
      }
      return reply({ account_id: accountId, thread_id: threadId });
    },
    account_thread_handoff_propose: ({ account_id: accountId, thread_id: threadId }) => {
      if (!deps.handoff) return fail("handing off is not available in this mod");
      try {
        return reply(deps.handoff.propose(accountId, threadId));
      } catch (err) {
        return fail(errorMessage(err));
      }
    },
    account_thread_handoff: async ({ account_id: accountId, thread_id: threadId, conversation_id: conversationId }) => {
      if (!deps.handoff) return fail("handing off is not available in this mod");
      try {
        const out = await deps.handoff.handOff(accountId, threadId, { conversation_id: conversationId });
        return reply({ account_id: accountId, thread_id: threadId, ...out });
      } catch (err) {
        return fail(errorMessage(err));
      }
    },
    account_disconnect: async ({ account_id: accountId }) => {
      try {
        if (!(await need().disconnect(accountId))) return fail("that account is not connected on this Mac");
      } catch (err) {
        return fail(errorMessage(err));
      }
      return listed();
    },
  };
}

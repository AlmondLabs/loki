import type { OutsideChange } from "../../core/frame-types.ts";
import type { MacAccountView } from "../../core/frames.ts";
import type { AccountThreads } from "../account-threads.ts";
import { accountIdOf, accountView, type Accounts } from "../accounts.ts";
import { JiraClient, JiraError, type JiraSecret } from "../jira.ts";
import type { Handoff } from "../handoff.ts";
import type { InboxLedger } from "../inbox-ledger.ts";
import type { OutsideThreads } from "../outside-threads.ts";
import type { GoogleSignIn } from "../google-signin.ts";
import type { SlackSessions } from "../slack-session.ts";
import { SlackClient } from "../slack.ts";
import { errorMessage, fail, reply, type FrameHandlers } from "./context.ts";

/**
 * What connecting an account takes (plan 067, U5): whether an owner exists, Google's sign-in, and the Slack desktop
 * app's sessions. A Jira site needs nothing kept here: it is asked with what the person typed.
 */
export interface AccountConnectDeps {
  agentExists: (agentId: string) => boolean;
  googleSignIn: Pick<GoogleSignIn, "start">;
  slackSessions: Pick<SlackSessions, "available" | "workspaces" | "get">;
  /** The fetch Slack's auth.test goes through; default fetch. */
  slackFetch?: typeof fetch;
  /** The fetch a Jira site is asked through while connecting; default fetch. */
  jiraFetch?: typeof fetch;
}

/** The moves on a card's thread written back to its account (mod/account-threads.ts; plan 070, U3). */
export type ThreadWrites = Pick<AccountThreads, "archive" | "markRead" | "markUnread" | "addLabels" | "restore" | "labels">;

/**
 * What the account frames need from their host: this Mac's accounts (mod/accounts.ts), their threads
 * (mod/account-threads.ts) and the ways to connect one; without them every frame fails.
 */
export interface AccountsDeps {
  accounts?: Pick<Accounts, "list" | "get" | "add" | "setSecret" | "setStatus" | "moveOwner" | "disconnect">;
  threads?: ThreadWrites;
  /** Handing a card's thread to its owner's chat (mod/handoff.ts). */
  handoff?: Pick<Handoff, "propose" | "handOff">;
  /**
   * Reading a card's whole thread and sending the person's reply in it (mod/outside-threads.ts, plan 068), and what a
   * mail card's recipients line starts from, with the undo of a held mail reply (plan 076).
   */
  outside?: Pick<OutsideThreads, "read" | "reply" | "compose" | "unsend" | "react" | "searchEmoji" | "searchPeople">;
  /** The ledger of the person's moves on outside cards (mod/inbox-ledger.ts, plan 069). */
  ledger?: Pick<InboxLedger, "record">;
  connect?: AccountConnectDeps;
  /** The paired Macs' accounts as each last said (PeerAccounts.everywhere), for picking them in a lane (plan 087, KTD9). */
  otherMacs?: () => MacAccountView[];
}

const NO_OWNER = "an account needs an owner: pick the agent it belongs to";
const NO_THREADS = "Flow accounts are not available in this mod";

/** Where every Jira Cloud site's API lives: a name under atlassian.net, with no port of its own. */
const JIRA_CLOUD_HOST = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.atlassian\.net$/;

/**
 * The host in a site address as a person gives it: a bare host, a whole URL or a link to a page of the site, in any
 * case; null when there is none. A Jira account is named by its host (KTD4), so every spelling must come to one.
 */
function hostOf(address: string): string | null {
  const typed = address.trim();
  if (!typed) return null;
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(typed) ? typed : `https://${typed}`).host || null;
  } catch {
    return null;
  }
}

/**
 * Preferences › Accounts on the mod's socket (plan 067, U2, U5): the accounts here and their owners, connecting
 * a Gmail account (a sign-in), a Slack workspace (the desktop app's session) or a Jira site (an API token), moving one
 * to another agent, and disconnecting one, with the paired Macs' accounts beside them for Flow's lanes (plan 087, KTD9);
 * and a paired Mac asking which accounts this Mac holds (KTD14). Every list answer is the list as it
 * now stands, without secrets or the watcher's cursor; the host tells every client when it changed. Archiving an
 * outside card (U3) writes back to its account here, on the Mac the account lives on, and answers with the reason when
 * that failed, so the card comes back. Handing a card off (U8) is proposed and carried out on that Mac too.
 */
export function accountFrames(deps: AccountsDeps): FrameHandlers {
  const need = () => {
    if (!deps.accounts) throw new Error(NO_THREADS);
    return deps.accounts;
  };
  const listed = () => reply({ accounts: need().list().map(accountView) });
  /** One write-back on a card's thread, answered with what it changed, or with why it could not be made. */
  const changed = async (accountId: string, threadId: string, write: (threads: ThreadWrites) => Promise<OutsideChange | null>) => {
    if (!deps.threads) return fail(NO_THREADS);
    try {
      return reply({ account_id: accountId, thread_id: threadId, change: await write(deps.threads) });
    } catch (err) {
      return fail(errorMessage(err));
    }
  };
  return {
    // Only the list carries the other Macs' accounts: a paired Mac asking wants what this Mac holds.
    account_list: () => reply({ accounts: need().list().map(accountView), other_macs: deps.otherMacs?.() ?? [] }),
    peer_accounts_get: listed,
    account_connect_gmail: ({ owner_agent_id: ownerAgentId, own_app: ownApp, account_id: accountId }) => {
      if (!deps.connect) return fail("connecting Gmail is not available in this mod");
      if (!deps.connect.agentExists(ownerAgentId)) return fail(NO_OWNER);
      // Signing an account in again is for one connected on this Mac; the sign-in checks it comes back as that one.
      if (accountId && need().get(accountId)?.provider !== "gmail") return fail("that Google account is not connected on this Mac");
      try {
        return reply({
          url: deps.connect.googleSignIn.start({
            owner_agent_id: ownerAgentId,
            ...(ownApp ? { own_app: ownApp } : {}),
            ...(accountId ? { account_id: accountId } : {}),
          }),
        });
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
    account_connect_jira: async ({ owner_agent_id: ownerAgentId, site, email, token, account_id: reconnecting }) => {
      const connect = deps.connect;
      if (!connect) return fail("connecting Jira is not available in this mod");
      if (!connect.agentExists(ownerAgentId)) return fail(NO_OWNER);
      const typed = hostOf(site);
      if (!typed) return fail("that is not a site address: enter it as in acme.atlassian.net");
      const asking = (secret: JiraSecret) =>
        new JiraClient({ secret: () => Promise.resolve(secret), setStatus: () => {}, ...(connect.jiraFetch ? { fetch: connect.jiraFetch } : {}) });
      try {
        const accounts = need();
        // The address typed is not yet known to be the person's site, so it is asked only where the site lives, by a
        // client that holds no token. The host Jira names is the account's (KTD4), and the only one the token goes to.
        const info = await asking({ site: typed, email: "", token: "" })
          .serverInfo()
          .catch(() => null);
        const host = info ? hostOf(info.base_url) : null;
        // Jira Cloud's API lives under atlassian.net even for a site with its own domain, so an answer naming any other
        // host is not a Cloud site, and the token must not go there.
        if (!info || !host || !JIRA_CLOUD_HOST.test(host)) return fail(`${typed} did not answer as a Jira Cloud site: check the site address`);
        // A custom domain is where people browse the site, so a card's link opens there (R14); the token never goes to it.
        const linkHost = hostOf(info.display_url);
        const secret: JiraSecret = { site: host, email, token, ...(linkHost && linkHost !== host ? { link_host: linkHost } : {}) };
        const me = await asking(secret).myself();
        const accountId = accountIdOf({ provider: "jira", host, account_id: me.account_id });
        if (reconnecting && reconnecting !== accountId)
          return fail("that site and API token belong to another Jira account than the one being reconnected: nothing was changed");
        const existing = accounts.get(accountId);
        // A site here whose token Jira rejected (R3) takes the new one and is connected again, keeping its owner and
        // where its watcher stands.
        if (existing && existing.status !== "connected") {
          await accounts.setSecret(accountId, JSON.stringify(secret));
          accounts.setStatus(accountId, "connected");
        } else await accounts.add({ account_id: accountId, provider: "jira", address: host, owner_agent_id: ownerAgentId }, JSON.stringify(secret));
        return listed();
      } catch (err) {
        return fail(err instanceof JiraError && err.code === "rejected" ? "Jira did not accept that email and API token" : errorMessage(err));
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
      if (!deps.threads) return fail(NO_THREADS);
      try {
        return reply({ account_id: accountId, thread_id: threadId, change: await deps.threads.archive(accountId, threadId) });
      } catch (err) {
        return fail(errorMessage(err));
      }
    },
    account_thread_mark_read: ({ account_id: accountId, thread_id: threadId }) =>
      changed(accountId, threadId, (threads) => threads.markRead(accountId, threadId)),
    account_thread_mark_unread: ({ account_id: accountId, thread_id: threadId }) =>
      changed(accountId, threadId, (threads) => threads.markUnread(accountId, threadId)),
    account_thread_label: ({ account_id: accountId, thread_id: threadId, labels }) =>
      changed(accountId, threadId, (threads) => threads.addLabels(accountId, threadId, labels)),
    account_thread_restore: ({ account_id: accountId, thread_id: threadId, change }) =>
      changed(accountId, threadId, async (threads) => {
        await threads.restore(accountId, threadId, change);
        return null;
      }),
    account_labels_list: async ({ account_id: accountId }) => {
      if (!deps.threads) return fail(NO_THREADS);
      try {
        return reply({ account_id: accountId, labels: await deps.threads.labels(accountId) });
      } catch (err) {
        return fail(errorMessage(err));
      }
    },
    account_thread_read: async ({ account_id: accountId, thread_id: threadId, view, thread_ts: threadTs, direction, from, ticket }) => {
      if (!deps.outside) return fail("reading threads is not available in this mod");
      try {
        const ask = {
          ...(view ? { view } : {}),
          ...(threadTs ? { thread_ts: threadTs } : {}),
          ...(direction ? { direction } : {}),
          ...(from ? { from } : {}),
          ...(ticket ? { ticket } : {}),
        };
        const read = await deps.outside.read(accountId, threadId, ask);
        return reply({
          account_id: accountId,
          thread_id: threadId,
          messages: read.messages,
          ...(read.window ? { window: read.window } : {}),
          ...(read.link ? { link: read.link } : {}),
          ...(read.ticket ? { ticket: read.ticket } : {}),
        });
      } catch (err) {
        return fail(errorMessage(err));
      }
    },
    account_thread_reply: async ({ account_id: accountId, thread_id: threadId, text, then, mail, outbox_id: outboxId, thread_ts: threadTs }) => {
      if (!deps.outside) return fail("replying is not available in this mod");
      try {
        return reply({ account_id: accountId, thread_id: threadId, ...(await deps.outside.reply(accountId, threadId, text, then, mail, outboxId, threadTs)) });
      } catch (err) {
        return fail(errorMessage(err));
      }
    },
    account_thread_compose: async ({ account_id: accountId, thread_id: threadId }) => {
      if (!deps.outside) return fail("replying is not available in this mod");
      try {
        return reply({ account_id: accountId, thread_id: threadId, ...(await deps.outside.compose(accountId, threadId)) });
      } catch (err) {
        return fail(errorMessage(err));
      }
    },
    account_thread_react: async ({ account_id: accountId, thread_id: threadId, message_id: messageId, name, on }) => {
      if (!deps.outside) return fail("reacting is not available in this mod");
      try {
        await deps.outside.react(accountId, threadId, messageId, name, on);
        return reply({ account_id: accountId, thread_id: threadId, message_id: messageId, name, on });
      } catch (err) {
        return fail(errorMessage(err));
      }
    },
    account_emoji_search: async ({ account_id: accountId, query }) => {
      if (!deps.outside) return fail("reacting is not available in this mod");
      try {
        return reply({ account_id: accountId, emoji: await deps.outside.searchEmoji(accountId, query) });
      } catch (err) {
        return fail(errorMessage(err));
      }
    },
    account_people_search: async ({ account_id: accountId, query }) => {
      if (!deps.outside) return fail("mentioning is not available in this mod");
      try {
        return reply({ account_id: accountId, people: await deps.outside.searchPeople(accountId, query) });
      } catch (err) {
        return fail(errorMessage(err));
      }
    },
    account_thread_unsend: ({ account_id: accountId, outbox_id: outboxId }) => {
      if (!deps.outside) return fail("replying is not available in this mod");
      return reply({ account_id: accountId, outbox_id: outboxId, undone: deps.outside.unsend(accountId, outboxId) });
    },
    account_thread_move: ({
      account_id: accountId,
      thread_id: threadId,
      action,
      via,
      dwell_ms: dwellMs,
      return_at: returnAt,
      labels,
      picked,
      after_reply: afterReply,
    }) => {
      const move = { action, via, dwell_ms: dwellMs, return_at: returnAt, labels, picked, after_reply: afterReply };
      const kept = deps.ledger?.record(accountId, threadId, move) ?? null;
      return reply({ account_id: accountId, thread_id: threadId, kept: kept !== null });
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

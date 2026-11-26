import type { OutsideChange } from "../../core/frame-types.ts";
import type { MacAccountView } from "../../core/frames.ts";
import type { AccountThreads } from "../account-threads.ts";
import { accountIdOf, accountView, type Accounts } from "../accounts.ts";
import { JiraClient, JiraError, type JiraSecret } from "../jira.ts";
import type { Handoff } from "../handoff.ts";
import type { FlowLedger } from "../flow-ledger.ts";
import type { OutsideThreads } from "../outside-threads.ts";
import type { GoogleSignIn } from "../google-signin.ts";
import type { SlackSessions } from "../slack-session.ts";
import { SlackClient } from "../slack.ts";
import { errorMessage, fail, reply, type FrameHandlers } from "./context.ts";

export interface AccountConnectDeps {
  agentExists: (agentId: string) => boolean;
  googleSignIn: Pick<GoogleSignIn, "start">;
  slackSessions: Pick<SlackSessions, "available" | "workspaces" | "get">;
  slackFetch?: typeof fetch;
  jiraFetch?: typeof fetch;
}

export type ThreadWrites = Pick<AccountThreads, "archive" | "markRead" | "markUnread" | "addLabels" | "restore" | "labels">;

export interface AccountsDeps {
  accounts?: Pick<Accounts, "list" | "get" | "add" | "setSecret" | "setStatus" | "moveOwner" | "disconnect">;
  threads?: ThreadWrites;
  handoff?: Pick<Handoff, "propose" | "handOff">;
  outside?: Pick<OutsideThreads, "read" | "reply" | "compose" | "unsend" | "resend" | "discardUnsent" | "react" | "searchEmoji" | "searchPeople">;
  ledger?: Pick<FlowLedger, "record">;
  connect?: AccountConnectDeps;
  otherMacs?: () => MacAccountView[];
}

const NO_OWNER = "an account needs an owner: pick the agent it belongs to";
const NO_THREADS = "Flow accounts are not available in this mod";

/** Where every Jira Cloud site's API lives: a name under atlassian.net, with no port of its own. */
const JIRA_CLOUD_HOST = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.atlassian\.net$/;

function hostOf(address: string): string | null {
  const typed = address.trim();
  if (!typed) return null;
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(typed) ? typed : `https://${typed}`).host || null;
  } catch {
    return null;
  }
}

export function accountFrames(deps: AccountsDeps): FrameHandlers {
  const need = () => {
    if (!deps.accounts) throw new Error(NO_THREADS);
    return deps.accounts;
  };
  const listed = () => reply({ accounts: need().list().map(accountView) });
  const changed = async (accountId: string, threadId: string, write: (threads: ThreadWrites) => Promise<OutsideChange | null>) => {
    if (!deps.threads) return fail(NO_THREADS);
    try {
      return reply({ account_id: accountId, thread_id: threadId, change: await write(deps.threads) });
    } catch (err) {
      return fail(errorMessage(err));
    }
  };
  return {
    account_list: () => reply({ accounts: need().list().map(accountView), other_macs: deps.otherMacs?.() ?? [] }),
    peer_accounts_get: listed,
    account_connect_gmail: ({ owner_agent_id: ownerAgentId, own_app: ownApp, account_id: accountId }) => {
      if (!deps.connect) return fail("connecting Gmail is not available in this mod");
      if (!deps.connect.agentExists(ownerAgentId)) return fail(NO_OWNER);
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
        const client = new SlackClient({
          session: (fresh) => connect.slackSessions.get(teamId, fresh),
          setStatus: () => {},
          ...(connect.slackFetch ? { fetch: connect.slackFetch } : {}),
        });
        const me = await client.authTest();
        const accounts = need();
        const accountId = accountIdOf({ provider: "slack", team_id: me.team_id, user_id: me.user_id });
        const existing = accounts.get(accountId);
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
        const info = await asking({ site: typed, email: "", token: "" })
          .serverInfo()
          .catch(() => null);
        const host = info ? hostOf(info.base_url) : null;
        // Outside (Jira): Jira Cloud's API lives under atlassian.net even for a site with its own domain, so an answer naming any other
        // host is not a Cloud site, and the token must not go there.
        if (!info || !host || !JIRA_CLOUD_HOST.test(host)) return fail(`${typed} did not answer as a Jira Cloud site: check the site address`);
        const linkHost = hostOf(info.display_url);
        const secret: JiraSecret = { site: host, email, token, ...(linkHost && linkHost !== host ? { link_host: linkHost } : {}) };
        const me = await asking(secret).myself();
        const accountId = accountIdOf({ provider: "jira", host, account_id: me.account_id });
        if (reconnecting && reconnecting !== accountId)
          return fail("that site and API token belong to another Jira account than the one being reconnected: nothing was changed");
        const existing = accounts.get(accountId);
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
    account_thread_read: async ({ account_id: accountId, thread_id: threadId, view, thread_ts: threadTs, direction, from, shown_from: shownFrom, ticket }) => {
      if (!deps.outside) return fail("reading threads is not available in this mod");
      try {
        const ask = {
          ...(view ? { view } : {}),
          ...(threadTs ? { thread_ts: threadTs } : {}),
          ...(direction ? { direction } : {}),
          ...(from ? { from } : {}),
          ...(shownFrom ? { shown_from: shownFrom } : {}),
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
    account_thread_reply: async ({ account_id: accountId, thread_id: threadId, text, then, mail, outbox_id: outboxId, thread_ts: threadTs, mentions }) => {
      if (!deps.outside) return fail("replying is not available in this mod");
      try {
        return reply({
          account_id: accountId,
          thread_id: threadId,
          ...(await deps.outside.reply(accountId, threadId, text, then, mail, outboxId, threadTs, mentions)),
        });
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
    account_thread_resend: async ({ account_id: accountId, thread_id: threadId, outbox_id: outboxId }) => {
      if (!deps.outside) return fail("replying is not available in this mod");
      try {
        return reply({ account_id: accountId, thread_id: threadId, ...(await deps.outside.resend(accountId, outboxId)) });
      } catch (err) {
        return fail(errorMessage(err));
      }
    },
    account_thread_discard: ({ account_id: accountId, outbox_id: outboxId }) => {
      if (!deps.outside) return fail("replying is not available in this mod");
      return reply({ account_id: accountId, outbox_id: outboxId, discarded: deps.outside.discardUnsent(accountId, outboxId) });
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

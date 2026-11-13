import type { AccountProvider } from "../../core/frame-types.ts";
import type { ModApi, ModTool, ToolContext } from "../../daemon/mods/api.ts";
import type { AccountThreads } from "../account-threads.ts";
import { accountLabel, type AccountRecord, type Accounts } from "../accounts.ts";
import type { JiraClient } from "../jira.ts";
import { jiraThreadText } from "../jira-view.ts";
import type { SlackClient } from "../slack.ts";
import { slackThreadText } from "./slack.ts";
import type { ThreadMessage } from "./thread.ts";

/**
 * The account operations scripts call (plan 097, U2): `slack_read`, `jira_read` and `flow_list`, beside the Google
 * tools (mod/google-tools/). Each is script-only, so the model is never offered it, and each reads with the same reader
 * a hand-off and a card use (mod/account-ops/). Every call checks again that the account it names is the calling
 * agent's, and refuses one that is not without saying whose it is. They answer in JSON for the script to read; Slack
 * and Jira stay read-only to agents, and a reply to either still goes through `reply_propose`.
 */

/** What the account script tools read: the accounts and their owners, Flow's threads, and each account's client. */
export interface AccountScriptDeps {
  accounts: Pick<Accounts, "ownedBy">;
  threads: Pick<AccountThreads, "list">;
  slack: (accountId: string) => Pick<SlackClient, "conversationsReplies" | "conversationsHistory" | "usersInfo">;
  jira: (accountId: string) => Pick<JiraClient, "ticket" | "issue" | "comments" | "history">;
}

const ACCOUNT_PROPERTY = {
  type: "string",
  description: "The account's id or name; leave it out when this agent owns one of this kind.",
};

/**
 * The calling agent's account a call names, by id, address or label in any case, of one provider (or any, for null);
 * with none named, its only account of that kind. Each refusal says why, and never whose another account is.
 */
export function scriptAccount(accounts: Pick<Accounts, "ownedBy">, ctx: ToolContext, named: unknown, provider: AccountProvider | null): AccountRecord {
  const owned = accounts.ownedBy(ctx.agentId).filter((a) => provider === null || a.provider === provider);
  const kind = provider ?? "";
  let account: AccountRecord | undefined;
  if (typeof named === "string" && named.trim()) {
    const wanted = named.trim().toLowerCase();
    account = owned.find((a) => [a.account_id, a.address, accountLabel(a)].some((n) => n.toLowerCase() === wanted));
    if (!account)
      throw new Error(
        `this agent owns no ${kind ? `${kind} ` : ""}account "${named.trim()}"; its own are ${owned.map((a) => a.account_id).join(", ") || "none"}`,
      );
  } else {
    if (owned.length === 0) throw new Error(`this agent owns no ${kind} account`);
    if (owned.length > 1) throw new Error(`this agent owns several ${kind} accounts: name one with \`account\` (${owned.map((a) => a.account_id).join(", ")})`);
    account = owned[0];
  }
  if (account.status !== "connected") throw new Error(`${accountLabel(account)} is disconnected: reconnect it in Preferences › Accounts`);
  return account;
}

/** A message as a script reads it: who wrote it, when, whether it was the person's own, and its text. */
const messageOut = (m: ThreadMessage) => ({ sender: m.sender, at: m.at, mine: m.mine ?? false, text: m.text, ...(m.id ? { id: m.id } : {}) });

const textArg = (args: Record<string, unknown>, key: string): string => {
  const v = args[key];
  if (typeof v === "string" && v.trim()) return v.trim();
  throw new Error(`\`${key}\` is required`);
};

/** A read-only script tool, offered to an agent that owns an account of `provider` (any, for null). */
function scriptTool(
  deps: AccountScriptDeps,
  provider: AccountProvider | null,
  tool: Pick<ModTool, "name" | "description" | "parameters"> & { run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<Record<string, unknown>> },
): ModTool {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    callers: ["tools"],
    outputSchema: { type: "object" },
    replay: "safe",
    // Each answers with what other people wrote, or their names and subjects (plan 097, KTD2).
    annotations: { readOnly: true, strangerText: true },
    forAgent: (agentId) => deps.accounts.ownedBy(agentId).some((a) => provider === null || a.provider === provider),
    execute: (args, ctx) => tool.run(args, ctx),
  };
}

/** The account script tools, registered; returns the functions that take them back. */
export function registerAccountScriptTools(api: ModApi, deps: AccountScriptDeps): Array<() => void> {
  const slackRead = scriptTool(deps, "slack", {
    name: "slack_read",
    description:
      "Read a Slack thread (`thread`: a DM's channel id, or `<channel>:<ts>` for a thread, as Flow and flow_list name it): its messages, oldest first, each with its sender, time and text. A DM gives its latest 50.",
    parameters: { type: "object", properties: { account: ACCOUNT_PROPERTY, thread: { type: "string" } }, required: ["thread"] },
    run: async (args, ctx) => {
      const account = scriptAccount(deps.accounts, ctx, args.account, "slack");
      const thread = textArg(args, "thread");
      const messages = await slackThreadText(deps.slack)(account.account_id, thread);
      return { account: account.account_id, thread, messages: messages.map(messageOut) };
    },
  });
  const jiraRead = scriptTool(deps, "jira", {
    name: "jira_read",
    description:
      "Read a Jira ticket (`ticket`: its key or id): its summary, then its fields and description, every comment and every field change, oldest first, each with who and when.",
    parameters: { type: "object", properties: { account: ACCOUNT_PROPERTY, ticket: { type: "string" } }, required: ["ticket"] },
    run: async (args, ctx) => {
      const account = scriptAccount(deps.accounts, ctx, args.account, "jira");
      const client = deps.jira(account.account_id);
      // A key and an id name the same ticket, which is read by its id, as its card keeps it (plan 2026-11-10-1451, KTD7).
      const ticket = await client.ticket(textArg(args, "ticket"));
      const messages = await jiraThreadText(() => client)(account.account_id, ticket.id);
      return { account: account.account_id, key: ticket.key, id: ticket.id, summary: ticket.summary, messages: messages.map(messageOut) };
    },
  });
  const flowList = scriptTool(deps, null, {
    name: "flow_list",
    description:
      "The threads waiting in Flow for your accounts (one with `account`), newest first: each one's account, thread id (and a Jira ticket's key), sender, subject or first line, time, whether it is open or handed to a chat, and that chat. No message text: read one with google_gmail_read, slack_read or jira_read.",
    parameters: { type: "object", properties: { account: ACCOUNT_PROPERTY } },
    run: (args, ctx) => {
      const accounts =
        typeof args.account === "string" && args.account.trim() ? [scriptAccount(deps.accounts, ctx, args.account, null)] : deps.accounts.ownedBy(ctx.agentId);
      const threads = accounts.flatMap((a) =>
        deps.threads
          .list(a.account_id)
          .filter((t) => t.state !== "archived")
          .map((t) => ({
            account: a.account_id,
            service: a.provider,
            thread: t.thread_id,
            ...(a.provider === "jira" && t.place ? { key: t.place } : {}),
            sender: t.sender,
            subject: t.subject_or_first_line,
            at: t.newest_at,
            state: t.state === "open" ? "open" : "handed off",
            chat: t.handoff_conversation_id,
          })),
      );
      threads.sort((x, y) => y.at.localeCompare(x.at));
      return Promise.resolve({ threads });
    },
  });
  return [slackRead, jiraRead, flowList].map((tool) => api.tools.register(tool));
}

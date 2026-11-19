import type { AccountProvider, OutsideChange, OutsideWrite } from "../core/frame-types.ts";
import type { AccountRecord } from "./accounts.ts";
import type { AccountThreads, OutsideSource, ThreadRecord } from "./account-threads.ts";
import type { AccountSyncFactory, AccountWatcher } from "./account-watcher.ts";
import type { ThreadText } from "./account-ops/thread.ts";
import type { SendClient, SendGmail, SendJira, SendSlack } from "./outside-threads.ts";
import type { CardView } from "./slack-view.ts";

/**
 * `LOKI_PREVIEW_ACCOUNTS=1`, which `npm run phone-preview` alone sets: its made-up accounts have no keychain and no
 * service behind them, so their cards act on loki's own records and read their records' lines.
 */
export const previewAccounts = (env: Record<string, string | undefined>): boolean => env.LOKI_PREVIEW_ACCOUNTS === "1";

export interface AccountWiring {
  sources: (watcher: Pick<AccountWatcher, "syncOf">) => Record<AccountProvider, OutsideSource>;
  factories: Partial<Record<AccountProvider, AccountSyncFactory>>;
  threadText: Record<AccountProvider, ThreadText>;
  cardView?: Partial<Record<AccountProvider, CardView>>;
  clientFor: (account: AccountRecord) => SendClient;
}

export function recordOnlySource(): OutsideSource {
  const change = (move: OutsideWrite, record: ThreadRecord): Promise<OutsideChange> =>
    Promise.resolve({ move, messages: [], ended: move === "archive", was_unread: record.unread_out_there });
  return {
    archive: (_accountId, record) => change("archive", record),
    markRead: (_accountId, record) => change("read", record),
    markUnread: (_accountId, record) => change("unread", record),
    addLabels: (_accountId, record) => change("label", record),
    restore: () => Promise.resolve(),
    labels: () => Promise.resolve([]),
  };
}

const refuse = (what: string) => () => Promise.reject(new Error(`the preview sends and reads no ${what}`));

export function recordOnlyMail(): SendGmail {
  const none = refuse("mail");
  return { getThread: none, sendAs: none, sendReply: none, attachment: none, listMessages: none };
}

export function recordOnlySlack(): SendSlack {
  const none = refuse("Slack");
  return { postReply: none, postWithFiles: none, react: none, emojiList: none, frequentEmoji: none, openDm: none };
}

export function recordOnlyJira(): SendJira {
  const none = refuse("Jira");
  return { postComment: none, attachFiles: none, createIssue: none };
}

export function recordThreadText(threads: Pick<AccountThreads, "get">): ThreadText {
  return (accountId, threadId) => {
    const r = threads.get(accountId, threadId);
    const last = (r?.lines.length ?? 0) - 1;
    return Promise.resolve(
      r?.lines.map((text, i) => ({ id: i === last ? r.newest_message_id : `${r.newest_message_id}-${String(i)}`, sender: r.sender, at: r.newest_at, text })) ??
        [],
    );
  };
}

export function previewWiring(threads: Pick<AccountThreads, "get">): AccountWiring {
  const text = recordThreadText(threads);
  return {
    sources: () => ({ gmail: recordOnlySource(), slack: recordOnlySource(), jira: recordOnlySource() }),
    factories: {},
    threadText: { gmail: text, slack: text, jira: text },
    clientFor: (account) => {
      switch (account.provider) {
        case "gmail":
          return { provider: "gmail", client: recordOnlyMail() };
        case "slack":
          return { provider: "slack", client: recordOnlySlack() };
        case "jira":
          return { provider: "jira", client: recordOnlyJira() };
      }
    },
  };
}

import { describe, expect, test } from "vitest";
import { readReplyDestination, type ReplyReads } from "../mod/account-ops/reply-reader.ts";
import type { ReplyJiraReads } from "../mod/account-ops/jira.ts";
import type { ReplySlackReads } from "../mod/account-ops/slack.ts";
import type { FlowRecord } from "../mod/account-ops/thread.ts";
import type { AccountRecord } from "../mod/accounts.ts";
import { JiraError, type JiraTicketFacts } from "../mod/jira.ts";
import { GoogleError } from "../mod/google-auth.ts";
import type { GmailMessage } from "../mod/gmail.ts";
import { SlackError, type SlackConversation, type SlackMessage } from "../mod/slack.ts";

function account(provider: AccountRecord["provider"], accountId: string, address: string): AccountRecord {
  return {
    account_id: accountId,
    provider,
    address,
    owner_agent_id: "agent-local-work",
    status: "connected",
    connected_at: "2026-11-15T09:00:00.000Z",
    backfill: {},
  };
}

const SITE = account("jira", "jira:acme.atlassian.net:me-1", "acme.atlassian.net");
const WORKSPACE = account("slack", "slack:T1:U1", "Acme");
const MAIL = account("gmail", "gmail:ada@acme.com", "ada@acme.com");

function flowOf(records: Record<string, { sender: string; subject_or_first_line: string }> = {}): FlowRecord {
  return (accountId, threadId) => records[`${accountId}|${threadId}`] ?? null;
}

const TICKET: JiraTicketFacts = {
  id: "10042",
  key: "FMOS-13190",
  summary: "Fix the login timeout",
  assignee: "Grace Lee",
  reporter: "Ana Ruiz",
  watchers: 3,
  service_desk: false,
};

function fakeJira(facts: JiraTicketFacts = TICKET, linkHost: string | null = "jira.acme.example") {
  const asked: string[] = [];
  const client: ReplyJiraReads = {
    ticketFacts: (idOrKey) => {
      asked.push(idOrKey);
      return idOrKey === facts.key || idOrKey === facts.id ? Promise.resolve(facts) : Promise.reject(new JiraError("not found", "not_found", 404));
    },
    linkHost: () => Promise.resolve(linkHost),
  };
  return { reads: { provider: "jira", client } satisfies ReplyReads, asked };
}

describe("a Jira comment's ticket", () => {
  test("a key in any case, an id and a link of the site all give the ticket's id, key, title and who hears of it", async () => {
    for (const ref of [
      "fmos-13190",
      "FMOS-13190",
      "10042",
      "https://acme.atlassian.net/browse/FMOS-13190",
      "https://jira.acme.example/browse/fmos-13190?focus=1",
    ]) {
      const d = await readReplyDestination(SITE, fakeJira().reads, ref, flowOf());
      expect(d).toEqual({
        thread_id: "10042",
        subject: "Fix the login timeout",
        to: [],
        cc: [],
        place: "FMOS-13190",
        in_flow: false,
        shared_outside: false,
        heard_by: { assignee: "Grace Lee", reporter: "Ana Ruiz", watchers: 3, customer_sees: false },
      });
    }
  });

  test("a ticket with a card in Flow is still read from Jira, and says it is in Flow", async () => {
    const jira = fakeJira();
    const d = await readReplyDestination(
      SITE,
      jira.reads,
      "FMOS-13190",
      flowOf({ [`${SITE.account_id}|10042`]: { sender: "Ana", subject_or_first_line: "old title" } }),
    );
    expect(jira.asked).toEqual(["FMOS-13190"]);
    expect(d.subject).toBe("Fix the login timeout");
    expect(d.in_flow).toBe(true);
  });

  test("a key Jira does not have is refused, even when Flow once had a record of it", async () => {
    const flow = flowOf({ [`${SITE.account_id}|OPS-990`]: { sender: "Ana", subject_or_first_line: "gone" } });
    await expect(readReplyDestination(SITE, fakeJira().reads, "ops-990", flow)).rejects.toThrow(
      "there is no ticket OPS-990 on acme.atlassian.net that you can see",
    );
  });

  test("a link of another site, or one that names no ticket, is refused", async () => {
    await expect(readReplyDestination(SITE, fakeJira().reads, "https://evil.atlassian.net/browse/FMOS-13190", flowOf())).rejects.toThrow(
      "that link is not on acme.atlassian.net, the site of this account",
    );
    await expect(readReplyDestination(SITE, fakeJira().reads, "https://acme.atlassian.net/jira/your-work", flowOf())).rejects.toThrow(
      "that link names no ticket",
    );
    await expect(readReplyDestination(SITE, fakeJira().reads, "the login bug", flowOf())).rejects.toThrow("the login bug is not a ticket");
  });

  test("a service desk's ticket says its customer sees the comment", async () => {
    const d = await readReplyDestination(SITE, fakeJira({ ...TICKET, service_desk: true }).reads, "FMOS-13190", flowOf());
    expect(d.heard_by?.customer_sees).toBe(true);
  });
});

function message(ts: string, text: string, threadTs: string | null = null, user = "U7"): SlackMessage {
  return { ts, user, bot_id: null, text, thread_ts: threadTs, subtype: null, reply_count: 0, raw: { text } };
}

function fakeSlack() {
  const conversations: Partial<Record<string, SlackConversation>> = {
    C9: { id: "C9", name: "ops", is_im: false, is_mpim: false, is_channel: true, is_private: false, user: null, last_read: null, is_member: true },
    C5: { id: "C5", name: "secret", is_im: false, is_mpim: false, is_channel: true, is_private: false, user: null, last_read: null, is_member: false },
    CX: {
      id: "CX",
      name: "partners",
      is_im: false,
      is_mpim: false,
      is_channel: true,
      is_private: false,
      user: null,
      last_read: null,
      is_member: true,
      is_ext_shared: true,
    },
    D4: { id: "D4", name: null, is_im: true, is_mpim: false, is_channel: false, is_private: true, user: "U7", last_read: null, is_member: true },
  };
  const messages: Partial<Record<string, SlackMessage>> = {
    "C9:1700000000.000100": message("1700000000.000100", "Deploy is stuck on step 3\nmore below"),
    "C9:1700000000.000200": message("1700000000.000200", "any news?", "1700000000.000100"),
    "D4:1700000001.000100": message("1700000001.000100", "can you look at the invoice"),
  };
  const client: ReplySlackReads = {
    authTest: () => Promise.resolve({ team_id: "T1", team: "Acme", user_id: "U1", user: "ada", url: "https://acme.slack.com/" }),
    conversationsInfo: (channel) => {
      const c = conversations[channel];
      return c ? Promise.resolve(c) : Promise.reject(new SlackError("channel_not_found", "channel_not_found"));
    },
    conversationsReplies: ({ channel, ts }) => {
      const m = messages[`${channel}:${ts}`];
      return m
        ? Promise.resolve({ messages: [m], has_more: false, next_cursor: null })
        : Promise.reject(new SlackError("thread_not_found", "thread_not_found"));
    },
    usersConversations: (cursor) =>
      Promise.resolve(
        cursor
          ? { conversations: [{ id: "C9", name: "ops", is_im: false, is_mpim: false, user: null }], next_cursor: null }
          : { conversations: [{ id: "D4", name: null, is_im: true, is_mpim: false, user: "U7" }], next_cursor: "page-2" },
      ),
    usersInfo: (user) =>
      user === "U7"
        ? Promise.resolve({ id: "U7", name: "vivek", real_name: "Vivek Rao", display_name: "", is_bot: false })
        : Promise.reject(new SlackError("user_not_found", "user_not_found")),
  };
  return { reads: { provider: "slack", client } satisfies ReplyReads, client };
}

describe("a Slack reply's conversation", () => {
  test("a link to a thread, with and without its thread_ts, gives the parent's thread and its first line", async () => {
    const slack = fakeSlack();
    for (const ref of [
      "https://acme.slack.com/archives/C9/p1700000000000100",
      "https://acme.slack.com/archives/C9/p1700000000000200?thread_ts=1700000000.000100&cid=C9",
      "https://acme.slack.com/archives/C9/p1700000000000200",
      "C9:1700000000.000200",
    ]) {
      const d = await readReplyDestination(WORKSPACE, slack.reads, ref, flowOf());
      expect(d.thread_id).toBe("C9:1700000000.000100");
      expect(d.place).toBe("the thread in #ops");
      expect(d.subject).toBe("Deploy is stuck on step 3");
      expect(d.in_flow).toBe(false);
    }
  });

  test("a link of another workspace is refused", async () => {
    await expect(readReplyDestination(WORKSPACE, fakeSlack().reads, "https://other.slack.com/archives/C9/p1700000000000100", flowOf())).rejects.toThrow(
      "that link is not in Acme",
    );
  });

  test("#ops resolves among the person's conversations; a channel they are not in is refused", async () => {
    const slack = fakeSlack();
    const d = await readReplyDestination(WORKSPACE, slack.reads, "#OPS", flowOf());
    expect(d).toMatchObject({ thread_id: "C9", place: "#ops", subject: "" });
    await expect(readReplyDestination(WORKSPACE, slack.reads, "#secret", flowOf())).rejects.toThrow("you are not in #secret in Acme, or it does not exist");
    await expect(readReplyDestination(WORKSPACE, slack.reads, "C5", flowOf())).rejects.toThrow("you are not in #secret in Acme");
  });

  test("a conversation or message Slack does not know is refused", async () => {
    await expect(readReplyDestination(WORKSPACE, fakeSlack().reads, "C404", flowOf())).rejects.toThrow("there is no conversation C404 in Acme");
    await expect(readReplyDestination(WORKSPACE, fakeSlack().reads, "C9:1700000009.000100", flowOf())).rejects.toThrow("there is no message 1700000009.000100");
  });

  test("a DM with no Flow record names its partner from Slack, never them", async () => {
    const d = await readReplyDestination(WORKSPACE, fakeSlack().reads, "D4", flowOf());
    expect(d.place).toBe("your DM with Vivek Rao");
    const thread = await readReplyDestination(WORKSPACE, fakeSlack().reads, "D4:1700000001.000100", flowOf());
    expect(thread.place).toBe("the thread in your DM with Vivek Rao");
  });

  test("a thread in a DM with a card in Flow is in Flow, as Slack sync keys DMs by their channel", async () => {
    const d = await readReplyDestination(
      WORKSPACE,
      fakeSlack().reads,
      "D4:1700000001.000100",
      flowOf({ [`${WORKSPACE.account_id}|D4`]: { sender: "Vivek", subject_or_first_line: "" } }),
    );
    expect(d.in_flow).toBe(true);
    expect(d.thread_id).toBe("D4:1700000001.000100");
  });

  test("a Slack Connect channel is marked shared", async () => {
    const d = await readReplyDestination(WORKSPACE, fakeSlack().reads, "CX", flowOf());
    expect(d.shared_outside).toBe(true);
  });
});

describe("a Gmail reply's thread", () => {
  const mail = (from: string, to: string, subject: string): GmailMessage =>
    ({
      id: "m1",
      threadId: "t1",
      labelIds: ["INBOX"],
      internalDate: "1",
      snippet: "",
      payload: {
        partId: "",
        mimeType: "text/plain",
        filename: "",
        headers: [
          { name: "From", value: from },
          { name: "To", value: to },
          { name: "Subject", value: subject },
        ],
        body: { size: 0 },
        parts: [],
      },
    }) as unknown as GmailMessage;

  test("reply all to the newest message, under its subject, with no Flow card", async () => {
    const reads: ReplyReads = {
      provider: "gmail",
      client: {
        getThread: () => Promise.resolve({ id: "t1", messages: [mail("Bo <bo@x.com>", "ada@acme.com, Cy <cy@x.com>", "Invoice")] } as never),
        sendAsAddresses: () => Promise.resolve([]),
      },
    };
    const d = await readReplyDestination(MAIL, reads, "t1", flowOf());
    expect(d).toMatchObject({ thread_id: "t1", subject: "Re: Invoice", to: ["Bo <bo@x.com>", "Cy <cy@x.com>"], cc: [], in_flow: false });
  });

  test("a reaction mail is never the one a reply answers", async () => {
    const reaction = { ...mail("Dee <dee@x.com>", "bo@x.com", "Re: Invoice"), id: "r1", internalDate: "2" };
    const reads: ReplyReads = {
      provider: "gmail",
      client: {
        getThread: () => Promise.resolve({ id: "t1", historyId: "1", messages: [mail("Bo <bo@x.com>", "ada@acme.com", "Invoice"), reaction] }),
        sendAsAddresses: () => Promise.resolve([]),
      },
      reactions: { of: (m) => Promise.resolve(m.id === "r1" ? "👍" : null) },
    };
    const d = await readReplyDestination(MAIL, reads, "t1", flowOf());
    expect(d).toMatchObject({ to: ["Bo <bo@x.com>"], cc: [] });
  });

  test("a thread the mailbox does not have is refused as before", async () => {
    const reads: ReplyReads = {
      provider: "gmail",
      client: { getThread: () => Promise.reject(new GoogleError("not found", 404, null)), sendAsAddresses: () => Promise.resolve([]) },
    };
    await expect(readReplyDestination(MAIL, reads, "t404", flowOf())).rejects.toThrow("there is no thread t404 in ada@acme.com");
  });
});

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { AccountRecord } from "../mod/accounts.ts";
import { ReplyProposals } from "../mod/reply-proposals.ts";
import { collectPreferenceSignals, MIN_FLOW_MOVES } from "../daemon/preference-signals.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "loki-signals-"));
  dirs.push(dir);
  return dir;
}

const SLACK_ACCOUNT: AccountRecord = {
  account_id: "slack:T1:U1",
  provider: "slack",
  address: "Acme",
  owner_agent_id: "agent-local-work",
  status: "connected",
  connected_at: "2026-11-01T00:00:00.000Z",
  backfill: {},
};

const JIRA_ACCOUNT: AccountRecord = {
  account_id: "jira:acme.atlassian.net:acc-me",
  provider: "jira",
  address: "acme.atlassian.net",
  owner_agent_id: "agent-local-work",
  status: "connected",
  connected_at: "2026-11-01T00:00:00.000Z",
  backfill: {},
};

function makeReplies(file: string, tick = { now: "2026-11-27T10:00:00.000Z" }) {
  let held = true;
  let seq = 0;
  return new ReplyProposals({
    file,
    accounts: {
      get: (id) => (id === SLACK_ACCOUNT.account_id ? SLACK_ACCOUNT : id === JIRA_ACCOUNT.account_id ? JIRA_ACCOUNT : null),
      onChange: () => () => {},
    },
    threads: { get: () => null },
    clientFor: () => ({
      provider: "slack",
      client: {
        conversationsInfo: () =>
          Promise.resolve({
            id: "C1",
            name: "ops",
            is_im: false,
            is_mpim: false,
            is_channel: true,
            is_private: false,
            user: null,
            last_read: null,
            is_member: true,
          }),
        conversationsReplies: () =>
          Promise.resolve({
            messages: [{ ts: "1.0", user: "U2", bot_id: null, text: "status?", thread_ts: "1.0", subtype: null, reply_count: 1, raw: {} }],
            has_more: false,
            next_cursor: null,
          }),
        usersInfo: () => Promise.resolve({ id: "U2", name: "Grace", real_name: "Grace Lee", display_name: "Grace Lee", avatar: null, is_bot: false }),
        authTest: () => Promise.resolve({ team_id: "T1", team: "Acme", user_id: "U1", user: "ada", url: "https://acme.slack.com/" }),
        openDm: () => Promise.resolve("D1"),
        postReply: () => Promise.resolve({ ts: "2.0" }),
        postWithFiles: () => Promise.resolve(),
        react: () => Promise.resolve(),
        emojiList: () => Promise.resolve({}),
        frequentEmoji: () => Promise.resolve([]),
        usersConversations: () => Promise.resolve({ conversations: [], next_cursor: null }),
      },
    }),
    jira: () => ({
      projects: () => Promise.resolve([{ id: "100", key: "OPS", name: "Operations", types: [{ id: "10", name: "Task", subtask: false }] }]),
      priorities: () => Promise.resolve([]),
      formFields: () => Promise.resolve([]),
      ticketFacts: () => Promise.reject(new Error("unused")),
    }),
    outside: {
      holdAgentReply: () => {
        held = true;
      },
      unsend: () => {
        held = false;
        return true;
      },
      holds: () => held,
      wentOutIn: () => Promise.resolve(false),
      acknowledge: () => {},
    },
    push: () => {},
    now: () => new Date(tick.now),
    newId: () => `reply-${++seq}`,
  });
}

describe("preserving original reply drafts and collecting preference signals", () => {
  test("editing a reply proposal preserves proposed_text across undo/re-edit and reload, and records proposed_subject for tickets", async () => {
    const dir = makeDir();
    const file = join(dir, "reply-proposals.json");
    const chat = { agent_id: "agent-local-work", conversation_id: "conv-1" };
    const tick = { now: "2026-11-27T10:00:00.000Z" };
    const replies = makeReplies(file, tick);

    const proposed = await replies.propose(chat, {
      account_id: SLACK_ACCOUNT.account_id,
      thread_id: "C1:1.0",
      text: "Original long draft with filler.",
    });
    await replies.decide(chat, proposed.id, "approve", "desktop", { text: "First edit." });
    await replies.decide(chat, proposed.id, "undo", "desktop");
    const sent = await replies.decide(chat, proposed.id, "approve", "desktop", { text: "Final crisp reply." });
    expect(sent.proposal.proposed_text).toBe("Original long draft with filler.");
    expect(sent.proposal.text).toBe("Final crisp reply.");
    tick.now = "2026-11-27T10:05:00.000Z";
    replies.sent({
      outbox_id: sent.proposal.outbox_id ?? "",
      account_id: SLACK_ACCOUNT.account_id,
      thread_id: "C1:1.0",
      text: "Final crisp reply.",
      then: "stay",
      mail: null,
      send_at: tick.now,
      proposal: { ...chat, proposal_id: proposed.id },
    });

    const ticket = await replies.proposeTicket(chat, {
      account_id: JIRA_ACCOUNT.account_id,
      project: "OPS",
      type: "Task",
      title: "Draft ticket title",
      description: "Draft ticket body",
    });
    const sentTicket = await replies.decide(chat, ticket.id, "approve", "desktop", {
      title: "Tighter title",
      text: "Tighter body",
    });
    expect(sentTicket.proposal.proposed_subject).toBe("Draft ticket title");
    expect(sentTicket.proposal.proposed_text).toBe("Draft ticket body");

    // Reload from disk to verify parseProposal keeps proposed_text and proposed_subject.
    const reloaded = makeReplies(file, tick);
    const list = reloaded.list(chat);
    expect(list[0]?.proposed_text).toBe("Original long draft with filler.");
    expect(list[1]?.proposed_subject).toBe("Draft ticket title");
    expect(list[1]?.proposed_text).toBe("Draft ticket body");
  });

  test("collectPreferenceSignals handles missing/malformed files and respects agent and since filters", () => {
    const dir = makeDir();
    expect(collectPreferenceSignals({ stateDir: dir, agentId: "agent-a", since: null })).toBeNull();

    writeFileSync(join(dir, "reply-proposals.json"), "{broken");
    writeFileSync(join(dir, "flow-ledger.jsonl"), "not-json\n");
    expect(collectPreferenceSignals({ stateDir: dir, agentId: "agent-a", since: null })).toBeNull();

    writeFileSync(
      join(dir, "reply-proposals.json"),
      JSON.stringify({
        version: 1,
        chats: [
          {
            agent_id: "agent-a",
            conversation_id: "c1",
            proposals: [
              {
                id: "r1",
                provider: "gmail",
                subject: "Old thread",
                text: "Short",
                proposed_text: "Very long",
                status: "sent",
                decided_at: "2026-11-20T00:00:00.000Z",
              },
              {
                id: "r2",
                provider: "slack",
                place: "#ops",
                text: "Crisp answer.",
                proposed_text: "I hope this message finds you well! Crisp answer.",
                status: "sent",
                decided_at: "2026-11-27T09:00:00.000Z",
              },
              {
                id: "r3",
                provider: "gmail",
                subject: "Vendor pitch",
                text: "Let's schedule a call.",
                status: "rejected",
                decided_at: "2026-11-27T09:30:00.000Z",
              },
              {
                id: "r4",
                provider: "gmail",
                subject: "Unedited send",
                text: "Same text",
                status: "sent",
                decided_at: "2026-11-27T09:45:00.000Z",
              },
            ],
            notices: [],
          },
          {
            agent_id: "agent-other",
            conversation_id: "c2",
            proposals: [
              {
                id: "r5",
                provider: "gmail",
                subject: "Other agent",
                text: "Edited",
                proposed_text: "Original",
                status: "sent",
                decided_at: "2026-11-27T09:50:00.000Z",
              },
            ],
            notices: [],
          },
        ],
      }),
    );

    const out = collectPreferenceSignals({ stateDir: dir, agentId: "agent-a", since: "2026-11-26T00:00:00.000Z" });
    expect(out).toContain("<reply-edits>");
    expect(out).toContain("[edited-send] slack (#ops)");
    expect(out).toContain("I hope this message finds you well!");
    expect(out).toContain('[rejected] gmail ("Vendor pitch")');
    expect(out).not.toContain("Old thread");
    expect(out).not.toContain("Unedited send");
    expect(out).not.toContain("Other agent");
  });

  test("collectPreferenceSignals summarizes flow triage patterns once MIN_FLOW_MOVES is met", () => {
    const dir = makeDir();
    mkdirSync(dir, { recursive: true });
    const entry = (over: Record<string, unknown>) =>
      JSON.stringify({
        at: "2026-11-27T08:00:00.000Z",
        account_id: "gmail:a@b.com",
        provider: "gmail",
        owner_agent_id: "agent-a",
        thread_id: "t1",
        generation: 1,
        message_id: "m1",
        action: "archive",
        via: "key",
        dwell_ms: 900,
        sender: "Bot",
        sender_address: "bot@alerts.example",
        subject: "Alert",
        traits: { to_you: false, list: true, automated: true, category: "updates" },
        slack_kind: null,
        from_backfill: false,
        ...over,
      });

    // Fewer than MIN_FLOW_MOVES -> omitted
    writeFileSync(join(dir, "flow-ledger.jsonl"), Array.from({ length: MIN_FLOW_MOVES - 1 }, () => entry({})).join("\n") + "\n");
    expect(collectPreferenceSignals({ stateDir: dir, agentId: "agent-a", since: null })).toBeNull();

    const lines = [
      // Old entry before `since` -> excluded
      entry({ at: "2026-11-20T00:00:00.000Z", sender: "Old", sender_address: "old@example" }),
      // Other agent -> excluded
      entry({ owner_agent_id: "agent-other", sender: "Other", sender_address: "other@example" }),
      // 4 fast archives for bot@alerts.example
      ...Array.from({ length: 4 }, (_, i) => entry({ at: `2026-11-27T08:0${i}:00.000Z`, dwell_ms: 800 + i * 100 })),
      // 3 engaged for boss@acme.com
      ...Array.from({ length: 3 }, (_, i) =>
        entry({
          at: `2026-11-27T08:1${i}:00.000Z`,
          action: i === 0 ? "reply" : "handoff",
          sender: "Boss",
          sender_address: "boss@acme.com",
          traits: { to_you: true, list: false, automated: false, category: "primary" },
        }),
      ),
      // 3 deferred for plan@acme.com
      ...Array.from({ length: 3 }, (_, i) =>
        entry({
          at: `2026-11-27T08:2${i}:00.000Z`,
          action: "later",
          sender: "Planner",
          sender_address: "plan@acme.com",
        }),
      ),
    ];
    writeFileSync(join(dir, "flow-ledger.jsonl"), lines.join("\n") + "\n");

    const out = collectPreferenceSignals({ stateDir: dir, agentId: "agent-a", since: "2026-11-26T00:00:00.000Z" });
    expect(out).toContain("<flow-patterns>");
    expect(out).toContain("Moves (10):");
    expect(out).toContain("Bot <bot@alerts.example> (4 archived, median");
    expect(out).toContain("Boss <boss@acme.com> (3)");
    expect(out).toContain("Planner <plan@acme.com> (3)");
    expect(out).toContain("Mail traits: automated (4 archived, 0 engaged); mailing-list (4 archived, 0 engaged)");
    expect(out).not.toContain("old@example");
    expect(out).not.toContain("other@example");
  });
});

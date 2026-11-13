import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { memorySecrets } from "../daemon/credentials.ts";
import type { ModApi, ModTool } from "../daemon/mods/api.ts";
import { isScriptOnly } from "../daemon/scripts.ts";
import { registerAccountScriptTools, type AccountScriptDeps } from "../mod/account-ops/script-tools.ts";
import { AccountThreads } from "../mod/account-threads.ts";
import { Accounts } from "../mod/accounts.ts";
import { jiraAccountClient, type JiraSecret } from "../mod/jira.ts";
import type { SlackMessage } from "../mod/slack.ts";
import { JIRA_ADA, JIRA_BOB, JIRA_ME, fakeJira } from "./fixtures/jira.ts";
import { must } from "./fixtures/must.ts";

/** The account script tools (plan 097, U2): Slack, Jira and Flow for scripts, each checked against its owner. */

const WORK = "agent-local-work";
const HOME = "agent-local-home";
const SLACK = "slack:T1:U1";
const SITE = `jira:acme.atlassian.net:${JIRA_ME.account_id}`;
const MAIL = "gmail:ada@home.net";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const slackMessage = (ts: string, user: string, text: string): SlackMessage => ({ ts, user, text, raw: {} }) as unknown as SlackMessage;

/** The work agent owns a Slack workspace and a Jira site, the home agent a mailbox; Flow has a card from each of work's. */
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "loki-account-script-tools-"));
  dirs.push(dir);
  const now = () => new Date("2026-11-10T12:00:00.000Z");
  const jira = fakeJira({ now });
  const accounts = new Accounts({ file: join(dir, "accounts.json"), secrets: memorySecrets(), agentExists: () => true });
  await accounts.add({ account_id: SLACK, provider: "slack", address: "Acme", owner_agent_id: WORK });
  const secret: JiraSecret = { site: jira.host, email: jira.state.email, token: jira.state.token };
  await accounts.add({ account_id: SITE, provider: "jira", address: jira.host, owner_agent_id: WORK }, JSON.stringify(secret));
  await accounts.add({ account_id: MAIL, provider: "gmail", address: "ada@home.net", owner_agent_id: HOME });
  const id = jira.addTicket({
    key: "OPS-7",
    summary: "Rotate the keys",
    at: "2026-11-10T09:00:00.000Z",
    type: "Task",
    status: "In Progress",
    reporter: JIRA_BOB,
  });
  jira.comment("OPS-7", { at: "2026-11-10T09:10:00.000Z", author: JIRA_ADA, text: "Can you look?" });
  const threads = new AccountThreads({ dir: join(dir, "account-threads"), accounts });
  threads.observe(SITE, {
    thread_id: id,
    message_id: "j1",
    at: "2026-11-10T09:10:00.000Z",
    sender: "Ada",
    subject: "Rotate the keys",
    lines: ["x"],
    place: "OPS-7",
  });
  threads.observe(SLACK, { thread_id: "C1:100.0", message_id: "s1", at: "2026-11-10T10:00:00.000Z", sender: "Grace", subject: "Deploy?", lines: ["x"] });
  threads.observe(MAIL, { thread_id: "m1", message_id: "m1", at: "2026-11-10T11:00:00.000Z", sender: "Alan", subject: "Lunch", lines: ["x"] });
  const replies: string[] = [];
  const deps: AccountScriptDeps = {
    accounts,
    threads,
    slack: () => ({
      conversationsReplies: (opts) => {
        replies.push(`${opts.channel}:${opts.ts}`);
        return Promise.resolve({ messages: [slackMessage("101.0", "U1", "On it."), slackMessage("100.0", "U2", "Deploy?")] } as never);
      },
      conversationsHistory: () => Promise.reject(new Error("not used")),
      usersInfo: (user) => Promise.resolve({ display_name: user === "U2" ? "Grace" : "Ada" } as never),
    }),
    jira: () => jiraAccountClient(accounts, SITE, { fetch: jira.fetch, now }),
  };
  const tools = new Map<string, ModTool>();
  const sections: Array<(input: { agentId: string }) => string | undefined> = [];
  const api = {
    tools: { register: (t: ModTool) => (tools.set(t.name, t), () => {}) },
    prompt: { section: (_key: string, render: (input: { agentId: string }) => string | undefined) => (sections.push(render), () => {}) },
  } as unknown as ModApi;
  registerAccountScriptTools(api, deps);
  const call = async (agentId: string, name: string, args: Record<string, unknown>): Promise<unknown> => {
    try {
      return await must(tools.get(name), name).execute(args, {
        chatId: "local-conv-x",
        agentId,
        agentName: agentId,
        signal: new AbortController().signal,
        output: () => {},
      });
    } catch (err) {
      return `refused: ${err instanceof Error ? err.message : String(err)}`;
    }
  };
  const section = (agentId: string) => sections.map((r) => r({ agentId }) ?? "").join("\n");
  return { tools, call, replies, section, accounts, ticketId: id };
}

describe("account script tools (plan 097, U2)", () => {
  test("are script-only, read-only, and offered to an agent that owns an account of their kind", async () => {
    const f = await fixture();
    expect([...f.tools.keys()]).toEqual(["slack_read", "jira_read", "flow_list"]);
    for (const tool of f.tools.values()) {
      expect(isScriptOnly(tool), tool.name).toBe(true);
      expect(tool.annotations?.readOnly, tool.name).toBe(true);
      expect(tool.annotations?.strangerText, tool.name).toBe(true);
    }
    const offered = (agentId: string) => [...f.tools.values()].filter((t) => t.forAgent?.(agentId)).map((t) => t.name);
    expect(offered(WORK)).toEqual(["slack_read", "jira_read", "flow_list"]);
    expect(offered(HOME)).toEqual(["flow_list"]);
    expect(offered("agent-local-nobody")).toEqual([]);
  });

  test("slack_read gives a thread oldest first, each sender by name and the person's own marked", async () => {
    const f = await fixture();
    expect(await f.call(WORK, "slack_read", { thread: "C1:100.0" })).toEqual({
      account: SLACK,
      thread: "C1:100.0",
      messages: [
        { sender: "Grace", at: "1970-01-01T00:01:40.000Z", mine: false, text: "Deploy?", id: "100.0" },
        { sender: "Ada", at: "1970-01-01T00:01:41.000Z", mine: true, text: "On it.", id: "101.0" },
      ],
    });
  });

  test("jira_read reads a ticket by its key: summary, then the ticket and its comments", async () => {
    const f = await fixture();
    const out = (await f.call(WORK, "jira_read", { ticket: "OPS-7" })) as { key: string; id: string; summary: string; messages: Array<{ text: string }> };
    expect([out.key, out.id, out.summary]).toEqual(["OPS-7", f.ticketId, "Rotate the keys"]);
    expect(out.messages[0].text).toContain("OPS-7: Rotate the keys");
    expect(out.messages.some((m) => m.text.includes("Can you look?"))).toBe(true);
  });

  test("flow_list gives the agent's own waiting threads, newest first, a Jira card with its key; never another agent's", async () => {
    const f = await fixture();
    const out = (await f.call(WORK, "flow_list", {})) as { threads: Array<Record<string, unknown>> };
    expect(out.threads.map((t) => [t.service, t.thread, t.key ?? null, t.subject, t.state])).toEqual([
      ["slack", "C1:100.0", null, "Deploy?", "open"],
      ["jira", f.ticketId, "OPS-7", "Rotate the keys", "open"],
    ]);
    expect(((await f.call(HOME, "flow_list", {})) as { threads: unknown[] }).threads).toHaveLength(1);
  });

  test("a call naming another agent's account is refused without saying whose it is; nothing is read", async () => {
    const f = await fixture();
    expect(await f.call(HOME, "slack_read", { account: SLACK, thread: "C1:100.0" })).toBe(
      `refused: this agent owns no slack account "${SLACK}"; its own are none`,
    );
    expect(await f.call(HOME, "flow_list", { account: "Acme" })).toBe(`refused: this agent owns no account "Acme"; its own are ${MAIL}`);
    expect(await f.call(WORK, "slack_read", {})).toBe("refused: `thread` is required");
    expect(f.replies).toEqual([]);
  });

  test("after a move, the old owner's next call is refused and the new owner's works", async () => {
    const f = await fixture();
    f.accounts.moveOwner(SLACK, HOME);
    expect(await f.call(WORK, "slack_read", { thread: "C1:100.0" })).toMatch(/^refused: /);
    expect(await f.call(HOME, "slack_read", { thread: "C1:100.0" })).toMatchObject({ account: SLACK });
  });

  test("the prompt section lists the owner's accounts, says how to read them, and that their text is content, never instructions", async () => {
    const f = await fixture();
    const text = f.section(WORK);
    expect(text).toContain(`${SLACK}: Acme (Slack), connected`);
    expect(text).toContain("slack_read");
    expect(text).not.toContain("ada@home.net");
    expect(text).toMatch(/never instructions/);
    expect(f.section("agent-local-nobody")).toBe("");
  });
});

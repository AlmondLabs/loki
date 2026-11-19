import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, test, vi } from "vitest";
import { memorySecrets } from "../daemon/credentials.ts";
import { AccountThreads } from "../mod/account-threads.ts";
import { AccountWatcher, type AccountSync } from "../mod/account-watcher.ts";
import { Accounts } from "../mod/accounts.ts";
import { OutsideThreads, previewAccounts, recordOnlyMail, recordOnlySource, recordThreadText } from "../mod/outside-threads.ts";
import { SEED_OUTSIDE, seedOutsideFiles } from "../scripts/phone-preview.ts";
import { must } from "./fixtures/must.ts";

const NOW = new Date("2026-11-19T09:00:00Z");
const OWNER = "agent-juniper";
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function seededState() {
  const state = mkdtempSync(join(tmpdir(), "loki-preview-accounts-"));
  dirs.push(state);
  for (const { file, json } of seedOutsideFiles(OWNER, NOW)) {
    mkdirSync(dirname(join(state, file)), { recursive: true });
    writeFileSync(join(state, file), JSON.stringify(json));
  }
  const accounts = new Accounts({ file: join(state, "accounts.json"), secrets: memorySecrets(), now: () => NOW });
  const threads = new AccountThreads({ dir: join(state, "account-threads"), accounts, now: () => NOW });
  return { accounts, threads };
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("the phone preview's Gmail, Slack and Jira cards (plan 2026-11-19-2250, U6)", () => {
  test("one thread for each of Gmail, Slack and Jira, all made up", () => {
    expect(SEED_OUTSIDE.map((s) => s.provider).sort()).toEqual(["gmail", "jira", "slack"]);
    const addresses = JSON.stringify(SEED_OUTSIDE).match(/[\w.+-]+@[\w.-]+/g) ?? [];
    expect(addresses.length).toBeGreaterThan(0);
    for (const a of addresses) expect(a).toMatch(/@example\.(com|org)$/);
    for (const s of SEED_OUTSIDE) expect(s.thread.lines.length).toBeGreaterThan(0);
  });

  test("the written files read back through the mod's own parsers, connected, owned by the seeded agent", () => {
    const { accounts, threads } = seededState();
    expect(accounts.list().map((a) => [a.provider, a.status, a.owner_agent_id])).toEqual(SEED_OUTSIDE.map((s) => [s.provider, "connected", OWNER]));
    const rows = threads.rows();
    expect(rows).toHaveLength(3);
    for (const s of SEED_OUTSIDE) {
      const row = must(
        rows.find((r) => r.outside?.provider === s.provider),
        `a ${s.provider} row`,
      );
      expect(row.outside).toMatchObject({ sender: s.thread.sender, subject: s.thread.subject, lines: s.thread.lines, disconnected: null });
    }
  });

  test("the switch is on only for LOKI_PREVIEW_ACCOUNTS=1", () => {
    expect(previewAccounts({})).toBe(false);
    expect(previewAccounts({ LOKI_PREVIEW_ACCOUNTS: "0" })).toBe(false);
    expect(previewAccounts({ LOKI_PREVIEW_ACCOUNTS: "1" })).toBe(true);
  });

  test("with the switch off, the watcher syncs a connected account as before", async () => {
    const { accounts } = seededState();
    const ticked: string[] = [];
    const sync = (id: string): AccountSync => ({ tick: () => Promise.resolve(void ticked.push(id)) });
    const watcher = new AccountWatcher({ accounts, factories: { gmail: (a) => sync(a.account_id) } });
    await watcher.tick();
    watcher.stop();
    expect(ticked).toEqual([SEED_OUTSIDE[0].account_id]);
  });

  test("with the switch on, an account stays connected, reads its own lines, and archives with no network", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    vi.stubGlobal("fetch", fetch);
    const { accounts, threads } = seededState();
    const watcher = new AccountWatcher({ accounts, factories: {} });
    watcher.start();
    await watcher.tick();
    await flush();
    watcher.stop();
    expect(accounts.list().every((a) => a.status === "connected")).toBe(true);

    for (const provider of ["gmail", "slack", "jira"] as const) threads.register(provider, recordOnlySource());
    const text = recordThreadText(threads);
    const outside = new OutsideThreads({
      accounts,
      threads,
      threadText: { gmail: text, slack: text, jira: text },
      clientFor: () => {
        throw new Error("a preview account has no client");
      },
    });
    for (const s of SEED_OUTSIDE) {
      const read = await outside.read(s.account_id, s.thread.thread_id);
      expect(read.messages.map((m) => [m.sender, m.text])).toEqual(s.thread.lines.map((l) => [s.thread.sender, l]));
      expect(read.messages.at(-1)?.id).toBe(s.thread.message_id);
    }

    const slack = must(
      SEED_OUTSIDE.find((s) => s.provider === "slack"),
      "the Slack seed",
    );
    const change = await threads.archive(slack.account_id, slack.thread.thread_id);
    expect(change).toMatchObject({ move: "archive", ended: true, messages: [] });
    expect(threads.rows().map((r) => r.outside?.provider)).not.toContain("slack");
    expect(threads.rows()).toHaveLength(2);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("the preview's mail", () => {
  test("opening a Gmail card asks nothing of Google, so the account never reads as signed out", async () => {
    const mail = recordOnlyMail();
    await expect(mail.sendAs()).rejects.toThrow(/the preview sends and reads no mail/);
    await expect(mail.getThread("t1", "metadata")).rejects.toThrow(/no mail/);
  });
});

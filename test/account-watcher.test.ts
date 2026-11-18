import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { memorySecrets } from "../daemon/credentials.ts";
import { AccountWatcher, type AccountSync } from "../mod/account-watcher.ts";
import { Accounts, type AccountRecord } from "../mod/accounts.ts";

const dirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const GMAIL = "gmail:ada@acme.com";
const SLACK = "slack:T01:U02";
const WAIT = "Slack asked loki to wait 30 s";

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "loki-watcher-"));
  dirs.push(dir);
  const accounts = new Accounts({ file: join(dir, "accounts.json"), secrets: memorySecrets(), now: () => new Date("2026-11-04T09:00:00Z") });
  await accounts.add({ account_id: GMAIL, provider: "gmail", address: "ada@acme.com", owner_agent_id: "agent-work" });
  await accounts.add({ account_id: SLACK, provider: "slack", address: "Acme", owner_agent_id: "agent-work" });
  const ticks: string[] = [];
  const built: string[] = [];
  const stopped: string[] = [];
  const step: Record<string, () => Promise<void>> = {};
  const reports: Array<{ event: string; detail: unknown }> = [];
  const factory = (account: AccountRecord): AccountSync => {
    built.push(account.account_id);
    return {
      tick: () => {
        ticks.push(account.account_id);
        return (step[account.account_id] ?? (() => Promise.resolve()))();
      },
      stop: () => void stopped.push(account.account_id),
      askedToWait: (error) => error instanceof Error && error.message === WAIT,
    };
  };
  const watcher = new AccountWatcher({ accounts, factories: { gmail: factory, slack: factory }, report: (event, detail) => reports.push({ event, detail }) });
  return { accounts, watcher, ticks, built, stopped, step, reports };
}

describe("the account watcher (KTD3)", () => {
  test("start ticks every account at once, then once a minute", async () => {
    vi.useFakeTimers();
    const { watcher, ticks } = await fixture();
    watcher.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(ticks).toEqual([GMAIL, SLACK]);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(ticks).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(ticks).toEqual([GMAIL, SLACK, GMAIL, SLACK]);
    watcher.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(ticks).toHaveLength(4);
  });

  test("a tick while an account's last one still runs skips that account, not the others", async () => {
    const { watcher, ticks, step } = await fixture();
    let release = () => {};
    step[GMAIL] = () => new Promise<void>((resolve) => (release = resolve));
    const first = watcher.tick();
    await flush();
    await watcher.tick();
    expect(ticks).toEqual([GMAIL, SLACK, SLACK]);
    release();
    await first;
    step[GMAIL] = () => Promise.resolve();
    await watcher.tick();
    expect(ticks.filter((t) => t === GMAIL)).toHaveLength(2);
  });

  test("one account failing is reported and the other keeps ticking", async () => {
    const { watcher, ticks, step, reports } = await fixture();
    step[GMAIL] = () => Promise.reject(new Error("Gmail is out of reach"));
    await watcher.tick();
    await watcher.tick();
    expect(ticks).toEqual([GMAIL, SLACK, GMAIL, SLACK]);
    expect(reports).toContainEqual({ event: "account:sync-failed", detail: { account_id: GMAIL, error: "Gmail is out of reach" } });
  });

  test("three failed ticks in a row mark an account failing for now, whatever its provider; a good tick mends it", async () => {
    const { watcher, accounts, step } = await fixture();
    step[SLACK] = () => Promise.reject(new Error("Slack is out of reach"));
    for (let i = 0; i < 2; i++) await watcher.tick();
    expect(accounts.get(SLACK)?.status).toBe("connected");
    await watcher.tick();
    expect(accounts.get(SLACK)?.status).toEqual({ disconnected: "temporarily_failing" });
    expect(accounts.get(GMAIL)?.status).toBe("connected");
    step[SLACK] = () => Promise.resolve();
    await watcher.tick();
    expect(accounts.get(SLACK)?.status).toBe("connected");
  });

  test("a good tick between failures starts the count again, and a sign-in a sync asked for is left as it is", async () => {
    const { watcher, accounts, step } = await fixture();
    const fail = () => Promise.reject(new Error("Slack is out of reach"));
    step[SLACK] = fail;
    for (let i = 0; i < 2; i++) await watcher.tick();
    step[SLACK] = () => Promise.resolve();
    await watcher.tick();
    step[SLACK] = fail;
    for (let i = 0; i < 2; i++) await watcher.tick();
    expect(accounts.get(SLACK)?.status).toBe("connected");
    step[SLACK] = () => {
      accounts.setStatus(SLACK, { disconnected: "slack_signed_out" });
      return fail();
    };
    await watcher.tick();
    expect(accounts.get(SLACK)?.status).toEqual({ disconnected: "slack_signed_out" });
  });

  test("a tick the service only asked to wait neither fails nor mends the account, and is not reported", async () => {
    const { watcher, accounts, step, reports } = await fixture();
    const fail = () => Promise.reject(new Error("Slack is out of reach"));
    const wait = () => Promise.reject(new Error(WAIT));
    for (const s of [fail, fail, wait, fail]) {
      step[SLACK] = s;
      await watcher.tick();
    }
    expect(accounts.get(SLACK)?.status).toEqual({ disconnected: "temporarily_failing" });
    step[SLACK] = wait;
    await watcher.tick();
    expect(accounts.get(SLACK)?.status).toEqual({ disconnected: "temporarily_failing" });
    expect(reports.filter((r) => JSON.stringify(r.detail).includes("wait"))).toEqual([]);
  });

  test("the watcher's own failing and connected marks keep the account's sync, so what it remembers stays", async () => {
    const { watcher, built, stopped, step } = await fixture();
    watcher.start();
    await flush();
    step[SLACK] = () => Promise.reject(new Error("Slack is out of reach"));
    for (let i = 0; i < 3; i++) await watcher.tick();
    step[SLACK] = () => Promise.resolve();
    await watcher.tick();
    expect(built).toEqual([GMAIL, SLACK]);
    expect(stopped).toEqual([]);
    watcher.stop();
  });

  test("an account disconnected for a sign-in is skipped until it is connected again; a temporarily failing one keeps ticking", async () => {
    const { watcher, accounts, ticks } = await fixture();
    accounts.setStatus(GMAIL, { disconnected: "sign_in_again" });
    accounts.setStatus(SLACK, { disconnected: "temporarily_failing" });
    await watcher.tick();
    expect(ticks).toEqual([SLACK]);
    accounts.setStatus(GMAIL, "connected");
    await watcher.tick();
    expect(ticks).toEqual([SLACK, GMAIL, SLACK]);
  });

  test("a change to an account builds its sync again at once; a disconnected one is stopped and gone", async () => {
    const { watcher, accounts, built, stopped, ticks } = await fixture();
    watcher.start();
    await flush();
    expect(built).toEqual([GMAIL, SLACK]);
    accounts.moveOwner(GMAIL, "agent-home");
    expect(stopped).toEqual([GMAIL]);
    expect(built).toEqual([GMAIL, SLACK, GMAIL]);
    await accounts.disconnect(SLACK);
    expect(stopped).toEqual([GMAIL, SLACK]);
    ticks.length = 0;
    await watcher.tick();
    expect(built).toEqual([GMAIL, SLACK, GMAIL]);
    expect(ticks).toEqual([GMAIL]);
    await accounts.add({ account_id: "gmail:bo@acme.com", provider: "gmail", address: "bo@acme.com", owner_agent_id: "agent-work" });
    await watcher.tick();
    expect(ticks).toEqual([GMAIL, GMAIL, "gmail:bo@acme.com"]);
    watcher.stop();
  });
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { memorySecrets } from "../daemon/credentials.ts";
import { Accounts } from "../mod/accounts.ts";
import { AccountThreads, type OutsideSource } from "../mod/account-threads.ts";
import { accountFrames } from "../mod/frames/accounts.ts";
import { peerMeaning } from "../core/frames.ts";
import { bridgeOf, client, settled } from "./fixtures/frames.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A bridge with only the account frames, over two accounts of the work agent. */
async function fixture(source?: OutsideSource) {
  const dir = mkdtempSync(join(tmpdir(), "loki-frames-accounts-"));
  dirs.push(dir);
  const secrets = memorySecrets();
  const accounts = new Accounts({ file: join(dir, "accounts.json"), secrets, now: () => new Date("2026-11-04T09:00:00Z"), agentExists: () => true });
  await accounts.add({ account_id: "gmail:ada@acme.com", provider: "gmail", address: "ada@acme.com", owner_agent_id: "agent-work" }, "token-1");
  await accounts.add({ account_id: "slack:T01:U02", provider: "slack", address: "Acme", owner_agent_id: "agent-work" });
  const threads = new AccountThreads({ dir: join(dir, "account-threads"), accounts });
  if (source) threads.register("gmail", source);
  const bridge = bridgeOf({ modules: [accountFrames({ accounts, threads })] });
  const ask = async (frame: Record<string, unknown>, peerId?: string) => {
    const c = client("d1", undefined, peerId);
    bridge.onMessage(c, { request_id: "r1", ...frame });
    await settled();
    await settled();
    return c.sent.at(-1) ?? {};
  };
  return { accounts, secrets, threads, ask };
}

describe("the account frames", () => {
  test("account_list names each account and its owner, with no secret and no cursor", async () => {
    const { ask } = await fixture();
    const answer = await ask({ type: "account_list" });
    expect(answer).toEqual({
      type: "accounts",
      request_id: "r1",
      accounts: [
        {
          account_id: "gmail:ada@acme.com",
          provider: "gmail",
          address: "ada@acme.com",
          owner_agent_id: "agent-work",
          status: "connected",
          connected_at: "2026-11-04T09:00:00.000Z",
        },
        {
          account_id: "slack:T01:U02",
          provider: "slack",
          address: "Acme",
          owner_agent_id: "agent-work",
          status: "connected",
          connected_at: "2026-11-04T09:00:00.000Z",
        },
      ],
    });
    expect(JSON.stringify(answer)).not.toContain("token-1");
  });

  test("account_move gives the account to another agent and answers with the list", async () => {
    const { ask, accounts } = await fixture();
    const answer = await ask({ type: "account_move", account_id: "slack:T01:U02", owner_agent_id: "agent-home" });
    expect(answer.type).toBe("accounts");
    expect(accounts.get("slack:T01:U02")?.owner_agent_id).toBe("agent-home");
  });

  test("account_move for an account that is not here answers an error", async () => {
    const { ask } = await fixture();
    const answer = await ask({ type: "account_move", account_id: "gmail:bob@acme.com", owner_agent_id: "agent-home" });
    expect(answer).toMatchObject({ type: "error", request_id: "r1" });
  });

  test("account_disconnect forgets the account and its keychain entry", async () => {
    const { ask, secrets } = await fixture();
    const answer = await ask({ type: "account_disconnect", account_id: "gmail:ada@acme.com" });
    expect((answer.accounts as unknown[]).length).toBe(1);
    expect(secrets.entries.has("account:gmail:ada@acme.com")).toBe(false);
  });

  test("a paired Mac's peer_accounts_get hears the accounts here", async () => {
    const { ask } = await fixture();
    const answer = await ask({ type: "peer_accounts_get" }, "mac-mini");
    expect((answer.accounts as Array<{ account_id: string }>).map((a) => a.account_id)).toEqual(["gmail:ada@acme.com", "slack:T01:U02"]);
  });

  test("account_thread_archive archives the thread out there and the card leaves; one refused there answers why and stays", async () => {
    let refuse = false;
    const { ask, threads } = await fixture({ archive: () => (refuse ? Promise.reject(new Error("Gmail is out of reach")) : Promise.resolve()) });
    const seen = { message_id: "m1", at: "2026-11-04T09:00:00.000Z", sender: "Grace", subject: "hi", lines: ["hi"] };
    threads.observe("gmail:ada@acme.com", { ...seen, thread_id: "t1" });
    threads.observe("gmail:ada@acme.com", { ...seen, thread_id: "t2" });
    expect(await ask({ type: "account_thread_archive", account_id: "gmail:ada@acme.com", thread_id: "t1" })).toEqual({
      type: "account_thread_archived",
      request_id: "r1",
      account_id: "gmail:ada@acme.com",
      thread_id: "t1",
    });
    refuse = true;
    expect(await ask({ type: "account_thread_archive", account_id: "gmail:ada@acme.com", thread_id: "t2" })).toMatchObject({
      type: "error",
      message: "Gmail is out of reach",
    });
    expect(threads.rows().map((r) => r.id)).toEqual(["t2#1"]);
  });

  test("account_thread_archive goes to the Mac the account lives on, named by the card's home", () => {
    expect(peerMeaning("account_thread_archive")).toEqual({ route: "home", relists: true });
  });
});

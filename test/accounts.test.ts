import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { AccountView } from "../core/frame-types.ts";
import { memorySecrets } from "../daemon/credentials.ts";
import { Accounts, PeerAccounts, accountIdOf, type AccountChange } from "../mod/accounts.ts";

const NOW = new Date("2026-11-04T09:00:00Z");
const AGENTS = new Set(["agent-work", "agent-home"]);
const dirs: string[] = [];

/** Accounts over a fresh state folder and an in-memory keychain; `elsewhere` stands in for the paired Macs. */
function fixture(elsewhere: (accountId: string) => string | null = () => null) {
  const dir = mkdtempSync(join(tmpdir(), "loki-accounts-"));
  dirs.push(dir);
  const secrets = memorySecrets();
  const file = join(dir, "accounts.json");
  const open = () => new Accounts({ file, secrets, now: () => NOW, agentExists: (id) => AGENTS.has(id), heldElsewhere: elsewhere });
  return { file, secrets, accounts: open(), reopen: open };
}

const WORK_MAIL = {
  account_id: accountIdOf({ provider: "gmail", address: "Ada@Acme.com" }),
  provider: "gmail",
  address: "ada@acme.com",
  owner_agent_id: "agent-work",
} as const;
const WORK_SLACK = {
  account_id: accountIdOf({ provider: "slack", team_id: "T01", user_id: "U02" }),
  provider: "slack",
  address: "Acme",
  owner_agent_id: "agent-work",
} as const;

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("account ids", () => {
  test("a mailbox is its address in lower case, a workspace its team and user", () => {
    expect(accountIdOf({ provider: "gmail", address: " Ada@Acme.COM " })).toBe("gmail:ada@acme.com");
    expect(accountIdOf({ provider: "slack", team_id: "T01", user_id: "U02" })).toBe("slack:T01:U02");
  });
});

describe("connecting an account", () => {
  test("an account without an owner, or with an agent that does not exist, is refused", async () => {
    const { accounts } = fixture();
    await expect(accounts.add({ ...WORK_MAIL, owner_agent_id: "" })).rejects.toThrow(/owner/);
    await expect(accounts.add({ ...WORK_MAIL, owner_agent_id: "agent-gone" })).rejects.toThrow(/owner/);
    expect(accounts.list()).toEqual([]);
  });

  test("an account is kept with its owner, connected now, and read back after a restart", async () => {
    const { accounts, reopen } = fixture();
    await accounts.add(WORK_MAIL, "token-1");
    const view: AccountView = { ...WORK_MAIL, account_id: "gmail:ada@acme.com", status: "connected", connected_at: NOW.toISOString() };
    expect(reopen().list()).toEqual([{ ...view, backfill: {} }]);
    expect(await reopen().getSecret("gmail:ada@acme.com")).toBe("token-1");
  });

  test("the same account twice is refused, and so is one a paired Mac reports", async () => {
    const { accounts } = fixture((id) => (id === WORK_SLACK.account_id ? "Mac mini" : null));
    await accounts.add(WORK_MAIL);
    await expect(accounts.add({ ...WORK_MAIL, owner_agent_id: "agent-home" })).rejects.toThrow("ada@acme.com is already connected");
    await expect(accounts.add(WORK_SLACK)).rejects.toThrow("Acme (Slack) is already connected on Mac mini");
    expect(accounts.list().map((a) => a.account_id)).toEqual(["gmail:ada@acme.com"]);
  });

  test("an account a paired Mac's last list holds is refused through PeerAccounts", async () => {
    const mini = new PeerAccounts({
      link: () => ({ request: () => Promise.resolve({ accounts: [{ ...WORK_SLACK, status: "connected", connected_at: NOW.toISOString() }] }) }),
      name: () => "Mac mini",
    });
    await mini.pull("mac-mini");
    const { accounts } = fixture((id) => mini.heldBy(id));
    await expect(accounts.add(WORK_SLACK)).rejects.toThrow("Acme (Slack) is already connected on Mac mini");
    await expect(accounts.add(WORK_MAIL)).resolves.toMatchObject({ account_id: WORK_MAIL.account_id });
  });
});

describe("moving an account", () => {
  test("a move changes the owner, keeps the record's date and cursor, and tells the listeners who had it", async () => {
    const { accounts, reopen } = fixture();
    await accounts.add(WORK_MAIL);
    accounts.setBackfill(WORK_MAIL.account_id, { days: 7, exhausted: false });
    const changes: AccountChange[] = [];
    accounts.onChange((c) => changes.push(c));
    accounts.moveOwner(WORK_MAIL.account_id, "agent-home");
    expect(reopen().get(WORK_MAIL.account_id)).toMatchObject({
      owner_agent_id: "agent-home",
      connected_at: NOW.toISOString(),
      backfill: { days: 7, exhausted: false },
    });
    expect(changes).toEqual([{ kind: "moved", account_id: WORK_MAIL.account_id, from: "agent-work" }]);
  });

  test("a move to no agent is refused and the owner stays", async () => {
    const { accounts } = fixture();
    await accounts.add(WORK_MAIL);
    expect(() => accounts.moveOwner(WORK_MAIL.account_id, "agent-gone")).toThrow(/owner/);
    expect(accounts.get(WORK_MAIL.account_id)?.owner_agent_id).toBe("agent-work");
  });
});

describe("deleting an agent that owns accounts", () => {
  test("covers AE5: refused naming both accounts; once both moved, nothing stops it", async () => {
    const { accounts } = fixture();
    await accounts.add(WORK_MAIL);
    await accounts.add(WORK_SLACK);
    const why = accounts.deleteBlocked("agent-work");
    expect(why).toContain("ada@acme.com");
    expect(why).toContain("Acme (Slack)");
    expect(accounts.deleteBlocked("agent-home")).toBeNull();
    accounts.moveOwner(WORK_MAIL.account_id, "agent-home");
    expect(accounts.deleteBlocked("agent-work")).not.toContain("ada@acme.com");
    accounts.moveOwner(WORK_SLACK.account_id, "agent-home");
    expect(accounts.deleteBlocked("agent-work")).toBeNull();
  });

  test("on another Mac, the refusal names the Mac the accounts live on, even once it is out of reach", async () => {
    let reachable = true;
    const peers = new PeerAccounts({
      link: () =>
        reachable
          ? {
              request: () =>
                Promise.resolve({ accounts: [{ ...WORK_MAIL, account_id: "gmail:ada@acme.com", status: "connected", connected_at: NOW.toISOString() }] }),
            }
          : null,
      name: (id) => (id === "mac-mini" ? "Mac mini" : "another Mac"),
    });
    await peers.pull("mac-mini");
    reachable = false;
    await peers.pull("mac-mini");
    const why = peers.deleteBlocked("agent-work");
    expect(why).toContain("Mac mini");
    expect(why).toContain("ada@acme.com");
    expect(peers.deleteBlocked("agent-home")).toBeNull();
    peers.sync([]); // unpaired: its accounts no longer count here
    expect(peers.deleteBlocked("agent-work")).toBeNull();
  });
});

describe("disconnecting and secrets", () => {
  test("disconnecting removes the record, the keychain entry and its place in the index", async () => {
    const { accounts, secrets, reopen } = fixture();
    await accounts.add(WORK_MAIL, "token-1");
    await accounts.add(WORK_SLACK);
    await accounts.setSecret(WORK_SLACK.account_id, "token-2");
    expect(JSON.parse(secrets.entries.get("accounts") ?? "[]")).toEqual([WORK_MAIL.account_id, WORK_SLACK.account_id]);
    const changes: AccountChange[] = [];
    accounts.onChange((c) => changes.push(c));
    expect(await accounts.disconnect(WORK_MAIL.account_id)).toBe(true);
    expect(secrets.entries.has(`account:${WORK_MAIL.account_id}`)).toBe(false);
    expect(JSON.parse(secrets.entries.get("accounts") ?? "[]")).toEqual([WORK_SLACK.account_id]);
    expect(
      reopen()
        .list()
        .map((a) => a.account_id),
    ).toEqual([WORK_SLACK.account_id]);
    expect(changes).toEqual([{ kind: "disconnected", account_id: WORK_MAIL.account_id }]);
    expect(await accounts.disconnect(WORK_MAIL.account_id)).toBe(false);
  });

  test("the state file holds no token text, and only its owner may read it", async () => {
    const { accounts, file } = fixture();
    await accounts.add(WORK_MAIL, "ya29.secret-access-token");
    await accounts.setSecret(WORK_MAIL.account_id, "1//refresh-token-text");
    accounts.setStatus(WORK_MAIL.account_id, { disconnected: "sign_in_again" });
    const text = readFileSync(file, "utf8");
    expect(text).not.toContain("secret-access-token");
    expect(text).not.toContain("refresh-token-text");
    expect(text).toContain("sign_in_again");
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});

import { describe, expect, test } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PEER_PROTOCOL, PeerKeys, PeerStore, mintPeerToken, parsePeerHello, type PeerHello } from "../mod/peers.ts";
import { memorySecrets } from "../daemon/credentials.ts";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

const mini: PeerHello = {
  mac_id: "11111111-2222-4333-8444-555555555555",
  name: "Mac mini",
  host: "mini.tail1234.ts.net:41415",
  build: "b1",
  protocol: PEER_PROTOCOL,
};

/** A store in a fresh folder, with a clock the test moves. */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "loki-peers-"));
  const path = join(dir, "peers.json");
  const clock = { now: Date.parse("2026-10-18T10:00:00Z") };
  return { dir, path, clock, store: new PeerStore(path, { now: () => clock.now }), done: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("the paired Macs", () => {
  test("adding a Mac keeps only the hash of the token it will present, in a file only this user can read", () => {
    const f = fixture();
    try {
      const token = mintPeerToken();
      expect(token).toMatch(/^[a-f0-9]{64}$/);
      f.store.add(mini, token);
      const raw = readFileSync(f.path, "utf8");
      expect(raw).not.toContain(token);
      expect(JSON.parse(raw)).toEqual([
        expect.objectContaining({ mac_id: mini.mac_id, name: "Mac mini", host: mini.host, token_hash: sha256(token), protocol: PEER_PROTOCOL }),
      ]);
      if (process.platform !== "win32") expect(statSync(f.path).mode & 0o777).toBe(0o600);
      expect(f.store.list()).toEqual([
        {
          mac_id: mini.mac_id,
          name: "Mac mini",
          host: mini.host,
          paired_at: "2026-10-18T10:00:00.000Z",
          last_seen_at: "2026-10-18T10:00:00.000Z",
          build: "b1",
          outdated: false,
          reachable: false,
        },
      ]);
    } finally {
      f.done();
    }
  });

  test("the token names its Mac; a changed token, a phone-shaped string and a forgotten Mac do not", () => {
    const f = fixture();
    try {
      const token = mintPeerToken();
      f.store.add(mini, token);
      expect(f.store.verify(token)?.mac_id).toBe(mini.mac_id);
      expect(f.store.verify((token.startsWith("a") ? "b" : "a") + token.slice(1))).toBeNull();
      expect(f.store.verify("not-a-token")).toBeNull();
      expect(f.store.forget(mini.mac_id)).toBe(true);
      expect(f.store.forget(mini.mac_id)).toBe(false);
      expect(f.store.verify(token)).toBeNull();
      expect(f.store.list()).toEqual([]);
    } finally {
      f.done();
    }
  });

  test("pairing the same Mac again replaces its record and its old token stops working", () => {
    const f = fixture();
    try {
      const first = mintPeerToken();
      const second = mintPeerToken();
      f.store.add(mini, first);
      f.store.add({ ...mini, name: "Ira's mini" }, second);
      expect(f.store.list().map((p) => p.name)).toEqual(["Ira's mini"]);
      expect(f.store.verify(first)).toBeNull();
      expect(f.store.verify(second)?.mac_id).toBe(mini.mac_id);
    } finally {
      f.done();
    }
  });

  test("a Mac speaking another protocol is listed as needing an update; hearing from it again records its build", () => {
    const f = fixture();
    try {
      f.store.add({ ...mini, protocol: PEER_PROTOCOL + 1 }, mintPeerToken());
      expect(f.store.list()[0].outdated).toBe(true);
      f.clock.now += 5 * 60_000;
      f.store.heard({ ...mini, build: "b2" });
      const again = new PeerStore(f.path, { now: () => f.clock.now });
      expect(again.list()[0]).toMatchObject({ build: "b2", outdated: false, last_seen_at: "2026-10-18T10:05:00.000Z" });
    } finally {
      f.done();
    }
  });

  test("an unreadable file means no paired Macs", () => {
    const f = fixture();
    try {
      expect(new PeerStore(join(f.dir, "missing.json")).list()).toEqual([]);
    } finally {
      f.done();
    }
  });
});

describe("a Mac's hello", () => {
  test("is read from what another Mac sent, or refused", () => {
    expect(parsePeerHello({ ...mini })).toEqual(mini);
    expect(parsePeerHello({ ...mini, build: null })).toEqual({ ...mini, build: null });
    expect(parsePeerHello({ ...mini, mac_id: "../x" })).toBeNull();
    expect(parsePeerHello({ ...mini, protocol: "1" })).toBeNull();
    expect(parsePeerHello({ ...mini, name: "" })).toBeNull();
    expect(parsePeerHello(null)).toBeNull();
  });

  test("a host that is not an address is refused: it would be dialled, and fail, on every start", () => {
    expect(parsePeerHello({ ...mini, host: "mini.tail1234.ts.net" })).toEqual({ ...mini, host: "mini.tail1234.ts.net" });
    expect(parsePeerHello({ ...mini, host: "100.64.0.7" })?.host).toBe("100.64.0.7");
    expect(parsePeerHello({ ...mini, host: "bad host" })).toBeNull();
    expect(parsePeerHello({ ...mini, host: "mini:99999" })).toBeNull();
    expect(parsePeerHello({ ...mini, host: "mini:0" })).toBeNull();
    expect(parsePeerHello({ ...mini, host: "" })).toBeNull();
  });
});

describe("the tokens this Mac presents", () => {
  test("live in the keychain under the other Mac's id and go when it is forgotten", async () => {
    const secrets = memorySecrets();
    const keys = new PeerKeys(secrets);
    await keys.set(mini.mac_id, "a".repeat(64));
    expect(await keys.get(mini.mac_id)).toBe("a".repeat(64));
    expect([...secrets.entries.keys()]).toEqual([`peer:${mini.mac_id}`]);
    await keys.delete(mini.mac_id);
    expect(await keys.get(mini.mac_id)).toBeNull();
  });
});

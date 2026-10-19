import { describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INVITE_TTL_MS, PEER_PROTOCOL, PeerKeys, PeerStore, Peers, mintPeerToken, type PeerHello } from "../mod/peers.ts";
import { PairingCodes } from "../mod/pairing.ts";
import { memorySecrets } from "../daemon/credentials.ts";

const hello = (macId: string, name: string): PeerHello => ({
  mac_id: macId,
  name,
  host: `${name}.tail1234.ts.net:41415`,
  build: null,
  protocol: PEER_PROTOCOL,
});
const BOOK = hello("aaaaaaaa-1111-4111-8111-111111111111", "book");
const MINI = hello("bbbbbbbb-2222-4222-8222-222222222222", "mini");
const THIRD = hello("cccccccc-3333-4333-8333-333333333333", "third");

/** The MacBook's pairing, in a fresh folder, with a clock the test moves. */
function book() {
  const dir = mkdtempSync(join(tmpdir(), "loki-invites-"));
  const clock = { now: Date.parse("2026-10-19T10:00:00Z") };
  const store = new PeerStore(join(dir, "peers.json"), { now: () => clock.now });
  const peers = new Peers({ store, keys: new PeerKeys(memorySecrets()), codes: new PairingCodes(), me: () => BOOK, now: () => clock.now });
  const pairBy = (code: string, from: PeerHello) => peers.accept({ code, hello: from, token: mintPeerToken() });
  return { dir, clock, store, peers, pairBy, done: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("an invite for a Mac being introduced (plan 023, addendum D4)", () => {
  test("pairs the Mac it is for, once, with this Mac's address to redeem it at", async () => {
    const b = book();
    try {
      const invite = b.peers.invite(THIRD.mac_id);
      expect(invite?.host).toBe(BOOK.host);
      expect(invite?.code).toMatch(/^[a-f0-9]{64}$/);
      expect((await b.pairBy(invite?.code ?? "", THIRD)).status).toBe(200);
      expect(b.store.get(THIRD.mac_id)).not.toBeNull();
      // Spent: the same invite pairs nothing again.
      expect((await b.pairBy(invite?.code ?? "", THIRD)).status).toBe(404);
    } finally {
      b.done();
    }
  });

  test("is refused for another Mac, once expired, and is spent even by a wrong use", async () => {
    const b = book();
    try {
      const forThird = b.peers.invite(THIRD.mac_id)?.code ?? "";
      expect((await b.pairBy(forThird, MINI)).status).toBe(404);
      expect((await b.pairBy(forThird, THIRD)).status).toBe(404);
      const late = b.peers.invite(THIRD.mac_id)?.code ?? "";
      b.clock.now += INVITE_TTL_MS + 1;
      expect((await b.pairBy(late, THIRD)).status).toBe(404);
      expect(b.store.get(THIRD.mac_id)).toBeNull();
    } finally {
      b.done();
    }
  });

  test("is never made for a Mac forgotten here on purpose, until it is paired again by code", async () => {
    const b = book();
    try {
      await b.pairBy(b.peers.invite(MINI.mac_id)?.code ?? "", MINI);
      await b.peers.forget(MINI.mac_id);
      expect(b.store.isForgotten(MINI.mac_id)).toBe(true);
      expect(b.peers.invite(MINI.mac_id)).toBeNull();
      // Kept across a restart.
      expect(new PeerStore(join(b.dir, "peers.json")).isForgotten(MINI.mac_id)).toBe(true);
      // Paired again by a code the person typed: part of the group again.
      const codes = new PairingCodes();
      const again = new Peers({ store: b.store, keys: new PeerKeys(memorySecrets()), codes, me: () => BOOK });
      const typed = codes.mint().code;
      expect((await again.accept({ code: typed, hello: MINI, token: mintPeerToken() })).status).toBe(200);
      expect(b.store.isForgotten(MINI.mac_id)).toBe(false);
      expect(b.peers.invite(BOOK.mac_id)).toBeNull(); // never for itself
    } finally {
      b.done();
    }
  });
});

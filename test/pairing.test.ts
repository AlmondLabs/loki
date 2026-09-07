import { describe, expect, test } from "bun:test";
import { PAIRING_ALPHABET, PAIRING_TTL_MS, PairingCodes } from "../mod/pairing.ts";

describe("pairing codes", () => {
  test("alphabet has no 0/O/1/I and codes are six characters from it", () => {
    for (const ch of "0O1I") expect(PAIRING_ALPHABET).not.toContain(ch);
    expect(PAIRING_ALPHABET).toBe("ABCDEFGHJKLMNPQRSTUVWXYZ23456789");
    const codes = new PairingCodes();
    for (let i = 0; i < 50; i++) {
      const { code } = codes.mint();
      expect(code).toHaveLength(6);
      for (const ch of code) expect(PAIRING_ALPHABET).toContain(ch);
    }
  });

  test("redeems more than once inside the window; unknown and expired are refused", () => {
    let now = Date.parse("2026-09-07T10:00:00Z");
    const codes = new PairingCodes({ now: () => now });
    const { code, expiresAt } = codes.mint();
    expect(expiresAt).toBe(new Date(now + PAIRING_TTL_MS).toISOString());
    expect(PAIRING_TTL_MS).toBe(10 * 60_000);
    expect(codes.redeem(code)).toBe(true);
    expect(codes.redeem(code)).toBe(true); // a Home Screen web app has its own cookie jar
    expect(codes.redeem(code.toLowerCase())).toBe(true); // typed on a phone keyboard
    expect(codes.redeem("ZZZZZZ")).toBe(false);
    expect(codes.redeem("")).toBe(false);
    now += 9 * 60_000;
    expect(codes.redeem(code)).toBe(true);
    now += 61_000;
    expect(codes.redeem(code)).toBe(false);
  });
});

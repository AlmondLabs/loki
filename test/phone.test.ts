import { describe, expect, test } from "bun:test";
import { CODE_ALPHABET, CODE_LENGTH, codeFromUrl, countdown, deviceKind, deviceName, lastSeen, normalizeCode, pairUrl } from "../app/src/phone/model.ts";

/**
 * The phone's pure bits (app/src/phone/model.ts): the pairing URL both ways, the device label,
 * the "last seen" wording. No DOM — these run under bun and fence the copy Settings and the
 * phone page agree on.
 */

describe("pairing URL", () => {
  test("the code comes out of the QR's URL", () => {
    expect(codeFromUrl("http://10.0.0.5:41415/?code=Q7K2M9")).toBe("Q7K2M9");
  });
  test("no code → null", () => {
    expect(codeFromUrl("http://10.0.0.5:41415/")).toBeNull();
    expect(codeFromUrl("http://10.0.0.5:41415/?desk=shared")).toBeNull();
    expect(codeFromUrl("?code=")).toBeNull();
  });
  test("a bare query string works too (location.search)", () => {
    expect(codeFromUrl("?code=q7k2m9")).toBe("Q7K2M9");
  });
  test("a code of the wrong length is not a code", () => {
    expect(codeFromUrl("http://10.0.0.5:41415/?code=Q7K")).toBeNull();
  });
  test("the builder Settings prints is the exact string", () => {
    expect(pairUrl("10.0.0.5", 41415, "Q7K2M9")).toBe("http://10.0.0.5:41415/?code=Q7K2M9");
    expect(pairUrl("192.168.1.3", 41415, "ABCDEF")).toBe("http://192.168.1.3:41415/?code=ABCDEF");
  });
  test("an IPv6 host gets brackets", () => {
    expect(pairUrl("fe80::1", 41415, "Q7K2M9")).toBe("http://[fe80::1]:41415/?code=Q7K2M9");
  });
  test("builder and parser agree", () => {
    expect(codeFromUrl(pairUrl("10.0.0.5", 41415, "Q7K2M9"))).toBe("Q7K2M9");
  });
});

describe("code field", () => {
  test("uppercases, drops characters outside the alphabet, caps at six", () => {
    expect(normalizeCode("q7k2m9")).toBe("Q7K2M9");
    expect(normalizeCode("q7-k2 m9x")).toBe("Q7K2M9");
    expect(normalizeCode("O0I1")).toBe(""); // the alphabet has no O/0/I/1
  });
  test("the alphabet is the mod's: 32 characters, six long", () => {
    expect(CODE_ALPHABET).toBe("ABCDEFGHJKLMNPQRSTUVWXYZ23456789");
    expect(CODE_LENGTH).toBe(6);
  });
});

describe("device name", () => {
  const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1";
  const IPAD = "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
  const IPADOS_DESKTOP_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
  const ANDROID = "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36";
  const OTHER = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
  test("kinds", () => {
    expect(deviceKind(IPHONE)).toBe("iPhone");
    expect(deviceKind(IPAD)).toBe("iPad");
    expect(deviceKind(IPADOS_DESKTOP_UA, 5)).toBe("iPad"); // iPadOS Safari says Macintosh; touch points tell
    expect(deviceKind(IPADOS_DESKTOP_UA, 0)).toBe("phone");
    expect(deviceKind(ANDROID)).toBe("Android");
    expect(deviceKind(OTHER)).toBe("phone");
  });
  test("the label is the kind plus the time", () => {
    const at = new Date(2026, 8, 7, 14, 5);
    expect(deviceName(IPHONE, at)).toBe("iPhone · 14:05");
    expect(deviceName(IPAD, at)).toBe("iPad · 14:05");
    expect(deviceName(ANDROID, at)).toBe("Android · 14:05");
    expect(deviceName(OTHER, at)).toBe("phone · 14:05");
    expect(deviceName(OTHER, new Date(2026, 0, 1, 9, 7))).toBe("phone · 09:07");
  });
});

describe("last seen", () => {
  const now = Date.parse("2026-09-07T12:00:00Z");
  const ago = (ms: number) => new Date(now - ms).toISOString();
  test("under a minute is just now", () => {
    expect(lastSeen(ago(20_000), now)).toBe("just now");
  });
  test("90 s → 1 minute ago", () => {
    expect(lastSeen(ago(90_000), now)).toBe("1 minute ago");
  });
  test("3 h → 3 hours ago", () => {
    expect(lastSeen(ago(3 * 3600_000), now)).toBe("3 hours ago");
  });
  test("2 d → 2 days ago", () => {
    expect(lastSeen(ago(2 * 86_400_000), now)).toBe("2 days ago");
  });
  test("plurals and singulars", () => {
    expect(lastSeen(ago(5 * 60_000), now)).toBe("5 minutes ago");
    expect(lastSeen(ago(3600_000), now)).toBe("1 hour ago");
    expect(lastSeen(ago(86_400_000), now)).toBe("1 day ago");
  });
  test("nothing known → never", () => {
    expect(lastSeen(null, now)).toBe("never");
  });
});

describe("countdown", () => {
  const now = Date.parse("2026-09-07T12:00:00Z");
  test("m:ss until expiry", () => {
    expect(countdown(new Date(now + 9 * 60_000 + 58_000).toISOString(), now)).toBe("9:58");
    expect(countdown(new Date(now + 5_000).toISOString(), now)).toBe("0:05");
  });
  test("past → expired", () => {
    expect(countdown(new Date(now - 1000).toISOString(), now)).toBe("expired");
  });
});

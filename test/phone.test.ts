import { describe, expect, test } from "bun:test";
import { AUTO_RELOAD_HIDDEN_MS, CODE_ALPHABET, CODE_LENGTH, codeFromUrl, countdown, deviceKind, deviceName, lastSeen, liveDeskCount, liveDesksLabel, memoryFolders, needsReload, normalizeCode, shouldAutoReload, stripFrontmatter } from "../app/src/phone/model.ts";
import { deskMark } from "../app/src/shell/DeskTree.tsx";
import type { AttentionItem } from "../packages/core/src/attention/model.ts";
import { PAIRING_ALPHABET, PAIRING_LENGTH } from "../packages/core/src/pairing-code.ts";

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
  test("the phone's alphabet is the mod's, so a typed code matches a minted one", () => {
    expect(CODE_ALPHABET).toBe(PAIRING_ALPHABET);
    expect(CODE_LENGTH).toBe(PAIRING_LENGTH);
    expect(codeFromUrl("http://deepaks-macbook-pro.local:41415/?code=Q7K2M9")).toBe("Q7K2M9");
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

describe("agents on the phone", () => {
  const desks = [
    { agentId: "a1", status: "live" },
    { agentId: "a1", status: "live" },
    { agentId: "a1", status: "archived" },
    { agentId: "a2", status: "live" },
    { agentId: null, status: "live" },
  ];
  test("live desks per agent", () => {
    expect(liveDeskCount(desks, "a1")).toBe(2);
    expect(liveDeskCount(desks, "a2")).toBe(1);
    expect(liveDeskCount(desks, "a3")).toBe(0);
  });
  test("the label", () => {
    expect(liveDesksLabel(0)).toBe("no desks live");
    expect(liveDesksLabel(1)).toBe("1 desk live");
    expect(liveDesksLabel(3)).toBe("3 desks live");
  });
  test("memory folders: system first, root last, skills and the face left out", () => {
    const at = "2026-09-07T12:00:00Z";
    const folders = memoryFolders([
      { path: "reference/notes.md", bytes: 10, modifiedAt: at },
      { path: "profile.png", bytes: 999, modifiedAt: at },
      { path: "skills/loki/SKILL.md", bytes: 5, modifiedAt: at },
      { path: "system/persona.md", bytes: 20, modifiedAt: at },
      { path: "system/human.md", bytes: 30, modifiedAt: at },
      { path: "README.md", bytes: 1, modifiedAt: at },
      { path: "reference/deep/more.md", bytes: 2, modifiedAt: at },
    ]);
    expect(folders.map((f) => f.name)).toEqual(["system", "reference", ""]);
    expect(folders[0].files.map((f) => f.name)).toEqual(["persona.md", "human.md"]);
    expect(folders[1].files.map((f) => f.name)).toEqual(["notes.md", "deep/more.md"]);
    expect(folders[2].files.map((f) => f.name)).toEqual(["README.md"]);
    expect(folders[1].files[0].path).toBe("reference/notes.md");
  });
});

describe("the desk's attention dot (shell/DeskTree deskMark, shared with Home)", () => {
  const item = (over: Partial<AttentionItem>): AttentionItem =>
    ({ id: "c", agentId: "a", agentName: "ira", title: "t", status: "done", unread: false, snooze: null, lastMessageAt: null, lastAssistantText: null, pendingApproval: null, pendingQuestion: null, error: null, runtime: { agent_id: "a", conversation_id: "c" }, ...over }) as AttentionItem;
  test("waits on you: brass, filled", () => {
    const m = deskMark(item({ status: "approval" }), "live");
    expect(m.kind).toBe("waits");
    expect(m.color).toBe("var(--loki-accent)");
    expect(m.border).toBe("var(--loki-accent)");
    expect(deskMark(item({ status: "question" }), "live").kind).toBe("waits");
  });
  test("finished unread: a brass ring", () => {
    const m = deskMark(item({ status: "done", unread: true }), "live");
    expect(m.kind).toBe("finished");
    expect(m.color).toBe("transparent");
    expect(m.border).toBe("var(--loki-accent)");
  });
  test("finished and read, or snoozed: nothing", () => {
    expect(deskMark(item({ status: "done", unread: false }), "live").kind).toBe("none");
    expect(deskMark(item({ status: "done", unread: true, snooze: { until: "2026-09-08T00:00:00Z" } as unknown as AttentionItem["snooze"] }), "live").kind).toBe("none");
  });
  test("running: a muted ring that pulses", () => {
    const m = deskMark(item({ status: "running" }), "live");
    expect(m.kind).toBe("running");
    expect(m.border).toBe("var(--loki-muted)");
    expect(m.pulse).toBe(true);
  });
  test("failed: oxblood", () => {
    expect(deskMark(item({ status: "failed" }), "live").kind).toBe("failed");
  });
  test("no item: nothing; archived and deleted override the item", () => {
    expect(deskMark(undefined, "live").kind).toBe("none");
    expect(deskMark(item({ status: "approval" }), "archived").kind).toBe("archived");
    expect(deskMark(item({ status: "approval" }), "deleted").kind).toBe("deleted");
  });
});

describe("memory file frontmatter", () => {
  test("the YAML block at the top goes; the body stays", () => {
    expect(stripFrontmatter("---\ndescription: who I am\n---\n\n# Persona\n\nText.")).toBe("\n# Persona\n\nText.");
    expect(stripFrontmatter("# No frontmatter\n\n---\n\nrule above")).toBe("# No frontmatter\n\n---\n\nrule above");
    expect(stripFrontmatter("")).toBe("");
  });
});

describe("reloading a newer canvas", () => {
  test("a different served build needs a reload; unknown on either side does not", () => {
    expect(needsReload("abc123def456", "abc123def456")).toBe(false);
    expect(needsReload("abc123def456", "0123456789ab")).toBe(true);
    expect(needsReload(null, "abc")).toBe(false);
    expect(needsReload("abc", null)).toBe(false);
    expect(needsReload("abc", undefined)).toBe(false);
  });
  test("auto-reload only after a long time in the background, and only on a change", () => {
    expect(shouldAutoReload(AUTO_RELOAD_HIDDEN_MS + 1, true)).toBe(true);
    expect(shouldAutoReload(AUTO_RELOAD_HIDDEN_MS, true)).toBe(false);
    expect(shouldAutoReload(5_000, true)).toBe(false);
    expect(shouldAutoReload(120_000, false)).toBe(false);
    expect(shouldAutoReload(NaN, true)).toBe(false);
  });
});

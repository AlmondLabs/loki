import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureToken, homeFrom, lokiGlobals, newToken, pageOs, settingsPage } from "../desktop/env.ts";
import { isBenignWindowError } from "../app/src/workspace/env.ts";

const made: string[] = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "loki-desktop-env-"));
  made.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("the capability token", () => {
  test("a new token is 32 lowercase hex characters, fresh each time", () => {
    const a = newToken();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(newToken()).not.toBe(a);
  });

  test("a missing token file is made private from the start, in a private folder", () => {
    const loki = join(temp(), ".loki");
    const token = ensureToken(loki, () => {});
    expect(token).toMatch(/^[0-9a-f]{32}$/);
    expect(readFileSync(join(loki, "token"), "utf8")).toBe(token);
    if (process.platform !== "win32") {
      expect(statSync(loki).mode & 0o777).toBe(0o700);
      expect(statSync(join(loki, "token")).mode & 0o777).toBe(0o600);
    }
  });

  test("a token already there is read, trimmed, and never replaced", () => {
    const loki = join(temp(), ".loki");
    mkdirSync(loki);
    writeFileSync(join(loki, "token"), "abc123\n");
    expect(ensureToken(loki, () => {})).toBe("abc123");
    expect(readFileSync(join(loki, "token"), "utf8")).toBe("abc123\n");
  });
});

describe("home and the page's globals", () => {
  test("home is the platform's own variable and never empty", () => {
    expect(homeFrom(true, { USERPROFILE: "C:\\Users\\a", HOME: "/x" })).toBe("C:\\Users\\a");
    expect(homeFrom(false, { USERPROFILE: "C:\\Users\\a", HOME: "/Users/a" })).toBe("/Users/a");
    expect(homeFrom(false, { HOME: "" })).toBeNull();
    expect(homeFrom(true, {})).toBeNull();
  });

  test("the page is told its system in one of three words", () => {
    expect(pageOs("darwin")).toBe("macos");
    expect(pageOs("win32")).toBe("windows");
    expect(pageOs("linux")).toBe("linux");
    expect(pageOs("freebsd")).toBe("linux");
  });

  test("the main window gets the token, the mod's port, the desk and the system", () => {
    expect(lokiGlobals({ token: "t", env: { LOKI_PORT: "4100", LOKI_DESK: "work" }, os: "macos" })).toEqual({
      token: "t",
      modPort: 4100,
      desk: "work",
      os: "macos",
    });
    expect(lokiGlobals({ token: "t", env: { LOKI_PORT: "nope" }, os: "linux" })).toEqual({ token: "t", modPort: 41414, desk: null, os: "linux" });
  });

  test("the settings window is told which it is, and only a plain page name", () => {
    expect(lokiGlobals({ token: "t", env: {}, os: "macos", settings: "providers" })).toMatchObject({ window: "settings", page: "providers" });
    expect(lokiGlobals({ token: "t", env: {}, os: "macos", settings: null })).toMatchObject({ window: "settings", page: null });
    expect(settingsPage("phone-pairing")).toBe("phone-pairing");
    expect(settingsPage("../x")).toBeNull();
    expect(settingsPage("A")).toBeNull();
    expect(settingsPage("a".repeat(33))).toBeNull();
    expect(settingsPage(7)).toBeNull();
  });
});

describe("benign browser window errors", () => {
  test("ignores Chromium ResizeObserver loop notifications while keeping real errors", () => {
    expect(isBenignWindowError("ResizeObserver loop completed with undelivered notifications.")).toBe(true);
    expect(isBenignWindowError("ResizeObserver loop limit exceeded")).toBe(true);
    expect(isBenignWindowError("TypeError: Cannot read properties of undefined")).toBe(false);
  });
});

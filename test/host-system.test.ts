import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { keyboardFrom, platformFrom } from "../app/src/desk/env.ts";
import { browseWith } from "../app/src/desk/NewDesk.tsx";
import { formatKeys, keyFor, cmdHeld } from "../app/src/shell/keymap.ts";
import { osWords, runsOn } from "../app/src/shell/osWords.ts";
import { SystemFact } from "../app/src/settings/Settings.tsx";
import { HostSystemRow } from "../app/src/phone/Settings.tsx";
import { bootScript, hostOs } from "../mod/static.ts";

/**
 * Two systems, not one: the one loki runs on (the host: the shell's or the mod's word) and the one the viewer
 * types on (the keyboard: the host in the app, the user agent in a browser tab). A Mac loki opened from Chrome
 * on Windows is still a Mac loki, with Ctrl keys.
 */
const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)";
const WIN = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const ANDROID = "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36";
const text = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&#x27;/g, "'");

describe("host and keyboard", () => {
  test("in the app both are the shell's word", () => {
    expect(platformFrom("windows", WIN)).toBe("windows");
    expect(keyboardFrom(true, "windows", WIN)).toBe("windows");
    expect(platformFrom("macos", MAC)).toBe("macos");
    expect(keyboardFrom(true, "macos", MAC)).toBe("macos");
  });
  test("a phone on the Wi‑Fi viewing a Mac: the host is the Mac, the keyboard the phone's", () => {
    expect(platformFrom("macos", ANDROID)).toBe("macos");
    expect(keyboardFrom(false, "macos", ANDROID)).toBe("linux");
  });
  test("Chrome on Windows viewing a Mac: a Mac loki, typed on with Ctrl", () => {
    expect(platformFrom("macos", WIN)).toBe("macos");
    expect(keyboardFrom(false, "macos", WIN)).toBe("windows");
  });
  test("an unknown word: both fall to the user agent", () => {
    expect(platformFrom("beos", WIN)).toBe("windows");
    expect(keyboardFrom(false, "beos", WIN)).toBe("windows");
    expect(keyboardFrom(true, "beos", WIN)).toBe("windows");
    expect(platformFrom(undefined, "")).toBe("macos");
  });
});

describe("the mod tells a browser tab the host", () => {
  test("process.platform in the page's words", () => {
    expect(hostOs("darwin")).toBe("macos");
    expect(hostOs("win32")).toBe("windows");
    expect(hostOs("linux")).toBe("linux");
    expect(hostOs("freebsd")).toBe("linux");
  });
  test("the boot script carries os, with or without a build", () => {
    expect(bootScript("abc123def456", "macos")).toBe('<script>window.__LOKI__={lan:true,build:"abc123def456",os:"macos"}</script>');
    expect(bootScript(null, "windows")).toBe('<script>window.__LOKI__={lan:true,os:"windows"}</script>');
    expect(bootScript("abc123def456")).toContain(`os:"${hostOs(process.platform)}"`);
  });
});

describe("what reads the host, what reads the keyboard", () => {
  const host = platformFrom("macos", WIN);
  const keys = keyboardFrom(false, "macos", WIN);
  test("a Windows tab on a Mac loki offers Browse through the mod and names the Mac", () => {
    expect(browseWith(false, host)).toBe("mod");
    expect(osWords(host).machine).toBe("this Mac");
  });
  test("…and prints and hears Ctrl", () => {
    expect(formatKeys("cmd+k", keys)).toBe("Ctrl K");
    expect(keyFor("search.open", keys)).toBe("Ctrl K");
    expect(cmdHeld({ metaKey: false, ctrlKey: true }, keys)).toBe(true);
  });
});

describe("the System fact says where loki runs", () => {
  test("in the app: this machine", () => {
    expect(runsOn("macos", true)).toBe("loki runs on this Mac (macOS)");
    expect(runsOn("windows", true)).toBe("loki runs on this PC (Windows)");
    expect(runsOn("linux", true)).toBe("loki runs on this computer (Linux)");
  });
  test("in a browser tab: a machine, viewed from a browser", () => {
    expect(runsOn("macos", false)).toBe("loki runs on a Mac (macOS); you're viewing it in a browser");
    expect(runsOn("windows", false)).toBe("loki runs on a PC (Windows); you're viewing it in a browser");
    expect(runsOn("linux", false)).toBe("loki runs on a computer (Linux); you're viewing it in a browser");
  });
  test("the fact keeps the system's requirements under it", () => {
    const out = text(renderToStaticMarkup(createElement(SystemFact, { os: "macos", shell: true })));
    expect(out).toContain("System");
    expect(out).toContain("loki runs on this Mac (macOS)");
    expect(out).toContain(osWords("macos").system);
    expect(text(renderToStaticMarkup(createElement(SystemFact, { os: "windows", shell: false })))).toContain("loki runs on a PC (Windows); you're viewing it in a browser");
  });
  test("the phone's connection page names the host's system", () => {
    expect(text(renderToStaticMarkup(createElement(HostSystemRow, { os: "macos" })))).toBe("SystemmacOS");
    expect(text(renderToStaticMarkup(createElement(HostSystemRow, { os: "linux" })))).toBe("SystemLinux");
  });
});

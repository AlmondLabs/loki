import { describe, expect, test } from "vitest";
import { linkLeavesLoki, mainWindowOptions, sameOrigin, settingsWindowOptions, WINDOW_GROUND } from "../desktop/windows.ts";

describe("the windows' look", () => {
  test("on the Mac the window is transparent with the sidebar material and the lights inset; elsewhere it is frameless on loki's ground", () => {
    expect(mainWindowOptions("macos", "/p.cjs")).toMatchObject({
      width: 1440,
      height: 900,
      minWidth: 900,
      minHeight: 600,
      titleBarStyle: "hidden",
      transparent: true,
      vibrancy: "sidebar",
      visualEffectState: "followWindow",
      webPreferences: { preload: "/p.cjs", contextIsolation: true, sandbox: true, nodeIntegration: false },
    });
    expect(mainWindowOptions("windows", "/p.cjs")).toMatchObject({ frame: false, backgroundColor: WINDOW_GROUND });
    expect(mainWindowOptions("linux", "/p.cjs").vibrancy).toBeUndefined();
  });

  test("the settings window is smaller and has the same chrome", () => {
    expect(settingsWindowOptions("macos", "/p.cjs")).toMatchObject({ width: 820, height: 600, minWidth: 680, minHeight: 460, vibrancy: "sidebar" });
  });
});

describe("where a link may go", () => {
  test("http, https and mailto leave loki for the browser; file, smb and other schemes go nowhere", () => {
    expect(linkLeavesLoki("https://example.com")).toBe(true);
    expect(linkLeavesLoki("mailto:a@example.com")).toBe(true);
    expect(linkLeavesLoki("file:///etc/passwd")).toBe(false);
    expect(linkLeavesLoki("smb://host/share")).toBe(false);
    expect(linkLeavesLoki("vscode://open")).toBe(false);
    expect(linkLeavesLoki("not a url")).toBe(false);
  });

  test("the window never navigates away from loki's own page", () => {
    expect(sameOrigin("loki://app/index.html#x", "loki://app")).toBe(true);
    expect(sameOrigin("https://example.com", "loki://app")).toBe(false);
  });
});

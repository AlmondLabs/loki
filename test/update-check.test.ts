import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Platform } from "../app/src/desk/env.ts";
import { LokiVersionFact } from "../app/src/settings/Settings.tsx";
import { downloadFor, type LokiUpdate, type Release } from "../app/src/shell/useLokiUpdate.ts";

/**
 * The update check links this system's file from the release (plan 014 U10, KTD13, R11), else the release page.
 * Windows and Linux files only ever come on a stable, from its preview PR after the Mac's; a nightly is Mac-only.
 */

const page = "https://github.com/owner/loki/releases/tag/v2026.9.28";
const asset = (name: string) => ({ name, browser_download_url: `https://github.com/owner/loki/releases/download/v2026.9.28/${name}` });
const v = "2026.9.28";
const release: Release = {
  tag_name: `v${v}`,
  name: `loki ${v}`,
  html_url: page,
  assets: [asset(`loki_${v}_universal.dmg`), asset("cask.rb"), asset(`loki_${v}_x64-setup.exe`), asset(`loki_${v}_amd64.AppImage`), asset(`loki_${v}_amd64.deb`)],
};
// a stable before its preview PR is merged, and every nightly: the Mac's files alone
const macOnly: Release = { ...release, assets: [asset(`loki_${v}_universal.dmg`), asset("cask.rb")] };

describe("the download for this system", () => {
  test("the .dmg on the Mac, the -setup.exe on Windows, the AppImage on Linux", () => {
    expect(downloadFor(release, "macos")).toBe(asset(`loki_${v}_universal.dmg`).browser_download_url);
    expect(downloadFor(release, "windows")).toBe(asset(`loki_${v}_x64-setup.exe`).browser_download_url);
    expect(downloadFor(release, "linux")).toBe(asset(`loki_${v}_amd64.AppImage`).browser_download_url);
  });

  test("Linux takes the .deb when the release has no AppImage", () => {
    const noAppImage = { ...release, assets: release.assets!.filter((a) => !a.name.endsWith(".AppImage")) };
    expect(downloadFor(noAppImage, "linux")).toBe(asset(`loki_${v}_amd64.deb`).browser_download_url);
  });

  test("a release without this system's file falls back to the release page", () => {
    expect(downloadFor(macOnly, "windows")).toBe(page);
    expect(downloadFor(macOnly, "linux")).toBe(page);
    expect(downloadFor({ html_url: page }, "macos")).toBe(page);
    expect(downloadFor({}, "windows")).toBeNull();
  });
});

describe("Settings' version fact", () => {
  const update: LokiUpdate = { current: "2026.9.27", channel: "stable", latest: v, url: page, download: null, issues: "https://github.com/owner/loki/issues", newer: true, error: null };
  const html = (os: Platform, u: LokiUpdate = update, r: Release = release) => renderToStaticMarkup(createElement(LokiVersionFact, { update: { ...u, download: downloadFor(r, os) }, os }));

  test("Windows and Linux say preview, link the issues, and link this system's file", () => {
    for (const os of ["windows", "linux"] as const) {
      const out = html(os);
      expect(out).toContain("preview");
      expect(out).toContain("built and tested in CI, not yet tried on real machines");
      expect(out).toContain('href="https://github.com/owner/loki/issues"');
      expect(out).toContain(`href="${downloadFor(release, os)}"`);
    }
    expect(html("windows")).toContain("-setup.exe");
    expect(html("linux")).toContain("AppImage");
  });

  test("a newer stable whose Windows and Linux files are not attached yet says so, and links the release page", () => {
    for (const os of ["windows", "linux"] as const) {
      const out = html(os, update, macOnly);
      expect(out).toContain("not on the release yet");
      expect(out).toContain(`href="${page}"`);
      expect(out).not.toContain("download the");
    }
  });

  test("the preview line shows with no newer release too", () => {
    expect(html("linux", { ...update, newer: false, latest: null })).toContain("preview");
  });

  test("the Mac's fact says no preview and keeps the brew line, on either channel", () => {
    const out = html("macos", update, macOnly);
    expect(out).not.toContain("preview");
    expect(out).not.toContain("/issues");
    expect(out).toContain("brew upgrade --cask loki,");
    const nightly = html("macos", { ...update, current: "2026.9.27-nightly.1111111", channel: "nightly", latest: "2026.9.28-nightly.a96ee85" }, macOnly);
    expect(nightly).toContain("brew upgrade --cask loki-nightly");
    expect(nightly).not.toContain("not on the release yet");
  });
});

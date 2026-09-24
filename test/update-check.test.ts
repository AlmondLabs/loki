import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Platform } from "../app/src/desk/env.ts";
import { LokiVersionFact } from "../app/src/settings/Settings.tsx";
import { downloadFor, type LokiUpdate, type Release } from "../app/src/shell/useLokiUpdate.ts";

/** The update check links this system's file from the release (plan 014 U10, KTD13, R11), else the release page. */

const page = "https://github.com/owner/loki/releases/tag/nightly";
const asset = (name: string) => ({ name, browser_download_url: `https://github.com/owner/loki/releases/download/nightly/${name}` });
const v = "2026.9.28-nightly.a96ee85";
const release: Release = {
  tag_name: "nightly",
  name: `loki ${v}`,
  html_url: page,
  assets: [asset(`loki_${v}_universal.dmg`), asset(`loki_${v}_x64-setup.exe`), asset(`loki_${v}_amd64.AppImage`), asset(`loki_${v}_amd64.deb`), asset("cask.rb")],
};

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
    const macOnly = { ...release, assets: [asset(`loki_${v}_universal.dmg`), asset("cask.rb")] };
    expect(downloadFor(macOnly, "windows")).toBe(page);
    expect(downloadFor(macOnly, "linux")).toBe(page);
    expect(downloadFor({ html_url: page }, "macos")).toBe(page);
    expect(downloadFor({}, "windows")).toBeNull();
  });
});

describe("Settings' version fact", () => {
  const update: LokiUpdate = { current: "2026.9.27-nightly.1111111", channel: "nightly", latest: v, url: page, download: null, issues: "https://github.com/owner/loki/issues", newer: true, error: null };
  const html = (os: Platform, u: LokiUpdate = update) => renderToStaticMarkup(createElement(LokiVersionFact, { update: { ...u, download: downloadFor(release, os) }, os }));

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

  test("the preview line shows with no newer release too", () => {
    expect(html("linux", { ...update, newer: false, latest: null })).toContain("preview");
  });

  test("the Mac's fact says no preview and keeps the brew line", () => {
    const out = html("macos");
    expect(out).not.toContain("preview");
    expect(out).not.toContain("/issues");
    expect(out).toContain("brew upgrade --cask loki-nightly");
  });
});

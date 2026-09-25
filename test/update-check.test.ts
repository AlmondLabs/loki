import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Platform } from "../app/src/desk/env.ts";
import { LokiVersionFact } from "../app/src/settings/Settings.tsx";
import { downloadFor, newestWith, type LokiUpdate, type Release } from "../app/src/shell/useLokiUpdate.ts";

/**
 * The update check links this system's file from the release (plan 014 U10, KTD13, R11), else the release page.
 * Windows and Linux files only ever come on a stable, from their own PR, before or after the Mac's; a nightly is
 * Mac-only. So Windows and Linux look for the newest release that has their file, not the one marked latest.
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
// a stable before its Windows and Linux PR is merged, and every nightly: the Mac's files alone
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

describe("the release Windows and Linux follow: the newest with their file", () => {
  const rel = (tag: string, names: string[], extra: Partial<Release> & { prerelease?: boolean; draft?: boolean } = {}): Release => ({ tag_name: tag, name: `loki ${tag.slice(1)}`, html_url: `https://github.com/owner/loki/releases/tag/${tag}`, assets: names.map(asset), ...extra });
  const winLinux = (d: string) => [`loki_${d}_x64-setup.exe`, `loki_${d}_amd64.AppImage`, `loki_${d}_amd64.deb`];
  // newest first, as GitHub lists them: the Mac shipped 9.30 alone, 9.29 is Windows and Linux alone (not latest), 9.28 has both
  const list: Release[] = [
    rel("nightly", ["loki_2026.9.30-nightly.abcdef0_universal.dmg"], { prerelease: true }),
    rel("v2026.9.30", ["loki_2026.9.30_universal.dmg", "cask.rb"]),
    rel("v2026.9.29", winLinux("2026.9.29")),
    rel("v2026.9.28", ["loki_2026.9.28_universal.dmg", "cask.rb", ...winLinux("2026.9.28")]),
  ];

  test("Windows and Linux take the newest stable carrying their file, skipping a Mac-only one and the nightly", () => {
    expect(newestWith(list, "windows")?.tag_name).toBe("v2026.9.29");
    expect(newestWith(list, "linux")?.tag_name).toBe("v2026.9.29");
    expect(downloadFor(newestWith(list, "windows")!, "windows")).toContain("loki_2026.9.29_x64-setup.exe");
  });

  test("the order is by version, not by the list's; drafts and prereleases never count; a file on one system only counts there", () => {
    expect(newestWith([...list].reverse(), "windows")?.tag_name).toBe("v2026.9.29");
    const exeOnly = rel("v2026.10.1", ["loki_2026.10.1_x64-setup.exe"]);
    expect(newestWith([exeOnly, ...list], "windows")?.tag_name).toBe("v2026.10.1");
    expect(newestWith([exeOnly, ...list], "linux")?.tag_name).toBe("v2026.9.29");
    expect(newestWith([rel("v2026.10.2", winLinux("2026.10.2"), { draft: true }), rel("v2026.10.3", winLinux("2026.10.3"), { prerelease: true }), ...list], "linux")?.tag_name).toBe("v2026.9.29");
  });

  test("no release with this system's file is none", () => {
    expect(newestWith([list[0], list[1]], "windows")).toBeNull();
    expect(newestWith([], "linux")).toBeNull();
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

  test("with no file for this system on the release, the upgrade line links the release page", () => {
    for (const os of ["windows", "linux"] as const) {
      const out = html(os, update, macOnly);
      expect(out).toContain(`href="${page}"`);
      expect(out).not.toContain("follow the Mac");
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
  });
});

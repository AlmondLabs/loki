import { useEffect, useState } from "react";
import { channelOf, isNewerVersion, nightlyVersionIn, parseVersion, type Channel } from "../../../core/version.ts";
import { platform, type Platform } from "../desk/env";

/** What the app knows about newer releases of itself. */
export interface LokiUpdate {
  current: string;
  /** stable follows the latest release (off the Mac, the newest with this system's file); nightly follows the rolling `nightly` prerelease, built from every merge. */
  channel: Channel;
  /** The newest release's version, once GitHub answered. */
  latest: string | null;
  /** Its release page. */
  url: string | null;
  /** This system's file on that release (the .dmg, the -setup.exe, the AppImage or .deb), else the release page. */
  download: string | null;
  /** Where to report problems: the repository's issues. */
  issues: string | null;
  newer: boolean;
  /** Why the last check failed (offline, no release yet, rate-limited); null when it worked or has not run. */
  error: string | null;
}

const EVERY_MS = 6 * 60 * 60 * 1000;

/** The parts of a GitHub release the check reads. */
export interface Release {
  tag_name?: string;
  name?: string;
  html_url?: string;
  draft?: boolean;
  prerelease?: boolean;
  assets?: Array<{ name: string; browser_download_url: string }>;
}

/** Each system's files on a release, in the order they are offered: the one the release workflow builds for it. */
const SUFFIXES: Record<Platform, string[]> = { macos: [".dmg"], windows: ["-setup.exe"], linux: [".AppImage", ".deb"] };

/** This system's download on a release (plan 014 KTD13), falling back to the release page when it has none. */
export function downloadFor(release: Release, os: Platform = platform): string | null {
  for (const suffix of SUFFIXES[os]) {
    const hit = release.assets?.find((a) => a.name.endsWith(suffix));
    if (hit) return hit.browser_download_url;
  }
  return release.html_url ?? null;
}

/**
 * The newest stable release carrying this system's file, from GitHub's list. Windows and Linux follow this, not
 * GitHub's latest: that is the Mac's newest `.dmg`, and a release their PR made first carries only their files and is
 * not marked latest until the Mac's lands. Null when none has the file.
 */
export function newestWith(releases: Release[], os: Platform = platform): Release | null {
  const has = (r: Release) => SUFFIXES[os].some((suffix) => r.assets?.some((a) => a.name.endsWith(suffix)));
  const version = (r: Release) => parseVersion(r.tag_name ?? "");
  const candidates = releases.filter((r) => !r.draft && !r.prerelease && version(r) && has(r));
  candidates.sort((a, b) => {
    const [x, y] = [version(a)!, version(b)!];
    return y[0] - x[0] || y[1] - x[1] || y[2] - x[2];
  });
  return candidates[0] ?? null;
}

/**
 * The only update the app ever offers on its own is loki's (Letta Code moves from Settings › letta alone).
 * There is no signed updater yet, so this asks GitHub on launch and every six hours — a stable build for the
 * latest release (on Windows and Linux the newest release with their file, `newestWith`), a nightly build for the
 * rolling `nightly` prerelease, where any other build is the newer one —
 * and Settings says so with the release page and the brew line. Nothing is sent but the request; a failure is a
 * quiet line in Settings, never a dialog.
 */
export function useLokiUpdate(): LokiUpdate {
  // Fixed at build time: the version string says which channel this build is on.
  const channel = channelOf(__LOKI_VERSION__);
  const [state, setState] = useState<LokiUpdate>({ current: __LOKI_VERSION__, channel, latest: null, url: null, download: null, issues: __LOKI_REPO__ ? `https://github.com/${__LOKI_REPO__}/issues` : null, newer: false, error: null });
  useEffect(() => {
    if (!__LOKI_REPO__) return;
    let cancelled = false;
    const check = async () => {
      try {
        const listed = channel === "stable" && platform !== "macos";
        const r = await fetch(`https://api.github.com/repos/${__LOKI_REPO__}/releases${listed ? "?per_page=30" : channel === "nightly" ? "/tags/nightly" : "/latest"}`, { headers: { Accept: "application/vnd.github+json" }, cache: "no-store" });
        if (!r.ok) throw new Error(r.status === 404 ? (channel === "nightly" ? "no nightly published yet" : "no release published yet") : `GitHub answered ${r.status}`);
        const j = listed ? newestWith((await r.json()) as Release[]) : ((await r.json()) as Release);
        if (!j) throw new Error("no release has this system's file yet");
        const latest = channel === "nightly" ? nightlyVersionIn(j.name) : (j.tag_name ?? "").replace(/^v/, "");
        if (!latest) throw new Error("release without a version");
        if (!cancelled) setState((s) => ({ ...s, latest, url: j.html_url ?? null, download: downloadFor(j), newer: channel === "nightly" ? latest !== s.current : isNewerVersion(s.current, latest), error: null }));
      } catch (err) {
        if (!cancelled) setState((s) => ({ ...s, error: err instanceof Error ? err.message : String(err) }));
      }
    };
    void check();
    const t = setInterval(() => void check(), EVERY_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [channel]);
  return state;
}

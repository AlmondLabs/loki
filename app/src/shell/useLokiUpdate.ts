import { useEffect, useState } from "react";
import { channelOf, isNewerVersion, nightlyVersionIn, type Channel } from "../../../core/version.ts";

/** What the app knows about newer releases of itself. */
export interface LokiUpdate {
  current: string;
  /** stable follows the latest release; nightly follows the rolling `nightly` prerelease, built from every merge. */
  channel: Channel;
  /** The newest release's version, once GitHub answered. */
  latest: string | null;
  /** Its release page. */
  url: string | null;
  newer: boolean;
  /** Why the last check failed (offline, no release yet, rate-limited); null when it worked or has not run. */
  error: string | null;
}

const EVERY_MS = 6 * 60 * 60 * 1000;

/**
 * The only update the app ever offers on its own is loki's (Letta Code moves from Settings › letta alone).
 * There is no signed updater yet, so this asks GitHub on launch and every six hours — a stable build for the
 * latest release, a nightly build for the rolling `nightly` prerelease, where any other build is the newer one —
 * and Settings says so with the release page and the brew line. Nothing is sent but the request; a failure is a
 * quiet line in Settings, never a dialog.
 */
/** Fixed at build time: the version string says which channel this build is on. */
const channel = channelOf(__LOKI_VERSION__);

export function useLokiUpdate(): LokiUpdate {
  const [state, setState] = useState<LokiUpdate>({ current: __LOKI_VERSION__, channel, latest: null, url: null, newer: false, error: null });
  useEffect(() => {
    if (!__LOKI_REPO__) return;
    let cancelled = false;
    const check = async () => {
      try {
        const r = await fetch(`https://api.github.com/repos/${__LOKI_REPO__}/releases/${channel === "nightly" ? "tags/nightly" : "latest"}`, { headers: { Accept: "application/vnd.github+json" }, cache: "no-store" });
        if (!r.ok) throw new Error(r.status === 404 ? (channel === "nightly" ? "no nightly published yet" : "no release published yet") : `GitHub answered ${r.status}`);
        const j = (await r.json()) as { tag_name?: string; name?: string; html_url?: string };
        const latest = channel === "nightly" ? nightlyVersionIn(j.name) : (j.tag_name ?? "").replace(/^v/, "");
        if (!latest) throw new Error("release without a version");
        if (!cancelled) setState((s) => ({ ...s, latest, url: j.html_url ?? null, newer: channel === "nightly" ? latest !== s.current : isNewerVersion(s.current, latest), error: null }));
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
  }, []);
  return state;
}

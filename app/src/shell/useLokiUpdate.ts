import { useEffect, useState } from "react";
import { isNewerVersion } from "../../../core/version.ts";

/** What the app knows about newer releases of itself. */
export interface LokiUpdate {
  current: string;
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
 * There is no signed updater yet, so this asks GitHub for the latest release on launch and every six
 * hours, and Settings says so with the release page and the brew line. Nothing is sent but the request;
 * a failure is a quiet line in Settings, never a dialog.
 */
export function useLokiUpdate(): LokiUpdate {
  const [state, setState] = useState<LokiUpdate>({ current: __LOKI_VERSION__, latest: null, url: null, newer: false, error: null });
  useEffect(() => {
    if (!__LOKI_REPO__) return;
    let cancelled = false;
    const check = async () => {
      try {
        const r = await fetch(`https://api.github.com/repos/${__LOKI_REPO__}/releases/latest`, { headers: { Accept: "application/vnd.github+json" }, cache: "no-store" });
        if (!r.ok) throw new Error(r.status === 404 ? "no release published yet" : `GitHub answered ${r.status}`);
        const j = (await r.json()) as { tag_name?: string; html_url?: string };
        const latest = (j.tag_name ?? "").replace(/^v/, "");
        if (!latest) throw new Error("release without a version tag");
        if (!cancelled) setState((s) => ({ ...s, latest, url: j.html_url ?? null, newer: isNewerVersion(s.current, latest), error: null }));
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

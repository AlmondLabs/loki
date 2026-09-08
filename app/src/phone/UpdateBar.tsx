import { useEffect, useRef, useState } from "react";
import { modBase } from "../desk/env";
import { needsReload, shouldAutoReload } from "./model";
import { SAFE } from "./ui";

/** The build id index.html was served with; undefined on an index.html from before builds were stamped. */
export const currentBuild = (): string | null => window.__LOKI__?.build ?? null;

/** `GET /health` → its build id, or null when the Mac did not answer. */
async function servedBuildNow(): Promise<string | null> {
  try {
    const r = await fetch(`${modBase()}/health`, { credentials: "same-origin", cache: "no-store" });
    if (!r.ok) return null;
    const j = (await r.json()) as { build?: unknown };
    return typeof j.build === "string" ? j.build : null;
  } catch {
    return null;
  }
}

/**
 * A home-screen web app has no reload button, so the page watches for a newer canvas: the mod says so
 * over the socket (`app_build`), and /health is asked when the app comes back to the front and once a
 * minute while it is. A change shows a thin bar — brass, because this one needs a tap — and a change
 * found after more than thirty seconds in the background reloads at once, since nothing is mid-flight.
 */
export function UpdateBar({ servedBuild, withTabBar }: { servedBuild: string | null; withTabBar: boolean }) {
  const current = currentBuild();
  const [health, setHealth] = useState<string | null>(null);
  const hiddenAt = useRef<number | null>(document.visibilityState === "hidden" ? Date.now() : null);

  useEffect(() => {
    let timer: number | null = null;
    const start = () => {
      if (timer === null) timer = window.setInterval(() => void servedBuildNow().then((b) => b && setHealth(b)), 60_000);
    };
    const stop = () => {
      if (timer !== null) window.clearInterval(timer);
      timer = null;
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        const hiddenMs = hiddenAt.current === null ? 0 : Date.now() - hiddenAt.current;
        hiddenAt.current = null;
        void servedBuildNow().then((b) => {
          if (!b) return;
          if (shouldAutoReload(hiddenMs, needsReload(b, current))) location.reload();
          else setHealth(b);
        });
        start();
      } else {
        hiddenAt.current = Date.now();
        stop();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    if (document.visibilityState === "visible") start();
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      stop();
    };
  }, [current]);

  if (!needsReload(servedBuild, current) && !needsReload(health, current)) return null;
  return (
    <button
      type="button"
      onClick={() => location.reload()}
      style={{ flex: "0 0 auto", display: "block", width: "100%", minHeight: 36, padding: `8px calc(12px + ${SAFE.right}) ${withTabBar ? "8px" : `calc(8px + ${SAFE.bottom})`} calc(12px + ${SAFE.left})`, border: "none", borderTop: "1px solid var(--loki-border)", background: "var(--loki-panel)", color: "var(--loki-accent)", fontFamily: "var(--loki-mono)", fontSize: 12, letterSpacing: "0.06em", textAlign: "center", cursor: "pointer", WebkitTapHighlightColor: "transparent" }}
    >
      loki updated · tap to reload
    </button>
  );
}

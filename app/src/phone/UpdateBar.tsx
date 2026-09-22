import { useEffect, useRef, useState } from "react";
import { modBase } from "../desk/env";
import { needsReload, shouldAutoReload } from "./model";
import { Button } from "../components";

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
 * On a tab it rides in the navigation's dock, above the capsule; on a full-screen page it is the strip
 * at the bottom and clears the home indicator itself (phone.css, .loki-phone-update).
 */
export function UpdateBar({ servedBuild }: { servedBuild: string | null }) {
  const current = currentBuild();
  const [health, setHealth] = useState<string | null>(null);
  const hiddenAt = useRef<number | null>(null);

  useEffect(() => {
    hiddenAt.current = document.visibilityState === "hidden" ? Date.now() : null;
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
    <div className="loki-phone-update">
      <Button block size="touch" tone="brass" onClick={() => location.reload()}>
        loki updated · tap to reload
      </Button>
    </div>
  );
}

import { useLayoutEffect, useRef, useState } from "react";
import { ChevronDownIcon } from "lucide-react";
import { PopoverMenu } from "./menu-items";
import { NATIVE_MENUS, popUpMenu, under, type MenuEntry } from "./native-menu";
import type { LokiUpdate } from "./use-loki-update";

/** The version the person put off with Later, so the button stays away until a newer one. */
const LATER_KEY = "loki.update.later";

/** The storage Later is kept in: localStorage, which a locked-down webview can refuse. */
type LaterStorage = Pick<Storage, "getItem" | "setItem">;

/** The window's localStorage, or null where reading it throws. */
function local(): LaterStorage | null {
  try {
    return localStorage;
  } catch {
    return null;
  }
}

/** The version last put off with Later; null when none was, or storage is blocked. */
export function readLater(storage: LaterStorage | null = local()): string | null {
  try {
    return storage?.getItem(LATER_KEY) ?? null;
  } catch {
    return null;
  }
}

/** Keeps `version` as put off. Blocked storage only costs showing the button again at the next launch. */
export function saveLater(version: string, storage: LaterStorage | null = local()): void {
  try {
    storage?.setItem(LATER_KEY, version);
  } catch {
    // Nothing to keep it in; the button returns next launch.
  }
}

/**
 * The version the Update button offers (plan 2026-11-14-1330, R18): the newest loki while it is newer than this one
 * and not the one put off with Later; otherwise null, and there is no button.
 */
export function offeredVersion(update: Pick<LokiUpdate, "newer" | "latest">, later: string | null): string | null {
  return update.newer && update.latest && update.latest !== later ? update.latest : null;
}

/** The space kept between the toolbar's own symbols and the Update button. */
const GAP = 8;

/**
 * A newer loki, said at the detail toolbar's trailing edge rather than over the content (plan 2026-11-14-1330, U4).
 * The shell lays it over the detail's top right, the same spot in every place, and its width goes into
 * `--loki-toolbar-room` on the detail so each toolbar's trailing side leaves room for it. Update… opens Preferences ›
 * loki; the menu beside it holds Later, which hides it until the next version.
 */
export function UpdateButton({ version, onUpdate, onLater }: { version: string; onUpdate: () => void; onLater: () => void }) {
  const slot = useRef<HTMLDivElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  useLayoutEffect(() => {
    const el = slot.current;
    const host = el?.parentElement;
    if (!el || !host) return;
    const set = () => host.style.setProperty("--loki-toolbar-room", `${el.offsetWidth + GAP}px`);
    set();
    const observer = new ResizeObserver(set);
    observer.observe(el);
    return () => {
      observer.disconnect();
      host.style.removeProperty("--loki-toolbar-room");
    };
  }, []);
  const entries: MenuEntry[] = [{ type: "item", id: "later", label: "Later", run: onLater }];
  return (
    <div ref={slot} className="loki-update-slot">
      <span className="loki-toolbar-group" role="group" aria-label="Update">
        <button type="button" className="loki-toolbar-item loki-toolbar-item--text" title={`loki ${version} is available`} onClick={onUpdate}>
          Update…
        </button>
        <button
          type="button"
          className="loki-toolbar-item loki-toolbar-item--menu"
          aria-label="Update Options"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={(e) => {
            // In the Mac app the system's menu hangs from the button (plan 2026-11-12-1505, U19).
            if (NATIVE_MENUS) void popUpMenu(entries, under(e.currentTarget)).catch((err: unknown) => console.warn("loki: update menu", err));
            else setMenuOpen((v) => !v);
          }}
        >
          <ChevronDownIcon aria-hidden />
        </button>
        {menuOpen && <PopoverMenu label="Update" entries={entries} onClose={() => setMenuOpen(false)} width={160} />}
      </span>
    </div>
  );
}

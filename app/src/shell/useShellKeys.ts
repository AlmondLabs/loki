import { useEffect, useRef } from "react";
import { inTauri } from "../desk/env";
import { chordIds, dialogState, keySegment, menuSpec, registerActions, resolve, runAction, shellKeyAllowed, typingIn, type Segment } from "./keymap";

/**
 * The window's keys, by keymap id. Owns the registry entries for the window-level actions (views register
 * their own: the sheet's zoom, the deck's decisions, the board's moves), the one keydown listener that
 * resolves the event against the keymap for the showing segment, and the native menu's clicks. `view` and
 * `actions` are read through a ref, so the closures passed each render stay fresh while everything is
 * registered once. Dialogs own their keys; Preferences, the one dialog that is part of the shell, lets ⌘,
 * ⌘1-6 and its ⌘[ ⌘] through, and search lets ⌘K through to close it (shellKeyAllowed). Esc peels a layer:
 * the desk's Desk tab back to Messages (`toMessages` says whether it took it), then a segment other than
 * the desk, through `escape` (the inbox closes itself). Never while typing.
 */
export function useShellKeys(view: { segment: Segment }, actions: Record<string, () => void>, escape: { toDesk: () => void; toMessages?: (typing: boolean) => boolean; closePreferences?: () => void }): void {
  const ref = useRef({ view, actions, escape });
  useEffect(() => {
    ref.current = { view, actions, escape };
  });
  useEffect(() => registerActions(Object.fromEntries(Object.keys(ref.current.actions).map((id) => [id, () => ref.current.actions[id]()]))), []);

  /** The chord the key handler just acted on: every id it could mean, so the menu's echo is dropped whichever id it carries. */
  const lastKeyFired = useRef<{ ids: Set<string>; at: number } | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const { segment } = ref.current.view;
      const dialog = dialogState();
      if (e.key === "Escape") {
        // The sheet closes itself on Esc from inside; this catches focus that slipped out of it.
        if (dialog === "preferences" && !e.defaultPrevented && ref.current.escape.closePreferences) {
          e.preventDefault();
          ref.current.escape.closePreferences();
          return;
        }
        if (typingIn(e) || dialog !== "none") return;
        if (segment === "desk") {
          if (ref.current.escape.toMessages?.(false)) e.preventDefault();
        } else if (segment === "board" || segment === "agents" || segment === "learn") {
          e.preventDefault();
          ref.current.escape.toDesk();
        }
        return;
      }
      if (dialog === "other") return;
      const b = resolve(e, keySegment(segment, dialog));
      if (!b || !shellKeyAllowed(dialog, b.id)) return;
      if (runAction(b.id)) {
        e.preventDefault();
        lastKeyFired.current = { ids: new Set(chordIds(e)), at: Date.now() };
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // The native menu bar is built from the same keymap. Its clicks arrive as loki:menu with the binding id;
  // when macOS also fires an accelerator for a chord we already handled, the echo arrives within a beat — drop
  // it, even when the menu's item for that chord is a different binding (⌘] is "next desk" in the Desk menu
  // and "next card" in the inbox; the key handler already ran the right one).
  useEffect(() => {
    if (!inTauri) return;
    let off: (() => void) | null = null;
    void import("@tauri-apps/api/core").then(({ invoke }) => invoke("set_menu", { menus: menuSpec() })).catch((e) => console.warn("loki: menu", e));
    void import("@tauri-apps/api/event").then(async ({ listen }) => {
      off = await listen<string>("loki:menu", (ev) => {
        const id = ev.payload === "app.settings" ? "segment.settings" : ev.payload;
        const last = lastKeyFired.current;
        if (last && last.ids.has(id) && Date.now() - last.at < 250) return;
        if (!runAction(id)) console.warn("loki: menu item without an action", id);
      });
    });
    return () => off?.();
  }, []);
}

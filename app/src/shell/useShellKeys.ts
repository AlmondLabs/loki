import { useEffect, useRef } from "react";
import { inTauri } from "../desk/env";
import { chordIds, menuSpec, registerActions, resolve, runAction, typingIn, type Segment } from "./keymap";

/**
 * The window's keys, by keymap id. Owns the registry entries for the window-level actions (views register
 * their own: the sheet's zoom, the deck's decisions, the board's moves), the one keydown listener that
 * resolves the event against the keymap for the showing segment, and the native menu's clicks. `view` and
 * `actions` are read through a ref, so the closures passed each render stay fresh while everything is
 * registered once. Dialogs and the tree own their keys (except ⌘K, which closes the tree). Esc peels a
 * layer: the tree first, then a segment other than the desk, through `escape` (the inbox closes itself).
 */
export function useShellKeys(view: { segment: Segment; treeOpen: boolean }, actions: Record<string, () => void>, escape: { closeTree: () => void; toDesk: () => void }): void {
  const ref = useRef({ view, actions, escape });
  useEffect(() => {
    ref.current = { view, actions, escape };
  });
  useEffect(() => registerActions(Object.fromEntries(Object.keys(ref.current.actions).map((id) => [id, () => ref.current.actions[id]()]))), []);

  /** The chord the key handler just acted on: every id it could mean, so the menu's echo is dropped whichever id it carries. */
  const lastKeyFired = useRef<{ ids: Set<string>; at: number } | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const { segment, treeOpen } = ref.current.view;
      const dialogUp = !!document.querySelector('[role="dialog"]:not([data-tree])');
      if (e.key === "Escape") {
        if (typingIn(e) || dialogUp) return;
        if (treeOpen) {
          e.preventDefault();
          ref.current.escape.closeTree();
        } else if (segment === "settings" || segment === "board" || segment === "agents" || segment === "learn") {
          e.preventDefault();
          ref.current.escape.toDesk();
        }
        return;
      }
      if (dialogUp) return;
      const b = resolve(e, segment);
      if (!b) return;
      if (treeOpen && b.id !== "tree.toggle" && !b.id.startsWith("segment.")) return;
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

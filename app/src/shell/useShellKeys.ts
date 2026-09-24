import { useEffect, useRef } from "react";
import { inTauri, keyboard, type Platform } from "../desk/env";
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
/**
 * The webview's own keys on Windows (WebView2's browser accelerators) and Linux: reload, print, find, the caret,
 * devtools, view source, back and forward. None of them belongs in an app window, and a reload drops the desk
 * mid-turn. In the packaged app they are held back (preventDefault); loki's own bindings on the same chords still run,
 * since nothing in the key handler reads defaultPrevented for them: Ctrl+F is the chat's find, Ctrl+R the board's
 * refresh. A development build keeps them (a reload and devtools are the point there), as does a browser tab, and
 * the Mac's webview has none.
 */
const BROWSER_KEYS = new Set(["f3", "shift+f3", "f5", "ctrl+f5", "shift+f5", "ctrl+shift+f5", "f7", "f12", "ctrl+r", "ctrl+shift+r", "ctrl+p", "ctrl+shift+p", "ctrl+f", "ctrl+g", "ctrl+shift+g", "ctrl+u", "ctrl+shift+i", "ctrl+shift+j", "ctrl+shift+c", "alt+arrowleft", "alt+arrowright", "browserback", "browserforward", "browserrefresh"]);
export function guardBrowserKey(e: Pick<KeyboardEvent, "key" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey" | "preventDefault">, os: Platform = keyboard, release: boolean = inTauri && import.meta.env.PROD === true): void {
  if (!release || os === "macos" || e.metaKey || !e.key) return;
  const chord = [e.ctrlKey && "ctrl", e.altKey && "alt", e.shiftKey && "shift", e.key.toLowerCase()].filter(Boolean).join("+");
  if (BROWSER_KEYS.has(chord)) e.preventDefault();
}

export function useShellKeys(view: { segment: Segment }, actions: Record<string, () => void>, escape: { toDesk: () => void; toMessages?: (typing: boolean) => boolean; closePreferences?: () => void }): void {
  const ref = useRef({ view, actions, escape });
  useEffect(() => {
    ref.current = { view, actions, escape };
  });
  useEffect(() => registerActions(Object.fromEntries(Object.keys(ref.current.actions).map((id) => [id, () => ref.current.actions[id]()]))), []);

  // Capture phase, ahead of every view's own handler, so a view that stops a key cannot let a reload through.
  useEffect(() => {
    const guard = (e: KeyboardEvent) => guardBrowserKey(e);
    window.addEventListener("keydown", guard, true);
    return () => window.removeEventListener("keydown", guard, true);
  }, []);

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

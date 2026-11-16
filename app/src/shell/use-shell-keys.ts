import { useEffect, useRef } from "react";
import { inTauri, keyboard, type Platform } from "../desk/env";
import {
  chordIds,
  dialogState,
  keySegment,
  menuSpec,
  registerActions,
  resolve,
  runAction,
  shellKeyAllowed,
  typingIn,
  type DialogState,
  type Segment,
} from "./keymap";

/**
 * The webview's own keys on Windows (WebView2's browser accelerators) and Linux: reload, print, find, the caret,
 * devtools, view source, back and forward. None of them belongs in an app window, and a reload drops the desk
 * mid-turn. In the packaged app they are held back (preventDefault); loki's own bindings on the same chords still run,
 * since nothing in the key handler reads defaultPrevented for them: Ctrl+F is the chat's find, Ctrl+R Learn's refresh.
 * A development build keeps them (a reload and devtools are the point there), as does a browser tab, and
 * the Mac's webview has none.
 */
const BROWSER_KEYS = new Set([
  "f3",
  "shift+f3",
  "f5",
  "ctrl+f5",
  "shift+f5",
  "ctrl+shift+f5",
  "f7",
  "f12",
  "ctrl+r",
  "ctrl+shift+r",
  "ctrl+p",
  "ctrl+shift+p",
  "ctrl+f",
  "ctrl+g",
  "ctrl+shift+g",
  "ctrl+u",
  "ctrl+shift+i",
  "ctrl+shift+j",
  "ctrl+shift+c",
  "alt+arrowleft",
  "alt+arrowright",
  "browserback",
  "browserforward",
  "browserrefresh",
]);
export function guardBrowserKey(
  e: Pick<KeyboardEvent, "key" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey" | "preventDefault">,
  os: Platform = keyboard,
  release: boolean = inTauri && import.meta.env.PROD,
): void {
  if (!release || os === "macos" || e.metaKey || !e.key) return;
  const chord = [e.ctrlKey && "ctrl", e.altKey && "alt", e.shiftKey && "shift", e.key.toLowerCase()].filter(Boolean).join("+");
  if (BROWSER_KEYS.has(chord)) e.preventDefault();
}

export type EscapeStep = "preferences" | "messages" | "list";

export function escapeSteps(at: { segment: Segment; dialog: DialogState; typing: boolean; inDetail: boolean; prevented: boolean }): EscapeStep[] {
  if (at.prevented) return [];
  if (at.dialog === "preferences") return ["preferences"];
  if (at.dialog !== "none") return [];
  if (at.typing) return at.segment === "inbox" && at.inDetail ? ["list"] : [];
  const steps: EscapeStep[] = at.segment === "desk" ? ["messages"] : [];
  return at.inDetail ? [...steps, "list"] : steps;
}

function inDetail(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest("main") !== null;
}

export function useShellKeys(
  view: { segment: Segment },
  actions: Record<string, () => void>,
  escape: { toList: () => void; toMessages?: (typing: boolean) => boolean; closePreferences?: () => void },
  menuLabels: Record<string, string> = {},
): void {
  const ref = useRef({ view, actions, escape });
  useEffect(() => {
    ref.current = { view, actions, escape };
  });
  useEffect(() => registerActions(Object.fromEntries(Object.keys(ref.current.actions).map((id) => [id, () => ref.current.actions[id]()]))), []);

  useEffect(() => {
    const guard = (e: KeyboardEvent) => guardBrowserKey(e);
    window.addEventListener("keydown", guard, true);
    return () => window.removeEventListener("keydown", guard, true);
  }, []);

  const lastKeyFired = useRef<{ ids: Set<string>; at: number } | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const { segment } = ref.current.view;
      const dialog = dialogState();
      if (e.key === "Escape") {
        const { escape } = ref.current;
        const steps = escapeSteps({ segment, dialog, typing: typingIn(e), inDetail: inDetail(e.target), prevented: e.defaultPrevented });
        for (const step of steps) {
          if (step === "preferences" && !escape.closePreferences) continue;
          if (step === "messages" && escape.toMessages?.(false) !== true) continue;
          e.preventDefault();
          if (step === "preferences") escape.closePreferences?.();
          else if (step === "list") escape.toList();
          return;
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
  // and "read the card" in the inbox; the key handler already ran the right one).
  const labels = JSON.stringify(menuLabels);
  useEffect(() => {
    if (!inTauri) return;
    const menus = menuSpec(undefined, undefined, JSON.parse(labels) as Record<string, string>);
    void import("@tauri-apps/api/core").then(({ invoke }) => invoke("set_menu", { menus })).catch((e: unknown) => console.warn("loki: menu", e));
  }, [labels]);
  useEffect(() => {
    if (!inTauri) return;
    let off: (() => void) | null = null;
    void import("@tauri-apps/api/event").then(async ({ listen }) => {
      off = await listen<string>("loki:menu", (ev) => {
        const id = ev.payload;
        const last = lastKeyFired.current;
        if (last && last.ids.has(id) && Date.now() - last.at < 250) return;
        if (!runAction(id)) console.warn("loki: menu item without an action", id);
      });
    });
    return () => off?.();
  }, []);
}

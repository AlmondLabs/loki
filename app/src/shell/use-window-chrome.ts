import { useEffect } from "react";
import { inTauri, platform, type Platform } from "../desk/env";
import type { Segment } from "./keymap";
import type { Desk } from "./types";

/**
 * The window title, as `name` for the window and `document` for a browser tab: the desk's name on the desk, Flow with
 * its count, Learn with its due cards, agents, Preferences (while its sheet is up). With a lane active Flow names it
 * ("Flow · Work · 3 waiting", plan 085 KTD10), so the person can tell which lane the count and the dock badge are of;
 * `waiting` is already that lane's. A waiting count prefixes the tab title everywhere but Flow.
 */
export function windowTitle(
  desk: Pick<Desk, "title" | "status" | "scope" | "agentName">,
  segment: Segment,
  waiting: number,
  dueCards = 0,
  laneName: string | null = null,
): { name: string; document: string } {
  const deskName = desk.title ?? (desk.status === "live" ? "new chat" : desk.scope);
  // "agent · title", the way a main chat is named ("ira · main chat"); no repeat when the title already leads with it.
  const who = desk.agentName && !deskName.toLowerCase().startsWith(desk.agentName.toLowerCase()) ? `${desk.agentName} · ` : "";
  const state = desk.status === "archived" ? " · archived" : desk.status === "deleted" ? " · deleted" : "";
  const flow = ["Flow", ...(laneName ? [laneName] : []), ...(waiting > 0 ? [`${waiting} waiting`] : [])].join(" · ");
  const name =
    segment === "inbox"
      ? flow
      : segment === "learn"
        ? dueCards > 0
          ? `Learn · ${dueCards} due`
          : "Learn"
        : segment === "agents"
          ? "Agents"
          : segment === "settings"
            ? "Preferences"
            : `${who}${deskName}${state}`;
  return { name, document: waiting > 0 && segment !== "inbox" ? `(${waiting}) ${name}` : name };
}

/**
 * Keeps the window title (windowTitle) current. The native title bar is hidden, so macOS no longer draws it, but it
 * still names the window in the Window menu, Mission Control and to screen readers; a browser tab shows it as the tab
 * title.
 */
export function useWindowTitle(
  desk: Pick<Desk, "title" | "status" | "scope" | "agentName">,
  segment: Segment,
  waiting: number,
  dueCards = 0,
  laneName: string | null = null,
): void {
  const { name, document: tabTitle } = windowTitle(desk, segment, waiting, dueCards, laneName);
  useEffect(() => {
    document.title = tabTitle;
    if (inTauri)
      void import("@tauri-apps/api/window")
        .then(({ getCurrentWindow }) => getCurrentWindow().setTitle(name))
        .catch((e: unknown) => console.warn("loki: window title", e));
  }, [name, tabTitle]);
}

/**
 * "Hide loki" (window.hide): the Mac hides the window, and the dock or the menu-bar item brings it back.
 * Windows and Linux have neither yet, so there it minimises (KTD4).
 */
export function hideWindow(win: { hide: () => Promise<void>; minimize: () => Promise<void> }, os: Platform = platform): Promise<void> {
  return os === "macos" ? win.hide() : win.minimize();
}

/**
 * window.hide from a key or a menu: the window module loads on first use. The import() lives out here, at module
 * level, because one inside a component keeps the React Compiler off the whole component.
 */
export function hideCurrentWindow(): void {
  void import("@tauri-apps/api/window").then(({ getCurrentWindow }) => hideWindow(getCurrentWindow())).catch((e: unknown) => console.warn("loki: hide", e));
}

const SHELL_ON_MAC = inTauri && platform === "macos";

/**
 * In the shell on the Mac: the tray title and dock badge carry the waiting count; ⌥Space (or a tray click) arrives
 * as loki:catch-up and `onCatchUp` brings up the inbox (pass a stable callback: the listener is
 * attached once per callback). Nothing happens in a browser tab, or on Windows and Linux (no tray, no badge,
 * no global shortcut there yet: R3).
 */
export function useTray(waiting: number, onCatchUp: () => void): void {
  useEffect(() => {
    if (!SHELL_ON_MAC) return;
    void import("@tauri-apps/api/core").then(({ invoke }) => invoke("set_waiting", { count: waiting })).catch(() => {});
  }, [waiting]);
  useEffect(() => {
    if (!SHELL_ON_MAC) return;
    let off: (() => void) | null = null;
    void import("@tauri-apps/api/event").then(async ({ listen }) => {
      off = await listen("loki:catch-up", onCatchUp);
    });
    return () => off?.();
  }, [onCatchUp]);
}

import { useEffect } from "react";
import { inTauri, platform, type Platform } from "../desk/env";
import type { Segment } from "./keymap";
import type { Desk } from "./types";

/**
 * The window title: the desk's name on the desk, the inbox with its count, the board with its open
 * count, agents, Preferences (while its sheet is up). The native title bar is hidden, so macOS no longer draws it, but it still names
 * the window in the Window menu, Mission Control and to screen readers; a browser tab shows it as the tab
 * title. A waiting count prefixes the tab title everywhere but the inbox.
 */
export function useWindowTitle(desk: Pick<Desk, "title" | "status" | "scope" | "agentName">, segment: Segment, waiting: number, openTasks: number, dueCards = 0): void {
  useEffect(() => {
    const deskName = desk.title ?? (desk.status === "live" ? "new desk" : desk.scope);
    // "agent · title", the way Letta names a main chat ("ira · main chat"); no repeat when the title already leads with it.
    const who = desk.agentName && !deskName.toLowerCase().startsWith(desk.agentName.toLowerCase()) ? `${desk.agentName} · ` : "";
    const state = desk.status === "archived" ? " · archived" : desk.status === "deleted" ? " · deleted" : "";
    const name = segment === "inbox" ? (waiting > 0 ? `Inbox · ${waiting} waiting` : "Inbox") : segment === "board" ? (openTasks > 0 ? `Board · ${openTasks} open` : "Board") : segment === "learn" ? (dueCards > 0 ? `Learn · ${dueCards} due` : "Learn") : segment === "agents" ? "Agents" : segment === "settings" ? "Preferences" : `${who}${deskName}${state}`;
    document.title = waiting > 0 && segment !== "inbox" ? `(${waiting}) ${name}` : name;
    if (inTauri) void import("@tauri-apps/api/window").then(({ getCurrentWindow }) => getCurrentWindow().setTitle(name)).catch((e) => console.warn("loki: window title", e));
  }, [waiting, desk.title, desk.status, desk.scope, desk.agentName, segment, openTasks, dueCards]);
}

/**
 * "Hide loki" (window.hide): the Mac hides the window, and the dock or the menu-bar item brings it back.
 * Windows and Linux have neither yet, so there it minimises (KTD4).
 */
export function hideWindow(win: { hide: () => Promise<void>; minimize: () => Promise<void> }, os: Platform = platform): Promise<void> {
  return os === "macos" ? win.hide() : win.minimize();
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

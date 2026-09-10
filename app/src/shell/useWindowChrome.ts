import { useEffect } from "react";
import { inTauri } from "../desk/env";
import type { Segment } from "./keymap";
import type { Desk } from "./types";

/**
 * The window title is the only chrome: the desk's name on the desk, the inbox with its count, the board
 * with its open count, agents, settings. macOS draws it in the native title bar; a browser tab shows it
 * as the tab title. A waiting count prefixes the tab title everywhere but the inbox.
 */
export function useWindowTitle(desk: Pick<Desk, "title" | "status" | "scope" | "agentName">, segment: Segment, waiting: number, openTasks: number, dueCards = 0): void {
  useEffect(() => {
    const deskName = desk.title ?? (desk.status === "live" ? "new desk" : desk.scope);
    // "agent · title", the way Letta names a main chat ("ira · main chat"); no repeat when the title already leads with it.
    const who = desk.agentName && !deskName.toLowerCase().startsWith(desk.agentName.toLowerCase()) ? `${desk.agentName} · ` : "";
    const state = desk.status === "archived" ? " · archived" : desk.status === "deleted" ? " · deleted" : "";
    const name = segment === "inbox" ? (waiting > 0 ? `Inbox · ${waiting} waiting` : "Inbox") : segment === "board" ? (openTasks > 0 ? `Board · ${openTasks} open` : "Board") : segment === "recall" ? (dueCards > 0 ? `Recall · ${dueCards} due` : "Recall") : segment === "agents" ? "Agents" : segment === "settings" ? "Settings" : `${who}${deskName}${state}`;
    document.title = waiting > 0 && segment !== "inbox" ? `(${waiting}) ${name}` : name;
    if (inTauri) void import("@tauri-apps/api/window").then(({ getCurrentWindow }) => getCurrentWindow().setTitle(name)).catch((e) => console.warn("loki: window title", e));
  }, [waiting, desk.title, desk.status, desk.scope, desk.agentName, segment, openTasks, dueCards]);
}

/**
 * In the shell: the tray title and dock badge carry the waiting count; ⌥Space (or a tray click) arrives
 * as loki:catch-up and `onCatchUp` brings up the inbox (pass a stable callback: the listener is
 * attached once per callback). Nothing happens in a browser tab.
 */
export function useTray(waiting: number, onCatchUp: () => void): void {
  useEffect(() => {
    if (!inTauri) return;
    void import("@tauri-apps/api/core").then(({ invoke }) => invoke("set_waiting", { count: waiting })).catch(() => {});
  }, [waiting]);
  useEffect(() => {
    if (!inTauri) return;
    let off: (() => void) | null = null;
    void import("@tauri-apps/api/event").then(async ({ listen }) => {
      off = await listen("loki:catch-up", onCatchUp);
    });
    return () => off?.();
  }, [onCatchUp]);
}

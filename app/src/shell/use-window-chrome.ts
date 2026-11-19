import { useEffect } from "react";
import { inTauri, platform, type Platform } from "../desk/env";
import type { Segment } from "./keymap";
import type { Desk } from "./types";

export function windowTitle(
  desk: Pick<Desk, "title" | "status" | "scope" | "agentName">,
  segment: Segment,
  waiting: number,
  dueCards = 0,
  laneName: string | null = null,
  until: string | null = null,
): { name: string; document: string } {
  const deskName = desk.title ?? (desk.status === "live" ? "new chat" : desk.scope);
  const who = desk.agentName && !deskName.toLowerCase().startsWith(desk.agentName.toLowerCase()) ? `${desk.agentName} · ` : "";
  const state = desk.status === "archived" ? " · archived" : desk.status === "deleted" ? " · deleted" : "";
  const flow = ["Flow", ...(laneName ? [laneName] : []), ...(until ? [`until ${until}`] : []), ...(waiting > 0 ? [`${waiting} waiting`] : [])].join(" · ");
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
  until: string | null = null,
): void {
  const { name, document: tabTitle } = windowTitle(desk, segment, waiting, dueCards, laneName, until);
  useEffect(() => {
    document.title = tabTitle;
    if (inTauri)
      void import("@tauri-apps/api/window")
        .then(({ getCurrentWindow }) => getCurrentWindow().setTitle(name))
        .catch((e: unknown) => console.warn("loki: window title", e));
  }, [name, tabTitle]);
}

export function hideWindow(win: { hide: () => Promise<void>; minimize: () => Promise<void> }, os: Platform = platform): Promise<void> {
  return os === "macos" ? win.hide() : win.minimize();
}

export function hideCurrentWindow(): void {
  void import("@tauri-apps/api/window").then(({ getCurrentWindow }) => hideWindow(getCurrentWindow())).catch((e: unknown) => console.warn("loki: hide", e));
}

const SHELL_ON_MAC = inTauri && platform === "macos";

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

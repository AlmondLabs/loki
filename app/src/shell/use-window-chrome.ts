import { useEffect } from "react";
import { inDesktop, platform, type Platform } from "../desk/env";
import { currentWindow, invoke, listen } from "./desktop";
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
    if (inDesktop)
      void currentWindow()
        .setTitle(name)
        .catch((e: unknown) => console.warn("loki: window title", e));
  }, [name, tabTitle]);
}

export function hideWindow(win: { hide: () => Promise<void>; minimize: () => Promise<void> }, os: Platform = platform): Promise<void> {
  return os === "macos" ? win.hide() : win.minimize();
}

export function hideCurrentWindow(): void {
  void hideWindow(currentWindow()).catch((e: unknown) => console.warn("loki: hide", e));
}

const SHELL_ON_MAC = inDesktop && platform === "macos";

export function useTray(waiting: number, onCatchUp: () => void): void {
  useEffect(() => {
    if (!SHELL_ON_MAC) return;
    void invoke("set_waiting", { count: waiting }).catch(() => {});
  }, [waiting]);
  useEffect(() => {
    if (!SHELL_ON_MAC) return;
    let off: (() => void) | null = null;
    let live = true;
    void listen("loki:catch-up", onCatchUp)
      .then((unlisten) => {
        if (live) off = unlisten;
        else unlisten();
      })
      .catch((e: unknown) => console.warn("loki: catch up", e));
    return () => {
      live = false;
      off?.();
    };
  }, [onCatchUp]);
}

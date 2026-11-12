import { useEffect, useState } from "react";
import { Notices, notify } from "../components";
import { inTauri, platform } from "../desk/env";
import { useDesk } from "../desk/use-desk";
import { Settings } from "../settings/settings";
import { useDaemonStatus } from "./bootstrap";
import { useChatLayout } from "./use-chat-layout";
import { useGlobalShortcut } from "./use-global-shortcut";
import { useLokiUpdate } from "./use-loki-update";
import { useRecall } from "./use-recall";
import { useShellAttention } from "./use-shell-attention";
import { preferencesProps } from "./views";

/**
 * Whether Preferences can open as a window of its own (plan 2026-11-12-1505, U18): the Mac app only. The shell opens it
 * under Liquid Glass; today's look, Windows, Linux and a browser tab keep the sheet.
 */
export const SETTINGS_WINDOW = inTauri && platform === "macos";

/** Whether this page is the Settings window, as the shell's start-up script says (src-tauri lib.rs settings_script). */
export const isSettingsWindow = typeof window !== "undefined" && window.__LOKI__?.window === "settings";

/** The localStorage key the Settings window marks when the models changed, so the main window asks for them again. */
export const MODELS_CHANGED_KEY = "loki.models-changed";

/** Open the Settings window on `page`, or bring it forward on it when it is open. */
export function openSettingsWindow(page?: string | null): void {
  void import("@tauri-apps/api/core")
    .then(({ invoke }) => invoke("open_settings", { page: page ?? null }))
    .catch((e: unknown) => console.warn("loki: settings window", e));
}

/** Mark the models changed in shared storage; the main window's storage event asks for its list again. */
function markModelsChanged(): void {
  localStorage.setItem(MODELS_CHANGED_KEY, String(Date.now()));
}

/** Close the window this page is in: Esc and ⌘W in the Settings window. */
function closeThisWindow(): void {
  void import("@tauri-apps/api/window")
    .then(({ getCurrentWindow }) => getCurrentWindow().close())
    .catch((e: unknown) => console.warn("loki: close settings", e));
}

/**
 * The Settings window's page (U18): Settings filling the window, the section list on the window's sidebar material,
 * read from this window's own link to the daemon and its own attention model, as the main window's are. Esc (with no
 * dialog open) and ⌘W close it; a page asked for while it is open starts it over on that page.
 */
export function SettingsWindow() {
  const desk = useDesk();
  const { catchUp } = useShellAttention(desk, desk.attention.capture);
  const daemon = useDaemonStatus();
  const recall = useRecall(desk, "settings", (m) => void notify(m));
  const update = useLokiUpdate();
  const shortcut = useGlobalShortcut();
  const chat = useChatLayout(desk);
  const [opening, setOpening] = useState<{ page: string | null; n: number }>(() => ({ page: window.__LOKI__?.page ?? null, n: 0 }));

  useEffect(() => {
    if (!inTauri) return;
    let off: (() => void) | null = null;
    let live = true;
    void import("@tauri-apps/api/event").then(async ({ listen }) => {
      const unlisten = await listen<string>("loki:settings-page", (ev) => setOpening((o) => ({ page: ev.payload, n: o.n + 1 })));
      if (live) off = unlisten;
      else unlisten();
    });
    return () => {
      live = false;
      off?.();
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const closeKey =
        (e.key === "w" && e.metaKey && !e.shiftKey && !e.altKey) || (e.key === "Escape" && !document.querySelector('[role="dialog"], [aria-modal="true"]'));
      if (!closeKey) return;
      e.preventDefault();
      closeThisWindow();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const sources = {
    desk,
    catchUp,
    daemon: daemon.status,
    chatWidth: chat.chatWidth,
    onChatWidth: chat.setChatWidth,
    chatPlacement: chat.chatPlacement,
    onChatPlacement: chat.setChatPlacement,
    // The main window holds the model list: a mark in shared storage tells it to ask again (shell.tsx).
    onModelsChanged: markModelsChanged,
    update,
    shortcut,
    recall,
  };
  return (
    <div className="loki-settings-window">
      <Settings key={opening.n} {...preferencesProps(sources)} windowed initialPage={opening.page} />
      <Notices />
    </div>
  );
}

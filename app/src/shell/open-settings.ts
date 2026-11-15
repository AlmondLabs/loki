import { inTauri, platform } from "../desk/env";

// What the main window needs to send Preferences to their own window, kept apart from the window's page
// (settings-window.tsx) so the shell can open it without loading the whole of Settings at start-up.

/**
 * Whether Preferences opens as a window of its own (plan 2026-11-12-1505, U18): the Mac app only. Windows, Linux and a
 * browser tab keep the sheet.
 */
export const SETTINGS_WINDOW = inTauri && platform === "macos";

/** The localStorage key the Settings window marks when the models changed, so the main window asks for them again. */
export const MODELS_CHANGED_KEY = "loki.models-changed";

/** Open the Settings window on `page`, or bring it forward on it when it is open. */
export function openSettingsWindow(page?: string | null): void {
  void import("@tauri-apps/api/core")
    .then(({ invoke }) => invoke("open_settings", { page: page ?? null }))
    .catch((e: unknown) => console.warn("loki: settings window", e));
}

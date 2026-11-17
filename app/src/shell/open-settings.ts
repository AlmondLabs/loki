import { inTauri, platform } from "../desk/env";

export const SETTINGS_WINDOW = inTauri && platform === "macos";

export const MODELS_CHANGED_KEY = "loki.models-changed";

export function openSettingsWindow(page?: string | null): void {
  void import("@tauri-apps/api/core")
    .then(({ invoke }) => invoke("open_settings", { page: page ?? null }))
    .catch((e: unknown) => console.warn("loki: settings window", e));
}

import { inDesktop, platform } from "../workspace/env";
import { invoke } from "./desktop";

export const SETTINGS_WINDOW = inDesktop && platform === "macos";

export const MODELS_CHANGED_KEY = "loki.models-changed";

export function openSettingsWindow(page?: string | null): void {
  void invoke("open_settings", { page: page ?? null }).catch((e: unknown) => console.warn("loki: settings window", e));
}

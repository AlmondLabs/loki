import { useEffect, useState } from "react";
import { inTauri } from "../desk/env";

/** What launch did about the mod, the skill and the phone canvas (src-tauri/src/install.rs). */
export type InstallState = "installed" | "updated" | "current" | "custom" | "skipped" | "linked" | "error";
/** What the shell reports it did at launch for the mod, the skill and the phone canvas, each with its path, and any error. */
export interface InstallReport {
  mod: InstallState;
  mod_path: string;
  skill: InstallState;
  skill_path: string;
  app: InstallState;
  app_path: string;
  error: string | null;
}
/** What the shell knows about this machine: the install report. Outside the shell it stays null. */
export function useHarnessFacts(): { install: InstallReport | null } {
  const [install, setInstall] = useState<InstallReport | null>(null);
  useEffect(() => {
    if (!inTauri) return;
    let cancelled = false;
    void import("@tauri-apps/api/core")
      .then(async ({ invoke }) => {
        const report = await invoke<InstallReport>("install_status").catch(() => null);
        if (cancelled) return;
        setInstall(report);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  return { install };
}

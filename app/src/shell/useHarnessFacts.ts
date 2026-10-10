import { useEffect, useState } from "react";
import { inTauri } from "../desk/env";

/** What launch did about the mod, the skill and the phone canvas (src-tauri/src/install.rs). */
export type InstallState = "installed" | "updated" | "current" | "custom" | "skipped" | "linked" | "error";
export interface InstallReport {
  mod: InstallState;
  mod_path: string;
  skill: InstallState;
  skill_path: string;
  app: InstallState;
  app_path: string;
  error: string | null;
}
export interface Tools {
  bd: string | null;
}

/** What the shell knows about this machine: the install report and which tools were found. Outside the shell both stay null. */
export function useHarnessFacts(): { install: InstallReport | null; tools: Tools | null } {
  const [install, setInstall] = useState<InstallReport | null>(null);
  const [tools, setTools] = useState<Tools | null>(null);
  useEffect(() => {
    if (!inTauri) return;
    let cancelled = false;
    void import("@tauri-apps/api/core")
      .then(async ({ invoke }) => {
        const [report, found] = await Promise.all([invoke<InstallReport>("install_status").catch(() => null), invoke<Tools>("tool_status").catch(() => null)]);
        if (cancelled) return;
        setInstall(report);
        setTools(found);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  return { install, tools };
}

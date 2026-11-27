import { useEffect, useState } from "react";
import { inDesktop } from "../workspace/env";
import { invoke } from "./desktop";

/** What launch did about the daemon and the web app: the shell's `install_status` answer. */
export type InstallState = "installed" | "updated" | "current" | "custom" | "skipped" | "linked" | "error";
export interface InstallReport {
  mod: InstallState;
  mod_path: string;
  app: InstallState;
  app_path: string;
  error: string | null;
}
export function useHarnessFacts(): { install: InstallReport | null } {
  const [install, setInstall] = useState<InstallReport | null>(null);
  useEffect(() => {
    if (!inDesktop) return;
    let cancelled = false;
    void invoke("install_status")
      .catch(() => null)
      .then((report) => {
        if (!cancelled) setInstall(report);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return { install };
}

import { useEffect, useState } from "react";
import { inTauri } from "../desk/env";

/** What launch did about the mod and the skill (src-tauri/src/install.rs). */
export interface InstallReport {
  mod: "installed" | "updated" | "current" | "custom" | "skipped" | "linked" | "error";
  shim: string;
  mod_path: string;
  skill: "installed" | "updated" | "current" | "custom" | "skipped" | "linked" | "error";
  skill_path: string;
  needs_reload: boolean;
  error: string | null;
}
export interface Tools {
  letta: string | null;
  bd: string | null;
}

/**
 * What the shell knows about the harness on this Mac: the app-server's address (the Rust side knows it,
 * asked again when the tunnel changes, as the harness may have been adopted meanwhile; a browser tab
 * reaches it through the mod's tunnel), the install report and which tools were found. Outside the
 * shell the report and tools stay null.
 */
export function useHarnessFacts(tunnelUrl: string | null): { appServerUrl: string | null; install: InstallReport | null; tools: Tools | null } {
  const [shellUrl, setShellUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!inTauri) return;
    let cancelled = false;
    void import("@tauri-apps/api/core")
      .then(({ invoke }) => invoke<string>("appserver_url"))
      .then((url) => !cancelled && setShellUrl(url))
      .catch(() => !cancelled && setShellUrl(null));
    return () => {
      cancelled = true;
    };
  }, [tunnelUrl]);
  const appServerUrl = inTauri ? shellUrl : tunnelUrl;
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
  return { appServerUrl, install, tools };
}

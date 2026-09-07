import { useCallback, useEffect, useState } from "react";
import { inTauri } from "../desk/env";

/** Mirrors src-tauri/src/bootstrap.rs `Status`. */
export interface BootstrapStatus {
  letta: string | null;
  node: string | null;
  private: boolean;
  installing: boolean;
  error: string | null;
  log: string[];
}

/**
 * Letta Code on this machine, as the shell sees it: found, being installed by loki, or failed.
 * Outside the shell (a browser tab) there is nothing to report and `status` stays null.
 */
export function useBootstrap(): { status: BootstrapStatus | null; install: () => Promise<void> } {
  const [status, setStatus] = useState<BootstrapStatus | null>(null);
  useEffect(() => {
    if (!inTauri) return;
    let off: (() => void) | null = null;
    let cancelled = false;
    void (async () => {
      const { invoke } = await import("@tauri-apps/api/core");
      const { listen } = await import("@tauri-apps/api/event");
      const refresh = () => void invoke<BootstrapStatus>("bootstrap_status").then((s) => !cancelled && setStatus(s)).catch(() => {});
      refresh();
      off = await listen("loki:bootstrap", refresh);
    })();
    return () => {
      cancelled = true;
      off?.();
    };
  }, []);
  const install = useCallback(async () => {
    if (!inTauri) return;
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("install_letta").catch(() => {});
  }, []);
  return { status, install };
}

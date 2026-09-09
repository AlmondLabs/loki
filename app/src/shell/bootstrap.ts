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
  /** `letta --version`, once Settings asked. */
  version: string | null;
  /** The newest release on npm, once Settings asked. */
  latest: string | null;
  /** loki started this harness and can restart it: the update button's precondition. */
  managed: boolean;
}

/**
 * Letta Code on this machine, as the shell sees it: found, being installed by loki, or failed.
 * Outside the shell (a browser tab) there is nothing to report and `status` stays null.
 * `check` asks for the installed and the newest version; `update` pulls the newest and restarts the
 * harness — the only way Letta Code moves under loki (the harness runs with its self-updater off).
 * Both resolve to an error line, or null.
 */
export function useBootstrap(): { status: BootstrapStatus | null; install: () => Promise<void>; check: () => Promise<string | null>; update: () => Promise<string | null> } {
  const [status, setStatus] = useState<BootstrapStatus | null>(null);
  useEffect(() => {
    if (!inTauri) return;
    let off: (() => void) | null = null;
    let cancelled = false;
    void (async () => {
      const [{ invoke }, { listen }] = await Promise.all([import("@tauri-apps/api/core"), import("@tauri-apps/api/event")]);
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
  const check = useCallback(async () => {
    if (!inTauri) return "not in the app";
    const { invoke } = await import("@tauri-apps/api/core");
    try {
      setStatus(await invoke<BootstrapStatus>("check_letta_update"));
      return null;
    } catch (e) {
      return String(e);
    }
  }, []);
  const update = useCallback(async () => {
    if (!inTauri) return "not in the app";
    const { invoke } = await import("@tauri-apps/api/core");
    try {
      await invoke("update_letta");
      return null;
    } catch (e) {
      return String(e);
    }
  }, []);
  return { status, install, check, update };
}

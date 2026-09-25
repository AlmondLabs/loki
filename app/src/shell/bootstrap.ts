import { useCallback, useEffect, useState } from "react";
import { inTauri } from "../desk/env";

/** Mirrors src-tauri/src/bootstrap.rs `Status`. */
export interface BootstrapStatus {
  letta: string | null;
  node: string | null;
  /** Named by LOKI_LETTA_BIN: not npm's to update. */
  explicit: boolean;
  installing: boolean;
  error: string | null;
  log: string[];
  /** `letta --version`, once Settings asked. */
  version: string | null;
  /** The newest release on npm, once Settings asked. */
  latest: string | null;
  /** loki started this harness and can restart it: the update button's precondition. */
  managed: boolean;
  /** The install stopped for want of a Node 22.19+ (Welcome's Node step); null otherwise. Absent from older shells. */
  node_missing?: NodeMissing | null;
}

/** Mirrors bootstrap.rs `NodeMissing`: no Node new enough anywhere loki looks, on this system. */
export interface NodeMissing {
  os: "macos" | "windows" | "linux";
  /** The newest older Node found ("20.11.1") and where, if any. */
  found: string | null;
  at: string | null;
  /** "22.19": Letta Code's engines.node. */
  needed: string;
}

/** Where Welcome's Letta Code step is: still looking, npm running, stopped for want of Node, or failed otherwise. */
export function lettaPhase(status: BootstrapStatus | null): "looking" | "installing" | "node" | "failed" {
  if (status?.installing) return "installing";
  if (status?.node_missing) return "node";
  return status?.error ? "failed" : "looking";
}

/** The usual way to get Node on each system, for Welcome: one command where there is one, and a line around it. */
export function nodeHelp(os: NodeMissing["os"]): { command: string; also?: string; note: string } {
  if (os === "windows") return { command: "winget install OpenJS.NodeJS.LTS", note: "in PowerShell or Windows Terminal." };
  if (os === "linux") return { command: "sudo apt install nodejs npm", also: "sudo dnf install nodejs", note: "on Debian or Ubuntu, or on Fedora, when the distribution's Node is 22 or newer." };
  return { command: "brew install node", note: "with Homebrew (the loki cask brings it)." };
}

/**
 * Letta Code on this machine, as the shell sees it: found where installers put it, being installed with
 * npm by loki, or failed. Outside the shell (a browser tab) there is nothing to report and `status` stays null.
 * `check` asks for the installed and the newest version; `update` runs `npm install -g @letta-ai/letta-code@latest`
 * and restarts the harness when loki launched it (that harness runs with its self-updater off; a terminal
 * session updates the same install by itself). Both resolve to an error line, or null.
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

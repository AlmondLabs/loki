import { useCallback, useEffect, useState } from "react";
import { inTauri } from "../desk/env";

/** Mirrors the shell's `daemon_status`: the Node loki's daemon runs on, why it could not start, and the Node it wants when none is new enough. */
export interface DaemonStatus {
  node: string | null;
  error: string | null;
  nodeMissing: NodeMissing | null;
}

/** Mirrors node.rs `NodeMissing`: no Node new enough anywhere loki looks, on this system. */
export interface NodeMissing {
  os: "macos" | "windows" | "linux";
  /** The newest older Node found ("20.11.1") and where, if any. */
  found: string | null;
  at: string | null;
  /** "22.19": the oldest Node loki's daemon runs on. */
  needed: string;
}

/** The usual way to get Node on each system, for Welcome: one command where there is one, and a line around it. */
export function nodeHelp(os: NodeMissing["os"]): { command: string; also?: string; note: string } {
  if (os === "windows") return { command: "winget install OpenJS.NodeJS.LTS", note: "in PowerShell or Windows Terminal." };
  if (os === "linux") return { command: "sudo apt install nodejs npm", also: "sudo dnf install nodejs", note: "on Debian or Ubuntu, or on Fedora, when the distribution's Node is 22 or newer." };
  return { command: "brew install node", note: "with Homebrew (the loki cask brings it)." };
}

/** How often the status is asked again while the daemon could not start: it may yet, once Node is installed. */
const RECHECK_MS = 4000;

/**
 * loki's daemon as the shell sees it: the Node it runs on, or why it could not start. Outside the shell (a
 * browser tab) there is nothing to report and `status` stays null. While `error` is set the status is asked
 * again every few seconds; `retry` (Welcome's "check again") has the shell look for Node afresh and start the
 * daemon when nothing runs it yet.
 */
export function useDaemonStatus(): { status: DaemonStatus | null; retry: () => Promise<void> } {
  const [status, setStatus] = useState<DaemonStatus | null>(null);
  const failing = !!status?.error;
  useEffect(() => {
    if (!inTauri) return;
    let cancelled = false;
    const refresh = () =>
      void import("@tauri-apps/api/core")
        .then(({ invoke }) => invoke<DaemonStatus>("daemon_status"))
        .then((s) => !cancelled && setStatus(s))
        .catch(() => {});
    refresh();
    const timer = failing ? setInterval(refresh, RECHECK_MS) : null;
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [failing]);
  const retry = useCallback(async () => {
    if (!inTauri) return;
    const { invoke } = await import("@tauri-apps/api/core");
    try {
      setStatus(await invoke<DaemonStatus>("retry_daemon"));
    } catch (e) {
      setStatus((s) => ({ node: s?.node ?? null, nodeMissing: s?.nodeMissing ?? null, error: String(e) }));
    }
  }, []);
  return { status, retry };
}

import { useCallback, useEffect, useState } from "react";
import type { ConnectProvider } from "../../../core/attention/protocol.ts";
import { inTauri } from "../desk/env";
import { welcomeStep } from "../settings/provider-model";

/**
 * Mirrors the shell's `daemon_status` (lib.rs `DaemonStatus`): the Node loki's daemon runs on, why it could not start,
 * and what comes before it starts (plan 2026-11-15-2319, KTD7).
 */
export interface DaemonStatus {
  node: string | null;
  error: string | null;
  /** The runtime download under way, or the one that failed when `error` is set beside it. */
  preparing: Preparing | null;
  /** The system whose git is missing: the Mac's command line tools, or Linux's package. */
  toolsMissing: "macos" | "linux" | null;
}

/** Mirrors lib.rs `Preparing`: what the shell is fetching (Node, or PortableGit on Windows) and how far along it is. */
export interface Preparing {
  name: "node" | "git";
  version: string;
  done: number;
  /** The download's size, once its server has said it. */
  total: number | null;
}

/** The event the shell sends each change of the status on (lib.rs `RUNTIME_EVENT`), carrying the whole status. */
const RUNTIME_EVENT = "loki:runtime";

/** How often the status is asked again until the daemon runs: the fallback for an event sent before the page listened. */
const RECHECK_MS = 4000;

/** Whether the daemon is running with nothing wrong, so the status needs no more asking. */
const settled = (s: DaemonStatus | null) => !!s?.node && !s.error;

/**
 * loki's daemon as the shell sees it: the Node it runs on, the download or the tools step before it, or why it could
 * not start. Outside the shell (a browser tab) there is nothing to report and `status` stays null. The shell's
 * `loki:runtime` events keep it current; until the daemon runs it is also asked every few seconds. `retry` (Welcome's
 * Try Again and Check Again) runs the shell's start sequence again; `installTools` asks macOS to install its command
 * line tools, and says what went wrong if it could not.
 */
export function useDaemonStatus(): { status: DaemonStatus | null; retry: () => Promise<void>; installTools: () => Promise<string | null> } {
  const [status, setStatus] = useState<DaemonStatus | null>(null);
  const waiting = inTauri && !settled(status);
  useEffect(() => {
    if (!inTauri) return;
    let off: (() => void) | null = null;
    let live = true;
    void import("@tauri-apps/api/event")
      .then(async ({ listen }) => {
        const unlisten = await listen<DaemonStatus>(RUNTIME_EVENT, (e) => setStatus(e.payload));
        if (live) off = unlisten;
        else unlisten();
      })
      .catch(() => {});
    return () => {
      live = false;
      off?.();
    };
  }, []);
  useEffect(() => {
    if (!inTauri) return;
    let cancelled = false;
    const refresh = () =>
      void import("@tauri-apps/api/core")
        .then(({ invoke }) => invoke<DaemonStatus>("daemon_status"))
        .then((s) => !cancelled && setStatus(s))
        .catch(() => {});
    refresh();
    const timer = waiting ? setInterval(refresh, RECHECK_MS) : null;
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [waiting]);
  const retry = useCallback(async () => {
    if (!inTauri) return;
    const { invoke } = await import("@tauri-apps/api/core");
    try {
      setStatus(await invoke<DaemonStatus>("retry_daemon"));
    } catch (e) {
      setStatus((s) => ({ node: s?.node ?? null, preparing: null, toolsMissing: null, error: String(e) }));
    }
  }, []);
  const installTools = useCallback(async () => {
    if (!inTauri) return null;
    const { invoke } = await import("@tauri-apps/api/core");
    try {
      await invoke("install_tools");
      return null;
    } catch (e) {
      return String(e);
    }
  }, []);
  return { status, retry, installTools };
}

/** Which Welcome step shows: `prepare` while the machine is readied, then the provider and the first agent. */
export type WelcomeStep = "prepare" | "provider" | "agent";

/** What `welcomeFor` reads of the link to the daemon (the attention model's fields of the same names). */
export interface DaemonLink {
  status: string;
  agentsLoaded: boolean;
  agents: readonly unknown[];
  providers: ConnectProvider[] | null;
}

/**
 * The Welcome step to show, if any. While nothing answers and the shell is fetching the runtime, waiting for git or
 * could not start the daemon: `prepare`, and only that, so someone who finished Welcome before sees the download after
 * an update and then the app. Once the daemon answers, the provider and agent steps come from its state, and a machine
 * with agents gets none. Before the start sequence has said anything there is nothing to show, so a launch whose
 * runtime is in place goes straight in.
 */
export function welcomeFor(daemon: DaemonStatus | null, link: DaemonLink): WelcomeStep | null {
  if (link.status !== "open") return daemon && (daemon.error ?? daemon.preparing ?? daemon.toolsMissing) ? "prepare" : null;
  return link.agentsLoaded ? welcomeStep({ agents: link.agents.length, providers: link.providers }) : null;
}

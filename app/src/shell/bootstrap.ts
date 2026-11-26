import { useCallback, useEffect, useState } from "react";
import type { ConnectProvider } from "../../../core/attention/protocol.ts";
import { inDesktop } from "../workspace/env";
import { messageOf } from "../../../core/errors.ts";
import { invoke, listen } from "./desktop";
import { welcomeStep } from "../settings/provider-model";

/**
 * The shell's `daemon_status` answer, and what its `loki:runtime` event carries: the Node loki's daemon runs on, why it could not start,
 * and what comes before it starts (plan 2026-11-15-2319, KTD7).
 */
export interface DaemonStatus {
  node: string | null;
  error: string | null;
  /** The runtime download under way, or the one that failed when `error` is set beside it. */
  preparing: Preparing | null;
  /** The system whose git is missing: the Mac's command line tools, or Linux's package. */
  toolsMissing: "macos" | "linux" | null;
  /** No Node new enough on this machine: the newest one found, if any, and where, and the version needed. */
  needsNode: NeedsNode | null;
  /** Another loki's daemon is serving `~/.loki`, so this one waits for it to go. */
  otherLoki: { pid: number; command: string } | null;
}

export interface NeedsNode {
  found: string | null;
  at: string | null;
  needed: string;
}

/** What the shell is fetching (PortableGit on Windows) and how far along it is. */
export interface Preparing {
  name: "git";
  version: string;
  done: number;
  /** The download's size, once its server has said it. */
  total: number | null;
}

/** How often the status is asked again until the daemon runs: the fallback for an event sent before the page listened. */
const RECHECK_MS = 4000;

const settled = (s: DaemonStatus | null) => !!s?.node && !s.error;

export function useDaemonStatus(): {
  status: DaemonStatus | null;
  retry: () => Promise<void>;
  installTools: () => Promise<string | null>;
  installNode: () => Promise<string | null>;
} {
  const [status, setStatus] = useState<DaemonStatus | null>(null);
  const waiting = inDesktop && !settled(status);
  useEffect(() => {
    if (!inDesktop) return;
    let off: (() => void) | null = null;
    let live = true;
    void listen("loki:runtime", (e) => setStatus(e.payload))
      .then((unlisten) => {
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
    if (!inDesktop) return;
    let cancelled = false;
    const refresh = () =>
      void invoke("daemon_status")
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
    if (!inDesktop) return;
    try {
      setStatus(await invoke("retry_daemon"));
    } catch (e) {
      const error = messageOf(e);
      setStatus((s) => ({ node: s?.node ?? null, preparing: null, toolsMissing: null, needsNode: s?.needsNode ?? null, otherLoki: null, error }));
    }
  }, []);
  const installTools = useCallback(async () => {
    if (!inDesktop) return null;
    try {
      await invoke("install_tools");
      return null;
    } catch (e) {
      return messageOf(e);
    }
  }, []);
  const installNode = useCallback(async () => {
    if (!inDesktop) return null;
    try {
      await invoke("install_node");
      setStatus(await invoke("daemon_status"));
      return null;
    } catch (e) {
      return messageOf(e);
    }
  }, []);
  return { status, retry, installTools, installNode };
}

export type WelcomeStep = "prepare" | "provider" | "agent";

export interface DaemonLink {
  status: string;
  agentsLoaded: boolean;
  agents: readonly unknown[];
  providers: ConnectProvider[] | null;
}

export function welcomeFor(daemon: DaemonStatus | null, link: DaemonLink): WelcomeStep | null {
  if (link.status !== "open") return (daemon?.error ?? daemon?.preparing ?? daemon?.toolsMissing ?? daemon?.needsNode) ? "prepare" : null;
  return link.agentsLoaded ? welcomeStep({ agents: link.agents.length, providers: link.providers }) : null;
}

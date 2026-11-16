import { useEffect, useState } from "react";
import { inTauri } from "../desk/env";
import { messageOf } from "../../../core/errors.ts";
import type { Channel } from "../../../core/version.ts";

/** The event the shell sends at every change of the update's status, carrying the whole status (src-tauri/src/update.rs). */
export const UPDATE_EVENT = "loki:update";

/** What failed: the check, the download, the signature check of what was downloaded, or Restart to Update's install. */
export type UpdateStage = "check" | "download" | "signature" | "install";

/**
 * Where an update stands, as the shell says (its `UpdateState`): `total` is null until the server has said the size; a
 * build that never checks is unsupported, a development build or a Linux `.deb`, which updates from the releases page.
 */
export type UpdateState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "downloading"; done: number; total: number | null }
  | { kind: "ready"; version: string }
  | { kind: "failed"; stage: UpdateStage; message: string }
  | { kind: "unsupported"; reason: "development" | "package" };

/** The shell's update status: the channel it checks, the running version, and the update's state. */
export interface UpdateStatus {
  channel: Channel;
  current: string;
  state: UpdateState;
}

export interface LokiUpdate {
  status: UpdateStatus | null;
  releases: string | null;
  check: () => void;
  setChannel: (channel: Channel) => void;
  restart: () => Promise<string | null>;
}

async function invokeShell<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(command, args);
}

const check = (): void => {
  if (inTauri) void invokeShell("check_for_updates").catch((e: unknown) => console.warn("loki: check for updates", e));
};

const setChannel = (channel: Channel): void => {
  if (inTauri) void invokeShell("set_update_channel", { channel }).catch((e: unknown) => console.warn("loki: set update channel", e));
};

const restart = (): Promise<string | null> =>
  inTauri
    ? invokeShell("restart_to_update").then(
        () => null,
        (e: unknown) => messageOf(e),
      )
    : Promise.resolve("updates come with the app");

export interface StatusCalls {
  listen: (event: string, handler: (e: { payload: UpdateStatus }) => void) => Promise<() => void>;
  invoke: (command: string) => Promise<UpdateStatus>;
}

export function followStatus({ listen, invoke }: StatusCalls, apply: (status: UpdateStatus) => void): () => void {
  let live = true;
  let heard = false;
  let off: (() => void) | null = null;
  void listen(UPDATE_EVENT, (e) => {
    heard = true;
    if (live) apply(e.payload);
  })
    .then((unlisten) => {
      if (!live) {
        unlisten();
        return null;
      }
      off = unlisten;
      return invoke("update_status");
    })
    .then((now) => {
      if (now && live && !heard) apply(now);
    })
    .catch((e: unknown) => console.warn("loki: update status", e));
  return () => {
    live = false;
    off?.();
  };
}

export function readyVersion(status: UpdateStatus | null): string | null {
  return status?.state.kind === "ready" ? status.state.version : null;
}

export function updateItemLabel(status: UpdateStatus | null): string {
  return readyVersion(status) ? "Restart to Update…" : "Check for Updates…";
}

export function useLokiUpdate(): LokiUpdate {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  useEffect(() => {
    if (!inTauri) return;
    return followStatus(
      {
        listen: async (event, handler) => (await import("@tauri-apps/api/event")).listen<UpdateStatus>(event, handler),
        invoke: (command) => invokeShell<UpdateStatus>(command),
      },
      setStatus,
    );
  }, []);
  return { status, releases: __LOKI_REPO__ ? `https://github.com/${__LOKI_REPO__}/releases` : null, check, setChannel, restart };
}

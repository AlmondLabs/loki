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

/** loki's own update, as a window sees it: the shell's status and the commands that act on it. */
export interface LokiUpdate {
  /** Null until the shell answered, and always outside the shell, where nothing updates. */
  status: UpdateStatus | null;
  /** The releases page, which a Linux `.deb` updates from; null when the build names no repository. */
  releases: string | null;
  /** Check for Updates: a check now, whose results arrive as status. */
  check: () => void;
  /** About's Stable or Nightly, saved by the shell for the next check. */
  setChannel: (channel: Channel) => void;
  /** Install the ready update and open the new version; resolves to why not, when it could not. */
  restart: () => Promise<string | null>;
}

/** A shell command, loaded on first use so the page outside the shell never pulls in Tauri's API. */
async function invokeShell<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(command, args);
}

const check = (): void => {
  if (inTauri) void invokeShell("check_for_updates").catch((e: unknown) => console.warn("loki: check for updates", e));
};

// The shell sends the new status as `loki:update` once the channel is saved, so the picker moves with it; a failed save
// leaves the picker where it was.
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

/** The ready update's version, or null while none is. */
export function readyVersion(status: UpdateStatus | null): string | null {
  return status?.state.kind === "ready" ? status.state.version : null;
}

/** The update item's words in the loki menu and the ☰ menu: the restart once an update is ready, else the plain check. */
export function updateItemLabel(status: UpdateStatus | null): string {
  return readyVersion(status) ? "Restart to Update…" : "Check for Updates…";
}

/**
 * loki's update (plan 2026-11-15-2319, U5): the shell checks its channel on launch and every six hours, downloads a
 * newer loki in the background and installs it when loki quits. This mirrors the shell's status, asked once and then
 * kept current by `loki:update`, and hands out the commands About, the menu and the notice use. Outside the shell the
 * status stays null.
 */
export function useLokiUpdate(): LokiUpdate {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  useEffect(() => {
    if (!inTauri) return;
    let live = true;
    let heard = false;
    let off: (() => void) | null = null;
    void import("@tauri-apps/api/event")
      .then(async ({ listen }) => {
        const unlisten = await listen<UpdateStatus>(UPDATE_EVENT, (e) => {
          heard = true;
          if (live) setStatus(e.payload);
        });
        if (live) off = unlisten;
        else unlisten();
        // Asked once listening, for the status before this page loaded; an event heard meanwhile is newer.
        const now = await invokeShell<UpdateStatus>("update_status");
        if (live && !heard) setStatus(now);
      })
      .catch((e: unknown) => console.warn("loki: update status", e));
    return () => {
      live = false;
      off?.();
    };
  }, []);
  return { status, releases: __LOKI_REPO__ ? `https://github.com/${__LOKI_REPO__}/releases` : null, check, setChannel, restart };
}

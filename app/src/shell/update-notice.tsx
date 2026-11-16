import { useEffect, useEffectEvent, useRef } from "react";
import type { ExternalToast } from "sonner";
import { notify, sentence } from "../components";
import type { AttentionItem } from "../../../core/attention/model.ts";
import { readyVersion, type LokiUpdate } from "./use-loki-update";

export type Notifier = ((title: string, data?: ExternalToast) => string | number) & {
  loading: (title: string, data?: ExternalToast) => string | number;
  dismiss: (id?: string | number) => string | number;
};

const UPDATE_ID = "loki-update-ready";
const UPDATE_FAILED_ID = "loki-update-failed";

export function chatWorking(items: ReadonlyArray<Pick<AttentionItem, "status" | "pendingApproval" | "pendingQuestion">>): boolean {
  return items.some((i) => i.status === "running" || i.pendingApproval !== null || i.pendingQuestion !== null);
}

function restartNow(version: string, restart: () => Promise<string | null>, toast: Notifier): void {
  toast.loading("Restarting…", { id: UPDATE_ID, duration: Infinity });
  void restart().then((err) => {
    if (!err) return;
    toast.dismiss(UPDATE_ID);
    toast(`loki could not install ${version}`, {
      id: UPDATE_FAILED_ID,
      description: `${sentence(err.replace(/[.\s]+$/, ""))}. This version is still running.`,
    });
  });
}

export function restartToUpdate(version: string, working: boolean, restart: () => Promise<string | null>, toast: Notifier = notify): void {
  if (!working) return restartNow(version, restart, toast);
  toast("A chat is working, and restarting now stops its turn", {
    id: UPDATE_ID,
    duration: Infinity,
    action: {
      label: "Update Anyway",
      onClick: (e) => {
        e.preventDefault();
        restartNow(version, restart, toast);
      },
    },
    cancel: { label: "Later", onClick: () => undefined },
  });
}

interface UpdateCommands {
  working: () => boolean;
  restart: () => Promise<string | null>;
}

function offerUpdate(version: string, { working, restart }: UpdateCommands, toast: Notifier): void {
  toast(`loki ${version} is ready`, {
    id: UPDATE_ID,
    description: "It installs when you quit loki",
    duration: Infinity,
    action: {
      label: "Restart to Update",
      onClick: (e) => {
        e.preventDefault();
        restartToUpdate(version, working(), restart, toast);
      },
    },
    cancel: { label: "Later", onClick: () => undefined },
  });
}

export function showReadyUpdate(version: string | null, offered: Set<string>, commands: UpdateCommands, toast: Notifier = notify): void {
  if (!version) {
    toast.dismiss(UPDATE_ID);
    return;
  }
  if (offered.has(version)) return;
  offered.add(version);
  offerUpdate(version, commands, toast);
}

export function runUpdateItem(update: LokiUpdate, working: boolean, showAbout: () => void, toast: Notifier = notify): void {
  const version = readyVersion(update.status);
  if (version) return restartToUpdate(version, working, update.restart, toast);
  update.check();
  showAbout();
}

const offeredThisLaunch = new Set<string>();

export function UpdateNotice({ update, working }: { update: LokiUpdate; working: boolean }) {
  const isWorking = useRef(working);
  useEffect(() => {
    isWorking.current = working;
  });
  const version = readyVersion(update.status);
  const show = useEffectEvent((v: string | null) => showReadyUpdate(v, offeredThisLaunch, { working: () => isWorking.current, restart: update.restart }));
  useEffect(() => show(version), [version]);
  return null;
}

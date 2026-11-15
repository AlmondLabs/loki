import { useEffect, useEffectEvent, useRef } from "react";
import type { ExternalToast } from "sonner";
import { notify, sentence } from "../components";
import type { AttentionItem } from "../../../core/attention/model.ts";
import { readyVersion, type LokiUpdate } from "./use-loki-update";

/** The notices a ready update shows, as Sonner's `toast` has them; tests pass a stand-in. */
export type Notifier = ((title: string, data?: ExternalToast) => string | number) & {
  loading: (title: string, data?: ExternalToast) => string | number;
  dismiss: (id?: string | number) => string | number;
};

/** The Restart to Update notice: shown again in place, never stacked. */
const UPDATE_ID = "loki-update-ready";
/** A failed install's notice, apart from the ready one, so taking the ready one down never takes this one with it. */
const UPDATE_FAILED_ID = "loki-update-failed";

/**
 * Whether a chat is mid-turn (plan 2026-11-15-2319, R11): a turn running, or a tool call waiting on an approval or on
 * the person's answer to the agent's question. Restarting stops any of them. A reply its agent proposed also counts as
 * an approval in the list, but no turn waits on it.
 */
export function chatWorking(items: ReadonlyArray<Pick<AttentionItem, "status" | "pendingApproval" | "pendingQuestion">>): boolean {
  return items.some((i) => i.status === "running" || i.pendingApproval !== null || i.pendingQuestion !== null);
}

/** Install now: the notice says so until loki relaunches, or says why it could not. */
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

/**
 * Restart to Update, from the notice, the menu item or About: straight away with no chat working; otherwise the notice
 * says that chat's turn will stop, and only Update Anyway restarts (AE3).
 */
export function restartToUpdate(version: string, working: boolean, restart: () => Promise<string | null>, toast: Notifier = notify): void {
  if (!working) return restartNow(version, restart, toast);
  toast("A chat is working, and restarting now stops its turn", {
    id: UPDATE_ID,
    duration: Infinity,
    action: {
      label: "Update Anyway",
      onClick: (e) => {
        e.preventDefault(); // the notice stays, saying what happens next
        restartNow(version, restart, toast);
      },
    },
    cancel: { label: "Later", onClick: () => undefined },
  });
}

/** What Restart to Update needs: whether a chat is working, asked when the button is pressed, and the restart itself. */
interface UpdateCommands {
  working: () => boolean;
  restart: () => Promise<string | null>;
}

/** The notice that `version` is ready, with Restart to Update and Later. */
function offerUpdate(version: string, { working, restart }: UpdateCommands, toast: Notifier): void {
  toast(`loki ${version} is ready`, {
    id: UPDATE_ID,
    description: "It installs when you quit loki",
    duration: Infinity,
    action: {
      label: "Restart to Update",
      onClick: (e) => {
        e.preventDefault(); // the notice stays, saying what happens next
        restartToUpdate(version, working(), restart, toast);
      },
    },
    cancel: { label: "Later", onClick: () => undefined },
  });
}

/**
 * The notice for the ready version, each time it changes: a ready update not in `offered` yet is offered and marked
 * offered, so Later hides it until loki next opens; with none ready any more (one installed from the Settings window,
 * or a failed install) the notice goes.
 */
export function showReadyUpdate(version: string | null, offered: Set<string>, commands: UpdateCommands, toast: Notifier = notify): void {
  if (!version) {
    toast.dismiss(UPDATE_ID);
    return;
  }
  if (offered.has(version)) return;
  offered.add(version);
  offerUpdate(version, commands, toast);
}

/**
 * The loki menu's update item: with an update ready it restarts to it as the notice does; otherwise it asks the shell to
 * check now and shows About, where the check's progress and result appear. A development build never has one ready.
 */
export function runUpdateItem(update: LokiUpdate, working: boolean, showAbout: () => void, toast: Notifier = notify): void {
  const version = readyVersion(update.status);
  if (version) return restartToUpdate(version, working, update.restart, toast);
  update.check();
  showAbout();
}

/** The ready updates offered in this launch: Later hides one until loki next opens, and quitting still installs it. */
const offeredThisLaunch = new Set<string>();

/**
 * The Restart to Update notice (plan 2026-11-15-2319, U5): shown once per ready update, in the main window, and gone
 * when no update is ready any more.
 */
export function UpdateNotice({ update, working }: { update: LokiUpdate; working: boolean }) {
  // Read when the button is pressed, which can be long after the notice showed.
  const isWorking = useRef(working);
  useEffect(() => {
    isWorking.current = working;
  });
  const version = readyVersion(update.status);
  const show = useEffectEvent((v: string | null) => showReadyUpdate(v, offeredThisLaunch, { working: () => isWorking.current, restart: update.restart }));
  useEffect(() => show(version), [version]);
  return null;
}

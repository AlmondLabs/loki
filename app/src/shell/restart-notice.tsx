import { useEffect, useEffectEvent, useRef } from "react";
import type { ExternalToast } from "sonner";
import { notify, sentence } from "../components";
import type { AttentionItem } from "../../../core/attention/model.ts";
import { readyVersion, type LokiUpdate } from "./use-loki-update";

/** The daemon's update notice in a checkout: shown again in place, never stacked. */
const ID = "loki-restart-due";

const showing = () => notify.getToasts().some((t) => t.id === ID);

/**
 * Offer the update for `file`'s change, or say why it did not happen (a chat working, a page that did not build, no
 * answer) with "update anyway". A refusal that comes back after the notice went (the daemon was back, owing nothing) is
 * not shown.
 */
function offer(file: string, why: string | null, restart: (anyway: boolean) => Promise<string | null>): void {
  if (why && !showing()) return;
  notify(why ?? `loki's code changed (${file})`, {
    id: ID,
    description: why ? undefined : "Update to use it",
    duration: Infinity,
    action: {
      label: why ? "Update Anyway" : "Update",
      onClick: (e) => {
        e.preventDefault(); // the notice stays, saying what happens next
        notify.loading("Updating…", { id: ID, duration: Infinity });
        void restart(why !== null).then((err) => (err ? offer(file, err, restart) : undefined));
      },
    },
    cancel: { label: "Later", onClick: () => undefined },
  });
}

/**
 * The notice that loki's code changed in a checkout (plans 024 and 041), with the button that updates it: the page is
 * built when the window runs the built page, then the daemon restarts when its code changed. loki says when a chat is
 * working, and only "update anyway" then cuts it off. "later" hides it until the next change; it goes by itself once
 * the window reloads on the new build or the daemon is back, since neither owes an update.
 */
export function RestartNotice({
  due,
  restart,
}: {
  /** The change that made an update due; `n` goes up with each change, so each one shows the notice again. */
  due: { file: string; n: number } | null;
  restart: (anyway: boolean) => Promise<string | null>;
}) {
  const show = useEffectEvent((file: string) => offer(file, null, restart));
  const file = due?.file ?? null;
  const n = due?.n ?? 0;
  // The notices are outside React: show this one at each change, even after "later"; take it down when none is due.
  useEffect(() => {
    if (file) show(file);
    else notify.dismiss(ID);
  }, [file, n]);
  return null;
}

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
 * Whether a chat is mid-turn (plan 2026-11-15-2319, R11): a turn running, or a tool call waiting on an approval.
 * Restarting stops either. A reply its agent proposed also counts as an approval in the list, but no turn waits on it.
 */
export function chatWorking(items: ReadonlyArray<Pick<AttentionItem, "status" | "pendingApproval">>): boolean {
  return items.some((i) => i.status === "running" || i.pendingApproval !== null);
}

/** The version to offer the notice for, at most once a launch: a ready one not offered yet, which is then marked offered. */
export function takeOffer(version: string | null, offered: Set<string>): string | null {
  if (!version || offered.has(version)) return null;
  offered.add(version);
  return version;
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

/** The notice that `version` is ready, with Restart to Update and Later; `working` is asked when the button is pressed. */
export function offerUpdate(
  version: string,
  { working, restart }: { working: () => boolean; restart: () => Promise<string | null> },
  toast: Notifier = notify,
): void {
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
 * The Restart to Update notice (plan 2026-11-15-2319, U5): shown once per ready update, in the main window. It goes
 * when no update is ready any more (one installed from the Settings window, or a failed install).
 */
export function UpdateNotice({ update, working }: { update: LokiUpdate; working: boolean }) {
  // Read when the button is pressed, which can be long after the notice showed.
  const isWorking = useRef(working);
  useEffect(() => {
    isWorking.current = working;
  });
  const version = readyVersion(update.status);
  const show = useEffectEvent((v: string) => offerUpdate(v, { working: () => isWorking.current, restart: update.restart }));
  useEffect(() => {
    if (!version) {
      notify.dismiss(UPDATE_ID);
      return;
    }
    const due = takeOffer(version, offeredThisLaunch);
    if (due) show(due);
  }, [version]);
  return null;
}

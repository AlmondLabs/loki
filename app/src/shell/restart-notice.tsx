import { useEffect, useEffectEvent } from "react";
import { notify } from "../components";

/** The one update notice: shown again in place, never stacked. */
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
    description: why ? undefined : "update to use it",
    duration: Infinity,
    action: {
      label: why ? "update anyway" : "update",
      onClick: (e) => {
        e.preventDefault(); // the notice stays, saying what happens next
        notify.loading("updating…", { id: ID, duration: Infinity });
        void restart(why !== null).then((err) => (err ? offer(file, err, restart) : undefined));
      },
    },
    cancel: { label: "later", onClick: () => undefined },
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

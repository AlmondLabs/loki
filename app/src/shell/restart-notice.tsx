import { useEffect, useEffectEvent } from "react";
import { notify } from "../components";

/** The one restart notice: shown again in place, never stacked. */
const ID = "loki-restart-due";

const showing = () => notify.getToasts().some((t) => t.id === ID);

/**
 * Offer the restart for `file`'s change, or say why it did not happen (a chat working, no answer) with "restart
 * anyway". A refusal that comes back after the notice went (the daemon was back, owing nothing) is not shown.
 */
function offer(file: string, why: string | null, restart: (anyway: boolean) => Promise<string | null>): void {
  if (why && !showing()) return;
  notify(why ?? `loki's code changed (${file})`, {
    id: ID,
    description: why ? undefined : "restart to use it",
    duration: Infinity,
    action: {
      label: why ? "restart anyway" : "restart",
      onClick: (e) => {
        e.preventDefault(); // the notice stays, saying what happens next
        notify.loading("restarting…", { id: ID, duration: Infinity });
        void restart(why !== null).then((err) => (err ? offer(file, err, restart) : undefined));
      },
    },
    cancel: { label: "later", onClick: () => undefined },
  });
}

/**
 * The notice that loki's daemon code changed in a checkout (plan 024), with the button that restarts it: loki says
 * when a chat is working, and only "restart anyway" then cuts it off. "later" hides it until the next change; it goes
 * by itself once the daemon is back, since a daemon just started owes no restart.
 */
export function RestartNotice({
  due,
  restart,
}: {
  /** The change that made a restart due; `n` goes up with each change, so each one shows the notice again. */
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

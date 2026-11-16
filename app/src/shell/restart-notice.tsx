import { useEffect, useEffectEvent } from "react";
import { notify } from "../components";

const ID = "loki-restart-due";

const showing = () => notify.getToasts().some((t) => t.id === ID);

function offer(file: string, why: string | null, restart: (anyway: boolean) => Promise<string | null>): void {
  if (why && !showing()) return;
  notify(why ?? `loki's code changed (${file})`, {
    id: ID,
    description: why ? undefined : "Update to use it",
    duration: Infinity,
    action: {
      label: why ? "Update Anyway" : "Update",
      onClick: (e) => {
        e.preventDefault();
        notify.loading("Updating…", { id: ID, duration: Infinity });
        void restart(why !== null).then((err) => (err ? offer(file, err, restart) : undefined));
      },
    },
    cancel: { label: "Later", onClick: () => undefined },
  });
}

export function RestartNotice({ due, restart }: { due: { file: string; n: number } | null; restart: (anyway: boolean) => Promise<string | null> }) {
  const show = useEffectEvent((file: string) => offer(file, null, restart));
  const file = due?.file ?? null;
  const n = due?.n ?? 0;
  useEffect(() => {
    if (file) show(file);
    else notify.dismiss(ID);
  }, [file, n]);
  return null;
}

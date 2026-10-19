import { useState } from "react";
import { Button, Toast } from "../components";

/**
 * The notice that loki's daemon code changed in a checkout (plan 024), with the button that restarts it: loki says
 * when a chat is working, and only "restart anyway" then cuts it off. "later" hides it until the next change. The
 * window reconnects on its own once the daemon is back.
 */
export function RestartNotice({ due, restart }: { due: string | null; restart: (anyway: boolean) => Promise<string | null> }) {
  const [later, setLater] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<{ file: string; why: string } | null>(null);
  const [restarting, setRestarting] = useState(false);
  if (!due || later === due) return null;
  const why = refusal?.file === due ? refusal.why : null;
  const go = async (anyway: boolean) => {
    setRestarting(true);
    const err = await restart(anyway);
    setRestarting(false);
    setRefusal(err ? { file: due, why: err } : null);
  };
  return (
    <Toast style={{ display: "flex", alignItems: "center", gap: 12 }}>
      <span>{why ?? `loki's code changed (${due}): restart to use it`}</span>
      <Button size="sm" tone="positive" disabled={restarting} onClick={() => void go(why !== null)}>
        {restarting ? "restarting…" : why ? "restart anyway" : "restart"}
      </Button>
      <Button size="sm" tone="quiet" onClick={() => setLater(due)}>
        later
      </Button>
    </Toast>
  );
}

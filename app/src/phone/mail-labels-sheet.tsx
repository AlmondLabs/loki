import { useEffect, useEffectEvent, useState } from "react";
import { Button, Chip, Sheet, sentence } from "../components";
import type { AccountLabel } from "../../../core/frame-types.ts";
import { messageOf } from "../../../core/errors.ts";

/** Gmail's own labels worth putting on a thread by hand; the rest (INBOX, UNREAD, SENT, …) are other moves or Gmail's. */
const SYSTEM_PICKS = new Set(["STARRED", "IMPORTANT"]);

/**
 * The phone's label picker on an email card (plan 070, R12): the account's Gmail labels as chips, read from Gmail when
 * the sheet opens; Add puts the ticked ones on the thread and the card stays for its next move. A refusal shows under
 * the chips and the sheet stays. Mounted only while open.
 */
export function MailLabelsSheet({
  load,
  onAdd,
  onClose,
}: {
  load: () => Promise<AccountLabel[] | string>;
  onAdd: (labelIds: string[]) => Promise<string | null>;
  onClose: () => void;
}) {
  const [labels, setLabels] = useState<AccountLabel[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<readonly string[]>([]);
  const [busy, setBusy] = useState(false);
  const read = useEffectEvent(() => load());
  useEffect(() => {
    let live = true;
    read()
      .then((r) => {
        if (!live) return;
        if (typeof r === "string") setError(r);
        else setLabels(r.filter((l) => l.type === "user" || SYSTEM_PICKS.has(l.id)));
      })
      .catch((e: unknown) => live && setError(messageOf(e)));
    return () => {
      live = false;
    };
  }, []);
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const add = async () => {
    if (!picked.length || busy) return;
    setBusy(true);
    setError(null);
    let err: string | null;
    try {
      err = await onAdd([...picked]);
    } catch (e) {
      err = messageOf(e);
    }
    setBusy(false);
    if (err) setError(err);
    else onClose();
  };
  return (
    <Sheet label="Labels in Gmail" onClose={onClose} placement="bottom" className="loki-phone-sheet">
      <div className="loki-phone-title">Labels in Gmail</div>
      {labels === null && !error ? (
        <p className="loki-phone-meta">Asking Gmail for labels…</p>
      ) : labels?.length === 0 ? (
        <p className="loki-phone-meta loki-phone-wrap">This account has no labels of its own yet; make one in Gmail.</p>
      ) : (
        labels && (
          <div role="group" aria-label="Labels" className="loki-phone-chips loki-phone-chips--wrap">
            {labels.map((l) => (
              <Chip key={l.id} touch active={picked.includes(l.id)} aria-pressed={picked.includes(l.id)} onClick={() => toggle(l.id)}>
                {l.type === "system" ? sentence(l.name.toLowerCase()) : l.name}
              </Chip>
            ))}
          </div>
        )
      )}
      {error && (
        <p role="alert" className="loki-phone-error">
          {error}
        </p>
      )}
      <Button size="touch" tone="positive" block disabled={!picked.length || busy} onClick={() => void add()}>
        {busy ? "Adding…" : "Add"}
      </Button>
      <Button size="touch" tone="paper" block onClick={onClose}>
        Cancel
      </Button>
    </Sheet>
  );
}

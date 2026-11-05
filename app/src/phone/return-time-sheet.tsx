import { useState } from "react";
import { Button, Field, Sheet } from "../components";
import { useNow } from "../components/use-now";
import { dateChoice, returnChoices } from "./deck";

/**
 * The phone's "when should it come back?" (plan 070, R7): asked the second time in a row a card is put off for later.
 * One tap on a time (later today, tomorrow, in 3 days, next week) or a picked date puts it off until then; closing the
 * sheet puts it off not at all, and the card stays where it was. Mounted only while open.
 */
export function ReturnTimeSheet({ title, onPick, onClose }: { title: string; onPick: (until: string) => void; onClose: () => void }) {
  const now = useNow();
  const [day, setDay] = useState("");
  const picked = day ? dateChoice(day, new Date(now)) : null;
  return (
    <Sheet label="When should it come back?" onClose={onClose} placement="bottom" className="loki-phone-sheet">
      <div className="loki-phone-title">When should it come back?</div>
      <p className="loki-phone-meta loki-phone-wrap">{title}</p>
      {returnChoices(new Date(now)).map((c) => (
        <Button key={c.label} size="touch" tone="paper" block onClick={() => onPick(c.until)}>
          {c.label}
        </Button>
      ))}
      <Field size="touch" type="date" aria-label="A date" value={day} onChange={(e) => setDay(e.target.value)} />
      <Button size="touch" tone="positive" block disabled={!picked} onClick={() => picked && onPick(picked)}>
        Come back that day
      </Button>
      <Button size="touch" tone="paper" block onClick={onClose}>
        Cancel
      </Button>
    </Sheet>
  );
}

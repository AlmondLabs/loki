import { useState } from "react";
import { Button, Field, Sheet } from "../components";
import { useNow } from "../components/use-now";
import { dateChoice, returnChoices } from "./deck";

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
        Come Back That Day
      </Button>
      <Button size="touch" tone="paper" block onClick={onClose}>
        Cancel
      </Button>
    </Sheet>
  );
}

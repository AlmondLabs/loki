import { Button, Sheet } from "../components";
import { LabelEditor } from "../chat/labels";
import type { LabelView } from "../../../core/labels.ts";

/**
 * The phone's labels… (plan 022, R1), as the desktop's dialog: the same editor at touch size in a bottom sheet, and
 * Done. Each tick saves at once. Mounted only while open.
 */
export function LabelsSheet({
  current,
  list,
  onChange,
  onClose,
}: {
  current: readonly string[];
  list: readonly LabelView[] | null;
  onChange: (labels: string[]) => Promise<string | null>;
  onClose: () => void;
}) {
  return (
    <Sheet label="Labels" onClose={onClose} placement="bottom" className="loki-phone-sheet">
      <div className="loki-phone-title">Labels</div>
      <LabelEditor current={current} list={list} touch onChange={onChange} />
      <Button size="touch" tone="paper" block onClick={onClose}>
        Done
      </Button>
    </Sheet>
  );
}

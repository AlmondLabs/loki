import { Button, Sheet } from "../components";
import { LabelEditor } from "../chat/labels";
import type { LabelView } from "../../../core/labels.ts";

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

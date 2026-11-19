import type { AttentionItem } from "../../../core/attention/model.ts";
import { Button, Sheet } from "../components";
import type { IconName } from "../shared/icons";
import { REFUSED, type CardAction, type CardActionKind, type Direction } from "./deck";
import { SheetRow } from "./home";

const NAME: Record<CardActionKind, string> = {
  seen: "Mark as Read",
  later: "Later",
  archive: "Archive",
  approve: "Approve",
  deny: "Deny",
  always: "Always Allow",
  label: "Label",
  handoff: "Hand Off",
};

const ICON: Record<CardActionKind, IconName> = {
  seen: "check",
  later: "clock",
  archive: "archive",
  approve: "check",
  deny: "close",
  always: "check",
  label: "tag",
  handoff: "send",
};

const GESTURE: Record<Direction, string> = { right: "Drag right", left: "Drag left", up: "Drag up" };

export function actionName(action: CardActionKind, item: AttentionItem): string {
  const tool = item.pendingApproval?.toolName;
  if (tool && (action === "approve" || action === "deny" || action === "always")) return `${NAME[action]} ${tool}`;
  return NAME[action];
}

export function CardActionsSheet({
  item,
  title,
  actions,
  onPick,
  onClose,
}: {
  item: AttentionItem;
  title: string;
  actions: CardAction[];
  onPick: (action: CardActionKind) => void;
  onClose: () => void;
}) {
  return (
    <Sheet label={`Actions for ${title}`} onClose={onClose} placement="bottom" className="loki-phone-sheet">
      <ul className="loki-phone-list">
        {actions.map((a) => (
          <SheetRow
            key={a.via}
            icon={ICON[a.via]}
            label={actionName(a.via, item)}
            aside={a.refused ? REFUSED[a.refused] : a.gesture ? GESTURE[a.gesture] : null}
            disabled={!!a.refused}
            onClick={() => onPick(a.via)}
          />
        ))}
      </ul>
      <Button size="touch" tone="paper" block onClick={onClose}>
        Cancel
      </Button>
    </Sheet>
  );
}

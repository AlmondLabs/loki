import { Button } from "@/ui/button";
import { cn } from "@/lib/utils";
import type { ItemActionsView, ItemVerb } from "./item-view";

/** How each move reads on its button, in Apple's words (plan 2026-11-12-1505, U4). */
const VERB_WORDS: Record<ItemVerb, string> = {
  archive: "Archive",
  mark_read: "Mark as Read",
  later: "Later",
  label: "Label",
  handoff: "Hand Off",
  open: "Open Chat",
  open_out: "Open in Jira",
};

/** One move as the surface makes it: what it does, its key in the grammar that applies, why it is off. */
export interface VerbControl {
  run: () => void;
  /** The key shown on the button (KTD9), absent where the surface has none. */
  keys?: string;
  /** What the move does, on hover. */
  title?: string;
  disabled?: boolean;
}

/**
 * The item's moves (plan 097, ActionBar; R13), in the row under its box, where the reply and the move that goes with
 * it meet: the one that finishes the item at the right end and in full weight (archive for a chat or an email, read
 * for Slack and Jira), the rest before it, quiet. Only the moves this surface can make are drawn, in the view's order;
 * Flow's keys show on each and keep their meaning (KTD9).
 */
export function ActionBar({
  view,
  verbs,
  quiet = false,
  className,
}: {
  view: ItemActionsView;
  verbs: Partial<Record<ItemVerb, VerbControl>>;
  /**
   * The item waits on a decision (an approval, a question): the finishing move keeps its place but gives up its fill,
   * so the decision's own button is the one filled button in reach and archive is not pressed for approve.
   */
  quiet?: boolean;
  /** Where it lines up: under a chat's Composer, the Composer's column, so the main move ends where the box does. */
  className?: string;
}) {
  const more = view.more.filter((v) => v !== view.main && verbs[v]);
  const main = verbs[view.main];
  return (
    <div data-action-bar className={cn("flex w-full flex-wrap items-center justify-end gap-1", className)}>
      {more.map((v) => {
        const c = verbs[v];
        return c ? <VerbButton key={v} verb={v} control={c} quiet /> : null;
      })}
      {main && <VerbButton verb={view.main} control={main} quiet={false} muted={quiet} />}
    </div>
  );
}

/** One move: Apple's words on a capsule, its key in the tooltip rather than on the face (plan 2026-11-12-1505, KTD7). */
function VerbButton({ verb, control, quiet, muted = false }: { verb: ItemVerb; control: VerbControl; quiet: boolean; muted?: boolean }) {
  const word = VERB_WORDS[verb];
  const tip = control.keys ? `${control.title ?? word} (${control.keys})` : control.title;
  return (
    <Button
      size="sm"
      variant={quiet ? "ghost" : muted ? "outline" : "default"}
      className="rounded-full"
      data-verb={verb}
      data-main={quiet ? undefined : "true"}
      data-muted={muted || undefined}
      disabled={control.disabled}
      title={tip}
      onClick={control.run}
    >
      {word}
    </Button>
  );
}

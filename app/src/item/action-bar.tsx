import { Button } from "@/ui/button";
import { Kbd } from "@/ui/kbd";
import type { ItemActionsView, ItemVerb } from "./item-view";

/** How each move reads on its button: lowercase desktop words, as Flow's buttons say them today. */
const VERB_WORDS: Record<ItemVerb, string> = {
  archive: "archive",
  mark_read: "read",
  later: "later",
  label: "label",
  handoff: "hand off",
  open: "open chat",
  open_out: "open in jira",
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
 * The item's moves (plan 097, ActionBar; R13): the one that finishes the item last and in full weight (archive for a
 * chat or an email, read for Slack and Jira), the rest before it, quiet. Only the moves this surface can make are
 * drawn, in the view's order; Flow's keys show on each and keep their meaning (KTD9).
 */
export function ActionBar({ view, verbs }: { view: ItemActionsView; verbs: Partial<Record<ItemVerb, VerbControl>> }) {
  const more = view.more.filter((v) => v !== view.main && verbs[v]);
  const main = verbs[view.main];
  return (
    <div data-action-bar className="flex flex-wrap items-center justify-end gap-1">
      {more.map((v) => {
        const c = verbs[v];
        return c ? <VerbButton key={v} verb={v} control={c} quiet /> : null;
      })}
      {main && <VerbButton verb={view.main} control={main} quiet={false} />}
    </div>
  );
}

function VerbButton({ verb, control, quiet }: { verb: ItemVerb; control: VerbControl; quiet: boolean }) {
  return (
    <Button
      size="sm"
      variant={quiet ? "ghost" : "default"}
      data-verb={verb}
      data-main={quiet ? undefined : "true"}
      disabled={control.disabled}
      title={control.title}
      onClick={control.run}
    >
      {VERB_WORDS[verb]}
      {control.keys && <Kbd className={quiet ? undefined : "bg-primary-foreground/15 text-primary-foreground"}>{control.keys}</Kbd>}
    </Button>
  );
}

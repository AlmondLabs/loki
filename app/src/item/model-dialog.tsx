import {
  ModelSelector,
  ModelSelectorContent,
  ModelSelectorEmpty,
  ModelSelectorGroup,
  ModelSelectorInput,
  ModelSelectorItem,
  ModelSelectorList,
} from "@/ui/ai-elements/model-selector";
import { harnessOf, harnesses, selectionOf, type ModelEntry, type ModelSelection, type ReasoningEffort } from "../../../core/models.ts";
import {
  effortEntriesFor,
  effortLabel,
  groupModelEntries,
  modelLine,
  modelLists,
  nameInHarness,
  preferredModelEntry,
  type ModelGroup,
} from "../chat/model-picker";

/** What the model dialog takes: the same as today's picker, which it replaces in the new pane. */
export interface ModelDialogProps {
  open: boolean;
  current: string | null;
  currentEffort: ReasoningEffort | null;
  entries: ModelEntry[] | null;
  /** Something has been said: the chat stays on its harness, and the others' models are not offered (plan 020, KD4). */
  started?: boolean;
  loading: boolean;
  onPick: (selection: ModelSelection) => void;
  onClose: () => void;
}

/**
 * Select model in the new pane, on AI Elements' ModelSelector (plan 097, U6): a dialog with one filter over every
 * model, grouped by harness, loki's own as its quick picks then the rest; the current model checked; and, for a model
 * that offers several, its effort levels. A harness the chat cannot move to once started is left out with a line
 * saying why. Every choice applies to this conversation, and choosing closes the dialog.
 */
export function ModelDialog({ open, onClose, ...props }: ModelDialogProps) {
  return (
    <ModelSelector open={open} onOpenChange={(next) => !next && onClose()}>
      <ModelSelectorContent title="select model" className="max-w-lg" showCloseButton={false}>
        <ModelDialogChoices {...props} onClose={onClose} />
      </ModelSelectorContent>
    </ModelSelector>
  );
}

/** The dialog's filter, models and efforts, apart from the dialog, which a test draws inside a plain Command. */
export function ModelDialogChoices({ current, currentEffort, entries, started = false, loading, onPick, onClose }: Omit<ModelDialogProps, "open">) {
  const pick = (selection: ModelSelection) => {
    onPick(selection);
    onClose();
  };
  const chatHarness = harnessOf(current);
  const tabs = harnesses(entries ?? [], chatHarness, started);
  const locked = tabs.filter((t) => t.locked);
  const efforts = effortEntriesFor(entries ?? [], current);
  const item = (group: ModelGroup, name: string, line: string | null) => (
    <ModelSelectorItem
      key={group.handle}
      value={`${group.handle} ${name}`}
      data-checked={group.handle === current}
      onSelect={() => pick(selectionOf(preferredModelEntry(group, currentEffort)))}
      disabled={!group.available}
    >
      <span className="flex min-w-0 flex-col">
        <span className="truncate">{name}</span>
        {line && <span className="truncate text-meta text-muted-foreground">{line}</span>}
      </span>
    </ModelSelectorItem>
  );
  return (
    <>
      <ModelSelectorInput placeholder="filter by provider or name" />
      <ModelSelectorList className="max-h-96">
        <ModelSelectorEmpty>{entries ? "no model matches" : loading ? "loading models…" : "no models from the harness"}</ModelSelectorEmpty>
        {tabs
          .filter((t) => !t.locked)
          .map((t) => {
            const inTab = (entries ?? []).filter((entry) => harnessOf(entry.handle) === t.id);
            const lists = t.id === null ? modelLists(inTab, current) : { short: groupModelEntries(inTab), more: [] };
            return [
              <ModelSelectorGroup key={`${t.id ?? "loki"}-short`} heading={tabs.length > 1 ? t.name : "models"}>
                {lists.short.map((g) => item(g, nameInHarness(g, t), modelLine(g)))}
              </ModelSelectorGroup>,
              lists.more.length > 0 && (
                <ModelSelectorGroup key={`${t.id ?? "loki"}-more`} heading="more models">
                  {lists.more.map((g) => item(g, nameInHarness(g, t), g.handle))}
                </ModelSelectorGroup>
              ),
            ];
          })}
        {efforts.length > 1 && (
          <ModelSelectorGroup heading="effort">
            {efforts.map((entry) =>
              entry.reasoning_effort ? (
                <ModelSelectorItem
                  key={entry.reasoning_effort}
                  value={`effort ${effortLabel(entry.reasoning_effort)}`}
                  data-checked={entry.reasoning_effort === currentEffort}
                  onSelect={() => pick(selectionOf(entry))}
                >
                  {effortLabel(entry.reasoning_effort)}
                </ModelSelectorItem>
              ) : null,
            )}
          </ModelSelectorGroup>
        )}
      </ModelSelectorList>
      <p className="m-0 border-t px-3 py-2 text-meta text-muted-foreground">
        for this conversation
        {locked.length > 0 && ` · ${locked.map((t) => t.name).join(", ")} only in a new chat, since this one has started`}
      </p>
    </>
  );
}

import { memo, useState } from "react";
import {
  BotIcon,
  FileTextIcon,
  GlobeIcon,
  ListChecksIcon,
  PencilIcon,
  SearchIcon,
  SparklesIcon,
  TerminalIcon,
  WrenchIcon,
  XIcon,
  type LucideIcon,
} from "lucide-react";
import type { TranscriptRow } from "../../../../core/attention/transcript.ts";
import { ChainOfThought, ChainOfThoughtContent, ChainOfThoughtHeader, ChainOfThoughtStep } from "@/ui/ai-elements/chain-of-thought";
import { ToggleGroup, ToggleGroupItem } from "@/ui/toggle-group";
import {
  isNamedStep,
  lastFailure,
  stepFailed,
  stepKind,
  stepName,
  stepTarget,
  stepVerb,
  withoutSkillCalls,
  workSummary,
  type StepKind,
} from "../../shared/tool-steps";
import { StepDetail } from "../tool-steps";

/** Which steps of a stretch to show. */
type Filter = "all" | "failed" | "steps" | "housekeeping";
/** Past this many steps a stretch offers the filters, as today's does. */
const FILTER_FROM = 8;
const FILTERS: ReadonlyArray<[Filter, string]> = [
  ["all", "all"],
  ["failed", "failed"],
  ["steps", "steps"],
  ["housekeeping", "files and search"],
];
const KEEP: Record<Filter, (row: TranscriptRow) => boolean> = { all: () => true, failed: stepFailed, steps: isNamedStep, housekeeping: (r) => !isNamedStep(r) };
const isFilter = (v: unknown): v is Filter => FILTERS.some(([f]) => f === v);

/** Each kind of step's mark in the list, from Lucide. */
const ICON: Record<StepKind, LucideIcon> = {
  background: ListChecksIcon,
  command: TerminalIcon,
  agent: BotIcon,
  skill: SparklesIcon,
  read: FileTextIcon,
  edit: PencilIcon,
  search: SearchIcon,
  web: GlobeIcon,
  plan: ListChecksIcon,
  tool: WrenchIcon,
};

/**
 * A stretch of the agent's work on AI Elements' ChainOfThought (plan 094): its header is the one line in the wording of
 * shared/tool-steps.ts ("Worked 14 min · 3 commands, 11 tools · 1 failed"), with the failed step named under it while
 * closed; opened, a step per tool call with its mark, what it was done to and what it did, the running one active, a
 * failed one in the negative colour. A step opens its description, input and output under it. Past 8 steps the filters
 * appear; opened at a failure, they start on "failed".
 */
export const ThreadSteps = memo(
  function ThreadSteps({ rows: all, running, arrived }: { rows: TranscriptRow[]; running: boolean; arrived: boolean }) {
    const rows = withoutSkillCalls(all);
    const [open, setOpen] = useState(false);
    const [at, setAt] = useState<number | null>(null);
    const [filter, setFilter] = useState<Filter>("all");
    const failure = running ? null : lastFailure(rows);
    const show = (step: number | null) => {
      setAt(step);
      setFilter(step !== null && stepFailed(rows[step]) && rows.length > FILTER_FROM ? "failed" : "all");
      setOpen(true);
    };
    const shown = rows.flatMap((r, k) => (KEEP[filter](r) ? [k] : []));
    return (
      <div data-row="tool" data-arrived={arrived || undefined} className="flex flex-col gap-1.5">
        <ChainOfThought open={open} onOpenChange={(next) => (next ? show(null) : setOpen(false))} className="max-w-none space-y-0">
          <ChainOfThoughtHeader icon={running ? WrenchIcon : TerminalIcon} className={running ? "shimmer" : undefined}>
            {workSummary(rows, running)}
          </ChainOfThoughtHeader>
          <ChainOfThoughtContent>
            {rows.length > FILTER_FROM && (
              <ToggleGroup
                size="sm"
                variant="outline"
                aria-label="show"
                value={[filter]}
                onValueChange={(v: unknown[]) => {
                  if (isFilter(v[0])) setFilter(v[0]);
                }}
              >
                {FILTERS.map(([f, label]) => {
                  const n = rows.filter(KEEP[f]).length;
                  if (f === "failed" && !n) return null;
                  return (
                    <ToggleGroupItem key={f} value={f}>
                      {label} <span className="text-muted-foreground tabular-nums">{n}</span>
                    </ToggleGroupItem>
                  );
                })}
              </ToggleGroup>
            )}
            {shown.map((k) => (
              <Step key={k} row={rows[k]} active={running && k === rows.length - 1} open={at === k} onToggle={() => setAt(at === k ? null : k)} />
            ))}
          </ChainOfThoughtContent>
        </ChainOfThought>
        {failure !== null && !open && (
          <button type="button" className="flex w-fit cursor-pointer items-center gap-1.5 text-meta text-loki-negative" onClick={() => show(failure)}>
            <XIcon className="size-3" aria-hidden />
            {stepTarget(rows[failure]) ?? stepName(rows[failure])} failed
          </button>
        )}
      </div>
    );
  },
  // The host slices a fresh array each render; the stretch is the same while its rows are.
  (a, b) => a.running === b.running && a.arrived === b.arrived && a.rows.length === b.rows.length && a.rows.every((r, i) => r === b.rows[i]),
);

/** One tool call: what it was done to, what it did, and its detail under it once opened; housekeeping reads quieter. */
function Step({ row, active, open, onToggle }: { row: TranscriptRow; active: boolean; open: boolean; onToggle: () => void }) {
  const failed = stepFailed(row);
  const target = stepTarget(row);
  const verb = stepVerb(stepName(row));
  return (
    <ChainOfThoughtStep
      icon={failed ? XIcon : ICON[stepKind(row)]}
      status={active ? "active" : isNamedStep(row) ? "complete" : "pending"}
      className={failed ? "text-loki-negative" : undefined}
      label={
        <button type="button" aria-expanded={open} onClick={onToggle} className="cursor-pointer text-left hover:text-foreground">
          {target ?? verb}
          {failed && " · failed"}
        </button>
      }
      description={target ? verb : undefined}
    >
      {open && <StepDetail row={row} />}
    </ChainOfThoughtStep>
  );
}

import { memo, useState } from "react";
import { XIcon } from "lucide-react";
import type { TranscriptRow } from "../../../../core/attention/transcript.ts";
import { ToggleGroup, ToggleGroupItem } from "@/ui/toggle-group";
import { Trace, TraceCollapsible, TraceCollapsibleContent, TraceCollapsibleTrigger, TraceLine, TraceTitle } from "@/ui/trace";
import { isNamedStep, lastFailure, stepFailed, stepName, stepTarget, stepVerb, withoutSkillCalls, workSummary } from "../../shared/tool-steps";
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

/**
 * A stretch of the agent's work (plan 094, KTD9) on shadcn's Trace: one closed line in the wording of
 * shared/tool-steps.ts ("worked 14 min · 3 commands, 11 tools · 1 failed"), shimmering while it runs, with the failed
 * step named under it; opened, a line per step, each opening its description, input and output. Past 8 steps the
 * filters appear; opened at a failure, they start on "failed".
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
      <Trace data-row="tool" data-arrived={arrived || undefined}>
        <TraceCollapsible open={open} onOpenChange={(next) => (next ? show(null) : setOpen(false))}>
          <TraceCollapsibleTrigger>
            <TraceLine status={running ? "running" : undefined}>
              <TraceTitle>{workSummary(rows, running)}</TraceTitle>
            </TraceLine>
          </TraceCollapsibleTrigger>
          <TraceCollapsibleContent>
            <div className="flex flex-col gap-2">
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
              <ol className="flex flex-col gap-1.5">
                {shown.map((k) => (
                  <li key={k}>
                    <TraceCollapsible open={at === k} onOpenChange={(next) => setAt(next ? k : null)}>
                      <TraceCollapsibleTrigger>
                        <StepLine row={rows[k]} />
                      </TraceCollapsibleTrigger>
                      <TraceCollapsibleContent>
                        <StepDetail row={rows[k]} />
                      </TraceCollapsibleContent>
                    </TraceCollapsible>
                  </li>
                ))}
              </ol>
            </div>
          </TraceCollapsibleContent>
        </TraceCollapsible>
        {failure !== null && !open && (
          <button type="button" className="flex w-fit cursor-pointer items-center gap-1.5 text-meta text-destructive" onClick={() => show(failure)}>
            <XIcon className="size-3" aria-hidden />
            {stepTarget(rows[failure]) ?? stepName(rows[failure])} failed
          </button>
        )}
      </Trace>
    );
  },
  // The host slices a fresh array each render; the stretch is the same while its rows are.
  (a, b) => a.running === b.running && a.arrived === b.arrived && a.rows.length === b.rows.length && a.rows.every((r, i) => r === b.rows[i]),
);

/** One step's line: what was done and to what; housekeeping reads quieter, and a failed step says so. */
function StepLine({ row }: { row: TranscriptRow }) {
  const target = stepTarget(row);
  const verb = stepVerb(stepName(row));
  return (
    <TraceLine status={stepFailed(row) ? "error" : isNamedStep(row) ? undefined : "pending"}>
      <TraceTitle>
        {target ?? verb}
        {target && <span className="text-muted-foreground"> · {verb}</span>}
        {stepFailed(row) && <span> · failed</span>}
      </TraceTitle>
    </TraceLine>
  );
}

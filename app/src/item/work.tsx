import { memo, useState } from "react";
import {
  BotIcon,
  BrainIcon,
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
import type { PlanItem, TranscriptRow } from "../../../core/attention/transcript.ts";
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
} from "../shared/tool-steps";
import { Button } from "@/ui/button";
import { Shimmer } from "@/ui/ai-elements/shimmer";
import { Task, TaskContent, TaskItem, TaskTrigger } from "@/ui/ai-elements/task";
import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput } from "@/ui/ai-elements/tool";
import { useWhole } from "../chat/tool-steps";
import { AgentPlan, planProgress } from "./agent-plan";
import { thoughtOf, thoughtWords } from "./thought";

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
 * A stretch of the agent's work on AI Elements' ChainOfThought (plan 096): its header is the one line in the wording of
 * shared/tool-steps.ts ("Worked 14 min · 3 commands, 11 tools · 1 failed"), with the failed step named under it while
 * closed; opened, a step per tool call with its mark, what it was done to and what it did, the running one active, a
 * failed one in the negative colour. A step opens its description, input and output under it. Past 8 steps the filters
 * appear; opened at a failure, they start on "failed".
 */
export const Work = memo(
  function Work({
    rows: all,
    thoughts: after = NO_ROWS,
    running,
    arrived,
    waiting = false,
    planAsBefore = false,
  }: {
    rows: TranscriptRow[];
    /** Rows after the stretch whose thoughts it shows last: the thought before the reply that follows it. */
    thoughts?: readonly TranscriptRow[];
    running: boolean;
    arrived: boolean;
    waiting?: boolean;
    /** The plan is the one an earlier stretch already drew, unchanged: it folds to one quiet line. */
    planAsBefore?: boolean;
  }) {
    // The agent's plan is drawn as its Plan, from the newest one in the stretch, not as a step (plan 097, U9).
    const plan = stretchPlan(all);
    const rows = withoutSkillCalls(all).filter((r) => !r.tool?.plan);
    const [open, setOpen] = useState(false);
    const [at, setAt] = useState<number | null>(null);
    const [filter, setFilter] = useState<Filter>("all");
    const failure = running ? null : lastFailure(rows);
    const show = (step: number | null) => {
      setAt(step);
      setFilter(step !== null && stepFailed(rows[step]) && rows.length > FILTER_FROM ? "failed" : "all");
      setOpen(true);
    };
    // The list in order: each thought before the step it led to, then the thoughts the stretch took from after it.
    // Thoughts show only under "all": a filter narrows to steps.
    const listed: Array<{ step: number } | { thought: TranscriptRow }> = [
      ...all.flatMap((r) => {
        const k = rows.indexOf(r);
        return [...(r.thought ? [{ thought: r }] : []), ...(k >= 0 && KEEP[filter](r) ? [{ step: k }] : [])];
      }),
      ...after.map((r) => ({ thought: r })),
    ].filter((item) => "step" in item || filter === "all");
    return (
      <div data-row="tool" data-arrived={arrived || undefined} className="flex flex-col gap-1.5">
        {plan && (planAsBefore ? <PlanAsBefore items={plan} /> : <AgentPlan items={plan} />)}
        {rows.length > 0 && (
          <ChainOfThought open={open} onOpenChange={(next) => (next ? show(null) : setOpen(false))} className="max-w-none space-y-0">
            <ChainOfThoughtHeader icon={running ? WrenchIcon : TerminalIcon} className={running && !waiting ? "shimmer" : undefined}>
              {waiting ? "Waiting on you" : workSummary(rows, running)}
            </ChainOfThoughtHeader>
            <ChainOfThoughtContent>
              {rows.length > FILTER_FROM && (
                <ToggleGroup
                  size="sm"
                  variant="outline"
                  aria-label="Show"
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
              {listed.map((item, i) =>
                "step" in item ? (
                  <Step
                    key={`s${item.step}`}
                    row={rows[item.step]}
                    active={running && item.step === rows.length - 1}
                    waiting={waiting}
                    open={at === item.step}
                    onToggle={() => setAt(at === item.step ? null : item.step)}
                  />
                ) : (
                  <ThoughtStep key={`t${i}`} row={item.thought} />
                ),
              )}
            </ChainOfThoughtContent>
          </ChainOfThought>
        )}
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
  (a, b) =>
    a.running === b.running &&
    a.arrived === b.arrived &&
    a.waiting === b.waiting &&
    a.planAsBefore === b.planAsBefore &&
    (a.thoughts?.length ?? 0) === (b.thoughts?.length ?? 0) &&
    (a.thoughts ?? NO_ROWS).every((r, i) => r === b.thoughts?.[i]) &&
    a.rows.length === b.rows.length &&
    a.rows.every((r, i) => r === b.rows[i]),
);

const NO_ROWS: readonly TranscriptRow[] = [];

/**
 * A thought among the steps (plan 2026-11-14-0852, 4): "Thought for 12 seconds", opening to the thought itself, in the
 * place it came, so thinking reads as part of the work rather than a line of its own.
 */
function ThoughtStep({ row }: { row: TranscriptRow }) {
  const [open, setOpen] = useState(false);
  const t = thoughtOf([row]);
  if (!t) return null;
  return (
    <ChainOfThoughtStep
      icon={BrainIcon}
      status="complete"
      label={
        <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="cursor-pointer text-left hover:text-foreground">
          {thoughtWords(t.seconds)}
        </button>
      }
    >
      {open && <p className="m-0 text-meta whitespace-pre-wrap text-muted-foreground">{t.text}</p>}
    </ChainOfThoughtStep>
  );
}

/** The newest plan in a stretch of work, the one its Plan draws; null when the stretch has none. */
export const stretchPlan = (rows: readonly TranscriptRow[]): readonly PlanItem[] | null => [...rows].reverse().find((r) => r.tool?.plan)?.tool?.plan ?? null;

/** Whether two plans say the same: the same entries in the same order, each at the same status. */
export const samePlan = (a: readonly PlanItem[] | null, b: readonly PlanItem[] | null): boolean =>
  a !== null && b !== null && a.length === b.length && a.every((item, i) => item.content === b[i].content && item.status === b[i].status);

/** A plan the thread already showed, unchanged since: one quiet line, so a turn's answer is not buried under it again. */
function PlanAsBefore({ items }: { items: readonly PlanItem[] }) {
  return (
    <p data-plan="as-before" className="m-0 flex items-center gap-2 text-meta text-muted-foreground">
      <ListChecksIcon aria-hidden className="size-4" />
      plan as before · {planProgress(items)}
    </p>
  );
}

/**
 * One tool call: what it was done to, what it did, and its detail under it once opened (plan 097, Work): a sub-agent or
 * a background task as AI Elements' Task, what it was asked and what it reported; any other step as Tool, its state, its
 * input and its output. A named step (a command, a sub-agent, a background task, or any that failed) reads in full
 * colour, housekeeping in the muted one, both at full strength: AI Elements' "pending" fades a step to half, which would
 * fail AA and say a finished step has not run. The running step shimmers.
 */
function Step({ row, active, waiting, open, onToggle }: { row: TranscriptRow; active: boolean; waiting: boolean; open: boolean; onToggle: () => void }) {
  const failed = stepFailed(row);
  const target = stepTarget(row);
  const verb = stepVerb(stepName(row));
  return (
    <ChainOfThoughtStep
      icon={failed ? XIcon : ICON[stepKind(row)]}
      status={active ? "active" : "complete"}
      className={failed ? "text-loki-negative" : !active && isNamedStep(row) ? "text-foreground" : undefined}
      label={
        <button type="button" aria-expanded={open} onClick={onToggle} className="cursor-pointer text-left hover:text-foreground">
          {active && waiting ? (
            // Paused on the person (KTD6): the step says so, and the Proposal above the box holds the answers.
            <>
              {target ?? verb}
              <span className="text-loki-attention"> · waiting on you</span>
            </>
          ) : active ? (
            <Shimmer as="span">{target ?? verb}</Shimmer>
          ) : (
            <>
              {target ?? verb}
              {failed && " · failed"}
            </>
          )}
        </button>
      }
      description={target ? verb : undefined}
    >
      {open && <StepOpened row={row} running={active} />}
    </ChainOfThoughtStep>
  );
}

/** What an opened step shows, fetched first for a lean row; a sub-agent's or background task's work reads as a Task. */
export function StepOpened({ row, running }: { row: TranscriptRow; running: boolean }) {
  const { whole, state, retry } = useWhole(row);
  if (state === "loading") return <p className="m-0 text-meta text-muted-foreground">Loading this step…</p>;
  if (state === "failed")
    return (
      <p className="m-0 flex items-center gap-2 text-meta text-muted-foreground">
        Could not load this step
        <Button size="xs" variant="outline" onClick={retry}>
          Try Again
        </Button>
      </p>
    );
  const kind = stepKind(row);
  const failed = stepFailed(row);
  if (row.role === "event" || kind === "agent" || kind === "background") {
    const t = whole?.step ?? null;
    const asked = t?.description ?? t?.input ?? null;
    const said = whole?.detail ?? t?.output ?? null;
    return (
      <Task defaultOpen>
        <TaskTrigger title={stepTarget(row) ?? stepName(row)} icon={ICON[kind]} />
        <TaskContent>
          {asked && <TaskItem>Asked: {asked}</TaskItem>}
          {said ? (
            <TaskItem>
              <pre className={failed ? "m-0 font-mono text-meta whitespace-pre-wrap text-loki-negative" : "m-0 font-mono text-meta whitespace-pre-wrap"}>
                {said}
              </pre>
            </TaskItem>
          ) : (
            <TaskItem>{running ? "still working" : "nothing more was recorded"}</TaskItem>
          )}
        </TaskContent>
      </Task>
    );
  }
  const t = whole?.step;
  const shell = kind === "command";
  return (
    <Tool open className="mb-0">
      <ToolHeader
        chevron={false}
        title={stepName(row)}
        type={`tool-${kind}`}
        state={running ? "input-available" : failed ? "output-error" : "output-available"}
      />
      <ToolContent>
        {t?.description && <p className="m-0 px-4 pt-3 text-meta text-muted-foreground">{t.description}</p>}
        {t?.input && <ToolInput input={t.input} label={shell ? "Command" : "Input"} />}
        {t?.output ? (
          <ToolOutput output={failed ? undefined : t.output} errorText={failed ? t.output : undefined} />
        ) : (
          <p className="m-0 px-4 pb-3 text-meta text-muted-foreground">
            {running ? "nothing came back yet" : failed ? "it failed without saying why" : "no output was recorded"}
          </p>
        )}
      </ToolContent>
    </Tool>
  );
}

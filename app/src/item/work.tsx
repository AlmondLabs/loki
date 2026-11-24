import { cn } from "@/lib/utils";
import { memo, useState } from "react";
import { BrainIcon, ListChecksIcon, WrenchIcon } from "lucide-react";
import type { PlanItem, TranscriptRow } from "../../../core/attention/transcript.ts";
import { ChainOfThought, ChainOfThoughtContent, ChainOfThoughtHeader, ChainOfThoughtStep } from "@/ui/ai-elements/chain-of-thought";
import { ToggleGroup, ToggleGroupItem } from "@/ui/toggle-group";
import { isNamedStep, stepFailed, stepKind, stepName, stepTarget, stepTitle, stepIconOf, stepLines, workSummary, type StepLine } from "../shared/tool-steps";
import { Button } from "@/ui/button";
import { Shimmer } from "@/ui/ai-elements/shimmer";
import { Task, TaskContent, TaskItem, TaskTrigger } from "@/ui/ai-elements/task";
import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput } from "@/ui/ai-elements/tool";
import { useWhole } from "../chat/tool-steps";
import { glyphOf } from "../shared/icons";
import { AgentPlan, planProgress } from "./agent-plan";
import { thoughtOf, thoughtWords } from "./thought";

type Filter = "all" | "failed" | "steps" | "housekeeping";
const FILTER_FROM = 8;
const FILTERS: ReadonlyArray<[Filter, string]> = [
  ["all", "all"],
  ["failed", "failed"],
  ["steps", "steps"],
  ["housekeeping", "files and search"],
];
const KEEP: Record<Filter, (row: TranscriptRow) => boolean> = { all: () => true, failed: stepFailed, steps: isNamedStep, housekeeping: (r) => !isNamedStep(r) };
const isFilter = (v: unknown): v is Filter => FILTERS.some(([f]) => f === v);

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
    thoughts?: readonly TranscriptRow[];
    running: boolean;
    arrived: boolean;
    waiting?: boolean;
    planAsBefore?: boolean;
  }) {
    const plan = stretchPlan(all);
    const rows = all.filter((r) => !r.tool?.plan);
    const [open, setOpen] = useState(false);
    const [at, setAt] = useState<number | null>(null);
    const [filter, setFilter] = useState<Filter>("all");
    const lines = stepLines(rows);
    const show = () => {
      setAt(null);
      setFilter("all");
      setOpen(true);
    };
    const listed: Array<{ step: number } | { thought: TranscriptRow }> = [
      ...all.flatMap((r) => {
        const k = rows.indexOf(r);
        return [...(r.thought ? [{ thought: r }] : []), ...(k >= 0 && KEEP[filter](r) ? [{ step: k }] : [])];
      }),
      ...after.map((r) => ({ thought: r })),
    ].filter((item) => "step" in item || filter === "all");
    return (
      <div data-row="tool" data-arrived={arrived || undefined} className="flex flex-col gap-2">
        {plan && (planAsBefore ? <PlanAsBefore items={plan} /> : <AgentPlan items={plan} />)}
        {rows.length > 0 && (
          <ChainOfThought open={open} onOpenChange={(next) => (next ? show() : setOpen(false))} className="max-w-none space-y-0">
            <ChainOfThoughtHeader icon={running ? WrenchIcon : ListChecksIcon} className={running && !waiting ? "shimmer" : undefined}>
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
                    line={lines[item.step]}
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
      </div>
    );
  },
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
      {open && <p className="m-0 text-xs whitespace-pre-wrap text-muted-foreground">{t.text}</p>}
    </ChainOfThoughtStep>
  );
}

export const stretchPlan = (rows: readonly TranscriptRow[]): readonly PlanItem[] | null => [...rows].reverse().find((r) => r.tool?.plan)?.tool?.plan ?? null;

export const samePlan = (a: readonly PlanItem[] | null, b: readonly PlanItem[] | null): boolean =>
  a !== null && b !== null && a.length === b.length && a.every((item, i) => item.content === b[i].content && item.status === b[i].status);

function PlanAsBefore({ items }: { items: readonly PlanItem[] }) {
  return (
    <p data-plan="as-before" className="m-0 flex items-center gap-2 text-xs text-muted-foreground">
      <ListChecksIcon aria-hidden className="size-4" />
      plan as before · {planProgress(items)}
    </p>
  );
}

export function Step({
  row,
  line,
  active,
  waiting,
  open,
  onToggle,
}: {
  row: TranscriptRow;
  line: StepLine;
  active: boolean;
  waiting: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  const failed = stepFailed(row);
  const asking = active && waiting;
  const tag = asking ? "Waiting" : line.tag;
  return (
    <ChainOfThoughtStep
      icon={glyphOf(line.icon)}
      status={active ? "active" : "complete"}
      className={!active && !failed && isNamedStep(row) ? "text-foreground" : undefined}
      label={
        <button
          type="button"
          aria-expanded={open}
          aria-label={`${line.full}, ${tag}`}
          title={line.full}
          onClick={onToggle}
          className="flex w-full min-w-0 cursor-pointer items-baseline gap-3 text-left hover:text-foreground"
        >
          {active && !waiting ? (
            <Shimmer as="span" className="min-w-0 truncate">
              {line.title}
            </Shimmer>
          ) : (
            <span className="min-w-0 truncate">{line.title}</span>
          )}
          <span className={cn("ml-auto shrink-0 text-xs", failed ? "text-loki-negative" : asking ? "text-loki-attention" : "text-muted-foreground")}>
            {tag}
          </span>
        </button>
      }
    >
      {open && <StepOpened row={row} running={active} />}
    </ChainOfThoughtStep>
  );
}

export function StepOpened({ row, running }: { row: TranscriptRow; running: boolean }) {
  const { whole, state, retry } = useWhole(row);
  if (state === "loading") return <p className="m-0 text-xs text-muted-foreground">Loading this step…</p>;
  if (state === "failed")
    return (
      <p className="m-0 flex items-center gap-2 text-xs text-muted-foreground">
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
    const command = row.role === "event" ? row.command : undefined;
    const asked = row.role === "event" ? undefined : t?.input;
    const said = whole?.detail ?? t?.output ?? null;
    return (
      <Task defaultOpen>
        <TaskTrigger title={stepTarget(row) ?? stepName(row)} icon={glyphOf(stepIconOf(row))} />
        <TaskContent>
          {command && (
            <TaskItem className="space-y-2">
              <h4 className="font-semibold text-xs">Command</h4>
              <pre className="m-0 font-mono text-xs whitespace-pre-wrap">{command}</pre>
            </TaskItem>
          )}
          {asked && (
            <TaskItem className="space-y-2">
              <h4 className="font-semibold text-xs">Asked</h4>
              <p className="m-0 whitespace-pre-wrap">{asked}</p>
            </TaskItem>
          )}
          {said ? (
            <TaskItem>
              <pre className={failed ? "m-0 font-mono text-xs whitespace-pre-wrap text-loki-negative" : "m-0 font-mono text-xs whitespace-pre-wrap"}>
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
        title={stepTitle(stepName(row))}
        type={`tool-${kind}`}
        state={running ? "input-available" : failed ? "output-error" : "output-available"}
      />
      <ToolContent>
        {t?.description && <p className="m-0 px-4 pt-3 text-xs text-muted-foreground">{t.description}</p>}
        {t?.input && <ToolInput input={t.input} label={shell ? "Command" : "Input"} />}
        {t?.output ? (
          <ToolOutput output={failed ? undefined : t.output} errorText={failed ? t.output : undefined} />
        ) : (
          <p className="m-0 px-4 pb-3 text-xs text-muted-foreground">
            {running ? "nothing came back yet" : failed ? "it failed without saying why" : "no output was recorded"}
          </p>
        )}
      </ToolContent>
    </Tool>
  );
}

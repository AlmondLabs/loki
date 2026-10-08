import { createContext, memo, useContext, useState } from "react";
import type { TranscriptRow } from "../../../core/attention/transcript.ts";
import { Sheet } from "../components";
import { Icon } from "../shared/icons";
import { lastFailure, stepFailed, stepIcon, stepKind, stepName, stepTarget, stepVerb, workPlan, workSummary, type PlanItem } from "../shared/toolSteps";

/**
 * A stretch of the agent's work in the thread (tool calls, background tasks, skills it loaded), as one quiet line:
 * "Worked 14 min · 10 background tasks, 3 commands, 11 tools · 1 failed ›", "Working" while it runs. When a step
 * failed, its name sits under the closed line in red, and a click opens the stretch at it. Opened, the named steps
 * (background tasks, commands, agents, anything that failed) are one line each, the housekeeping between them
 * (reads, searches, edits, skills) one muted line that opens to list each tool, and chips filter a long stretch. A step opens its command and
 * output under it, one at a time, inline on the desktop; on the phone the same list is a bottom sheet and a step
 * opens in it, with a way back. The wording is shared/toolSteps.ts.
 */

/** The conversation is the phone's (Conversation's `touch`): steps open as a bottom sheet rather than in place. */
export const StepsTouch = createContext(false);

export const ToolSteps = memo(
  function ToolSteps({ rows, running, arrived }: { rows: TranscriptRow[]; running: boolean; arrived?: true }) {
    const touch = useContext(StepsTouch);
    const [open, setOpen] = useState(false);
    const [at, setAt] = useState<number | null>(null);
    const failure = running ? null : lastFailure(rows);
    const show = (step: number | null) => {
      setAt(step);
      setOpen(true);
    };
    return (
      <div data-row="tool" data-arrived={arrived} className="loki-steps">
        <button type="button" className="loki-steps-line" data-running={running || undefined} aria-expanded={open} onClick={() => (open ? setOpen(false) : show(null))}>
          <span className="loki-steps-label">{workSummary(rows, running)}</span>
          <Icon name={!touch && open ? "chevron-down" : "chevron-right"} size={14} className="loki-steps-chev" />
        </button>
        {failure !== null && (!open || touch) && (
          <button type="button" className="loki-steps-failure" onClick={() => show(failure)}>
            <Icon name="close" size={12} />
            <span>{stepTarget(rows[failure]) ?? stepName(rows[failure])} failed</span>
          </button>
        )}
        {open && (touch ? <StepsSheet rows={rows} title={workSummary(rows)} start={at} onClose={() => setOpen(false)} /> : <StepsList rows={rows} openAt={at} onOpen={setAt} />)}
      </div>
    );
  },
  // The host slices a fresh array each render; the run is the same while its rows are.
  (a, b) => a.running === b.running && a.arrived === b.arrived && a.rows.length === b.rows.length && a.rows.every((r, i) => r === b.rows[i]),
);

/** One step's two lines: the verb, and what it was done to; a failed step says so. */
function StepText({ row }: { row: TranscriptRow }) {
  const target = stepTarget(row);
  return (
    <span className="loki-steps-text">
      <span className="loki-steps-verb">
        {target ?? stepVerb(stepName(row))}
        {stepFailed(row) && <span className="loki-steps-failed">Failed</span>}
      </span>
      {target && <span className="loki-steps-target">{stepVerb(stepName(row))}</span>}
    </span>
  );
}

/** A step's input and output, as they were recorded; a background task's notice carries its result; older rows kept neither. */
function StepDetail({ row }: { row: TranscriptRow }) {
  if (row.role === "event") {
    return row.detail ? (
      <div className="loki-steps-detail">
        <section>
          <h3 className="loki-steps-heading">{stepKind(row) === "skill" ? "Skill" : stepFailed(row) ? "Result · failed" : "Result"}</h3>
          <pre className="loki-steps-code" data-failed={stepFailed(row) || undefined}>{row.detail}</pre>
        </section>
      </div>
    ) : (
      <p className="loki-steps-none">Nothing more was recorded for this step.</p>
    );
  }
  const t = row.tool;
  const shell = stepIcon(stepName(row)) === "terminal";
  if (!t?.input && !t?.output && !t?.description) return <p className="loki-steps-none">No input or output was recorded for this step.</p>;
  return (
    <div className="loki-steps-detail">
      {t.description && (
        <section>
          <h3 className="loki-steps-heading">Description</h3>
          <p className="loki-steps-desc">{t.description}</p>
        </section>
      )}
      {t.input && (
        <section>
          <h3 className="loki-steps-heading">{shell ? "Command" : "Input"}</h3>
          <pre className="loki-steps-code">{t.input}</pre>
        </section>
      )}
      <section>
        <h3 className="loki-steps-heading">{t.failed ? "Output · failed" : "Output"}</h3>
        {t.output ? <pre className="loki-steps-code" data-failed={t.failed || undefined}>{t.output}</pre> : <p className="loki-steps-none">{t.failed ? "It failed without saying why." : "Nothing came back yet."}</p>}
      </section>
    </div>
  );
}

/** Which lines of a stretch to show. */
type Filter = "all" | "failed" | "steps" | "housekeeping";
const CHIPS: ReadonlyArray<[Filter, string]> = [["all", "All"], ["failed", "Failed"], ["steps", "Steps"], ["housekeeping", "Files and search"]];
/** Past this many lines a stretch offers the filter chips. */
const FILTER_FROM = 8;

function filtered(plan: PlanItem[], rows: TranscriptRow[], f: Filter): PlanItem[] {
  if (f === "failed") return plan.filter((p) => p.kind === "step" && stepFailed(rows[p.at]));
  if (f === "steps") return plan.filter((p) => p.kind === "step");
  if (f === "housekeeping") return plan.filter((p) => p.kind === "between");
  return plan;
}

/** The chips over a long stretch: all of it, what failed, the named steps, the housekeeping. */
function Filters({ plan, rows, value, onChange }: { plan: PlanItem[]; rows: TranscriptRow[]; value: Filter; onChange: (f: Filter) => void }) {
  if (plan.length <= FILTER_FROM) return null;
  return (
    <div className="loki-steps-filters" role="group" aria-label="Show">
      {CHIPS.map(([f, label]) => {
        const n = f === "all" ? rows.length : f === "failed" ? rows.filter(stepFailed).length : f === "steps" ? plan.filter((p) => p.kind === "step").length : plan.filter((p) => p.kind === "between").reduce((sum, p) => sum + (p.kind === "between" ? p.at.length : 0), 0);
        if (f === "failed" && !n) return null;
        return (
          <button key={f} type="button" className="loki-steps-chip" aria-pressed={value === f} onClick={() => onChange(f)}>
            {label} <span className="loki-steps-chip-n">{n}</span>
          </button>
        );
      })}
    </div>
  );
}

/** A step's line in the open list: its icon (a cross when it failed) and its two lines. */
function StepLine({ row, size }: { row: TranscriptRow; size: number }) {
  return (
    <>
      <Icon name={stepFailed(row) ? "close" : stepIcon(stepName(row))} size={size} className="loki-steps-icon" />
      <StepText row={row} />
    </>
  );
}

/** The desktop's: the stretch in place under its line; a step opens its command and output under it, one at a time. */
function StepsList({ rows, openAt, onOpen }: { rows: TranscriptRow[]; openAt: number | null; onOpen: (at: number | null) => void }) {
  const plan = workPlan(rows);
  const [filter, setFilter] = useState<Filter>(openAt !== null && stepFailed(rows[openAt]) && plan.length > FILTER_FROM ? "failed" : "all");
  // Housekeeping lines opened to list their tools, by their first row; "Files and search" lists them all.
  const [listed, setListed] = useState<ReadonlySet<number>>(new Set());
  const step = (at: number) => (
    <li key={at}>
      <button type="button" className="loki-steps-step" aria-expanded={openAt === at} onClick={() => onOpen(openAt === at ? null : at)}>
        <StepLine row={rows[at]} size={16} />
      </button>
      {openAt === at && <StepDetail row={rows[at]} />}
    </li>
  );
  return (
    <div className="loki-steps-open">
      <Filters plan={plan} rows={rows} value={filter} onChange={setFilter} />
      <ol className="loki-steps-list">
        {filtered(plan, rows, filter).map((p) => {
          if (p.kind === "step") return step(p.at);
          const open = filter === "housekeeping" || listed.has(p.at[0]);
          return (
            <li key={`b${p.at[0]}`}>
              <button type="button" className="loki-steps-between" aria-expanded={open} onClick={() => setListed((l) => toggled(l, p.at[0]))}>
                <Icon name={open ? "chevron-down" : "chevron-right"} size={12} className="loki-steps-chev" />
                {p.text}
              </button>
              {open && <ol className="loki-steps-list loki-steps-nested">{p.at.map(step)}</ol>}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

const toggled = (set: ReadonlySet<number>, k: number): ReadonlySet<number> => {
  const next = new Set(set);
  if (!next.delete(k)) next.add(k);
  return next;
};

/** The phone's: a bottom sheet of the stretch on a timeline; a step opens in the same sheet, Back returns to the list. */
function StepsSheet({ rows, title, start, onClose }: { rows: TranscriptRow[]; title: string; start: number | null; onClose: () => void }) {
  const [at, setAt] = useState<number | null>(start);
  const [listed, setListed] = useState<ReadonlySet<number>>(new Set());
  const step = at === null ? null : rows[at];
  const plan = workPlan(rows);
  return (
    <Sheet label={step ? stepName(step) : title} onClose={onClose} placement="bottom" className="loki-phone-sheet loki-steps-sheet">
      <div className="loki-steps-head">
        <span aria-hidden className="loki-steps-grip" />
        <div className="loki-steps-bar">
          {step ? (
            <button type="button" className="loki-steps-round" aria-label="Back to the steps" onClick={() => setAt(null)}>
              <Icon name="back" size={20} />
            </button>
          ) : (
            <button type="button" className="loki-steps-round" aria-label="Close" onClick={onClose}>
              <Icon name="close" size={20} />
            </button>
          )}
          <h2 className="loki-steps-title">{step ? (stepTarget(step) ?? stepName(step)) : title}</h2>
          <span aria-hidden className="loki-steps-round-spacer" />
        </div>
      </div>
      {step ? (
        <StepDetail row={step} />
      ) : (
        <ol className="loki-steps-timeline">
          {plan.flatMap((p) => {
            const step = (k: number) => (
              <li key={k}>
                <button type="button" className="loki-steps-step" onClick={() => setAt(k)}>
                  <StepLine row={rows[k]} size={20} />
                </button>
              </li>
            );
            if (p.kind === "step") return [step(p.at)];
            const open = listed.has(p.at[0]);
            return [
              <li key={`b${p.at[0]}`}>
                <button type="button" className="loki-steps-between" aria-expanded={open} onClick={() => setListed((l) => toggled(l, p.at[0]))}>
                  <Icon name={open ? "chevron-down" : "chevron-right"} size={14} className="loki-steps-chev" />
                  {p.text}
                </button>
              </li>,
              ...(open ? p.at.map(step) : []),
            ];
          })}
        </ol>
      )}
    </Sheet>
  );
}

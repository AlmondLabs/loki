import { createContext, memo, useContext, useEffect, useState } from "react";
import type { TranscriptRow, WholeRow } from "../../../core/attention/transcript.ts";
import { Button, Sheet } from "../components";
import { Icon } from "../shared/icons";
import {
  isNamedStep,
  withoutSkillCalls,
  lastFailure,
  stepFailed,
  stepIcon,
  stepKind,
  stepName,
  stepTarget,
  stepTitle,
  stepVerb,
  workSummary,
} from "../shared/tool-steps";

export const StepsTouch = createContext(false);

export const StepsLoad = createContext<((row: number) => Promise<WholeRow | null>) | null>(null);

const fetched = new WeakMap<TranscriptRow, WholeRow>();

const ownWhole = (row: TranscriptRow): WholeRow => ({ step: row.tool ?? null, detail: row.detail ?? null });

const fills = (row: TranscriptRow, whole: WholeRow | null): whole is WholeRow => (row.role === "event" ? !!whole?.detail : !!whole?.step);

export function useWhole(row: TranscriptRow): { whole: WholeRow | undefined; state: "ready" | "loading" | "failed"; retry: () => void } {
  const load = useContext(StepsLoad);
  const lean = row.tool?.row ?? row.row;
  const [got, setGot] = useState<{ row: TranscriptRow; whole: WholeRow | null } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const have = fetched.get(row) ?? (got?.row === row ? got.whole : undefined);
  useEffect(() => {
    if (lean === undefined || !load || fetched.has(row)) return;
    let live = true;
    void load(lean).then((whole) => {
      const filled = fills(row, whole) ? whole : null;
      if (filled) fetched.set(row, filled);
      if (live) setGot({ row, whole: filled });
    });
    return () => {
      live = false;
    };
  }, [row, lean, load, attempt]);
  if (lean === undefined || !load) return { whole: ownWhole(row), state: "ready", retry: () => {} };
  if (have) return { whole: have, state: "ready", retry: () => {} };
  return {
    whole: undefined,
    state: have === null ? "failed" : "loading",
    retry: () => {
      setGot(null);
      setAttempt((n) => n + 1);
    },
  };
}

function NotLoaded({ retry }: { retry: () => void }) {
  return (
    <p className="loki-steps-none">
      Could not load this step.{" "}
      <Button size="sm" onClick={retry}>
        Try Again
      </Button>
    </p>
  );
}

export const ToolSteps = memo(
  function ToolSteps({ rows: all, running, arrived }: { rows: TranscriptRow[]; running: boolean; arrived?: true }) {
    const rows = withoutSkillCalls(all);
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
        <button
          type="button"
          className="loki-steps-line"
          data-running={running || undefined}
          aria-expanded={open}
          onClick={() => (open ? setOpen(false) : show(null))}
        >
          <span className="loki-steps-label">{workSummary(rows, running)}</span>
          <Icon name={!touch && open ? "chevron-down" : "chevron-right"} size={14} className="loki-steps-chev" />
        </button>
        {failure !== null && (!open || touch) && (
          <button type="button" className="loki-steps-failure" onClick={() => show(failure)}>
            <Icon name="close" size={12} />
            <span className="loki-truncate">{stepTarget(rows[failure]) ?? stepName(rows[failure])}</span>
            <span>failed</span>
          </button>
        )}
        {open &&
          (touch ? (
            <StepsSheet rows={rows} title={workSummary(rows)} start={at} onClose={() => setOpen(false)} />
          ) : (
            <StepsList rows={rows} openAt={at} onOpen={setAt} />
          ))}
      </div>
    );
  },
  (a, b) => a.running === b.running && a.arrived === b.arrived && a.rows.length === b.rows.length && a.rows.every((r, i) => r === b.rows[i]),
);

function StepText({ row, verbFirst = false }: { row: TranscriptRow; verbFirst?: boolean }) {
  const target = stepTarget(row);
  const verb = stepVerb(stepName(row));
  const [first, second] = verbFirst || !target ? [verb, target] : [target, verb];
  return (
    <span className="loki-steps-text">
      <span className="loki-steps-verb loki-truncate">
        <span className="loki-truncate">{first}</span>
        {stepFailed(row) && <span className="loki-steps-failed">Failed</span>}
      </span>
      {second && <span className="loki-steps-target loki-truncate">{second}</span>}
    </span>
  );
}

export function StepDetail({ row }: { row: TranscriptRow }) {
  return row.role === "event" ? <EventResult row={row} /> : <ToolDetail row={row} />;
}

function EventResult({ row }: { row: TranscriptRow }) {
  const { whole, state, retry } = useWhole(row);
  if (state === "loading") return <p className="loki-steps-none">Loading this step…</p>;
  if (state === "failed") return <NotLoaded retry={retry} />;
  if (!whole?.detail && !row.command) return <p className="loki-steps-none">Nothing more was recorded for this step.</p>;
  return (
    <div className="loki-steps-detail">
      {row.command && (
        <section>
          <h3 className="loki-steps-heading">Command</h3>
          <pre className="loki-steps-code">{row.command}</pre>
        </section>
      )}
      {whole?.detail ? (
        <section>
          <h3 className="loki-steps-heading">{stepKind(row) === "skill" ? "Skill" : stepFailed(row) ? "Result · failed" : "Result"}</h3>
          <pre className="loki-steps-code" data-failed={stepFailed(row) || undefined}>
            {whole.detail}
          </pre>
        </section>
      ) : (
        <p className="loki-steps-none">Nothing more was recorded for this step.</p>
      )}
    </div>
  );
}

export function EventDetail({ row }: { row: TranscriptRow }) {
  const { whole, state, retry } = useWhole(row);
  if (state === "loading") return <p className="loki-steps-none">Loading…</p>;
  if (state === "failed") return <NotLoaded retry={retry} />;
  return whole?.detail ? <pre className="loki-event-detail">{whole.detail}</pre> : null;
}

function ToolDetail({ row }: { row: TranscriptRow }) {
  const { whole, state, retry } = useWhole(row);
  const t = whole?.step ?? undefined;
  const kind = stepKind(row);
  const inputHeading = kind === "agent" ? "Asked" : stepIcon(stepName(row)) === "terminal" ? "Command" : "Input";
  if (state === "loading") return <p className="loki-steps-none">Loading this step…</p>;
  if (state === "failed") return <NotLoaded retry={retry} />;
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
          <h3 className="loki-steps-heading">{inputHeading}</h3>
          <pre className="loki-steps-code">{t.input}</pre>
        </section>
      )}
      <section>
        <h3 className="loki-steps-heading">{t.failed ? "Output · failed" : "Output"}</h3>
        {t.output ? (
          <pre className="loki-steps-code" data-failed={t.failed || undefined}>
            {t.output}
          </pre>
        ) : (
          <p className="loki-steps-none">{t.failed ? "It failed without saying why." : "Nothing came back yet."}</p>
        )}
      </section>
    </div>
  );
}

type Filter = "all" | "failed" | "steps" | "housekeeping";
const FILTER_FROM = 8;
const CHIPS: ReadonlyArray<[Filter, string]> = [
  ["all", "All"],
  ["failed", "Failed"],
  ["steps", "Steps"],
  ["housekeeping", "Files and search"],
];
const KEEP: Record<Filter, (row: TranscriptRow) => boolean> = { all: () => true, failed: stepFailed, steps: isNamedStep, housekeeping: (r) => !isNamedStep(r) };

const shownSteps = (rows: TranscriptRow[], f: Filter): number[] => rows.flatMap((r, k) => (KEEP[f](r) ? [k] : []));

function Filters({ rows, value, onChange }: { rows: TranscriptRow[]; value: Filter; onChange: (f: Filter) => void }) {
  if (rows.length <= FILTER_FROM) return null;
  return (
    <div className="loki-steps-filters" role="group" aria-label="Show">
      {CHIPS.map(([f, label]) => {
        const n = rows.filter(KEEP[f]).length;
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

function StepLine({ row, size, verbFirst = false }: { row: TranscriptRow; size: number; verbFirst?: boolean }) {
  return (
    <>
      <Icon name={stepFailed(row) ? "close" : stepIcon(stepName(row))} size={size} className="loki-steps-icon" />
      <StepText row={row} verbFirst={verbFirst} />
    </>
  );
}

function StepsList({ rows, openAt, onOpen }: { rows: TranscriptRow[]; openAt: number | null; onOpen: (at: number | null) => void }) {
  const [filter, setFilter] = useState<Filter>(openAt !== null && stepFailed(rows[openAt]) && rows.length > FILTER_FROM ? "failed" : "all");
  return (
    <div className="loki-steps-open">
      <Filters rows={rows} value={filter} onChange={setFilter} />
      <ol className="loki-steps-list">
        {shownSteps(rows, filter).map((at) => (
          <li key={at}>
            <button
              type="button"
              className="loki-steps-step"
              data-minor={!isNamedStep(rows[at]) || undefined}
              aria-expanded={openAt === at}
              onClick={() => onOpen(openAt === at ? null : at)}
            >
              <StepLine row={rows[at]} size={16} />
            </button>
            {openAt === at && <StepDetail row={rows[at]} />}
          </li>
        ))}
      </ol>
    </div>
  );
}

function StepsSheet({ rows, title, start, onClose }: { rows: TranscriptRow[]; title: string; start: number | null; onClose: () => void }) {
  const [at, setAt] = useState<number | null>(start);
  const step = at === null ? null : rows[at];
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
          <h2 className="loki-steps-title">{step ? stepTitle(stepName(step)) : title}</h2>
        </div>
      </div>
      {step ? (
        <StepDetail row={step} />
      ) : (
        <ol className="loki-steps-timeline">
          {rows.map((row, k) => (
            <li key={k}>
              <button type="button" className="loki-steps-step" data-minor={!isNamedStep(row) || undefined} onClick={() => setAt(k)}>
                <StepLine row={row} size={20} verbFirst />
                <Icon name="chevron-right" size={18} className="loki-steps-open-chev" />
              </button>
            </li>
          ))}
        </ol>
      )}
    </Sheet>
  );
}

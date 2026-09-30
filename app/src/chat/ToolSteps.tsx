import { createContext, memo, useContext, useState } from "react";
import type { TranscriptRow } from "../../../core/attention/transcript.ts";
import { Sheet } from "../components";
import { Icon } from "../shared/icons";
import { stepIcon, stepName, stepTarget, stepVerb, stepsSummary } from "../shared/toolSteps";

/**
 * A run of tool calls in the thread, as one quiet line ("Ran 3 commands ›", "Running" while it works), the way
 * Claude's apps show them. On the phone the line opens a bottom sheet of the steps, each a verb and what it
 * was done to on a thin timeline, and a step opens its input and output in the same sheet, with a way back. On
 * the desktop the line unfolds the same steps in place, and each step unfolds its input and output.
 * The wording is shared/toolSteps.ts.
 */

/** The conversation is the phone's (Conversation's `touch`): steps open as a bottom sheet rather than in place. */
export const StepsTouch = createContext(false);

export const ToolSteps = memo(
  function ToolSteps({ rows, running, arrived }: { rows: TranscriptRow[]; running: boolean; arrived?: true }) {
    const touch = useContext(StepsTouch);
    const [open, setOpen] = useState(false);
    const summary = stepsSummary(rows, running);
    return (
      <div data-row="tool" data-arrived={arrived} className="loki-steps">
        <button type="button" className="loki-steps-line" data-running={running || undefined} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          <span className="loki-steps-label">{summary}</span>
          <Icon name={!touch && open ? "chevron-down" : "chevron-right"} size={14} className="loki-steps-chev" />
        </button>
        {open && (touch ? <StepsSheet rows={rows} title={stepsSummary(rows)} onClose={() => setOpen(false)} /> : <StepsList rows={rows} />)}
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
        {stepVerb(stepName(row))}
        {row.tool?.failed && <span className="loki-steps-failed">Failed</span>}
      </span>
      {target && <span className="loki-steps-target">{target}</span>}
    </span>
  );
}

/** A step's input and output, as they were recorded; older rows kept neither. */
function StepDetail({ row }: { row: TranscriptRow }) {
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

/** The desktop's: the steps in place under the line, each unfolding its input and output. */
function StepsList({ rows }: { rows: TranscriptRow[] }) {
  return (
    <ol className="loki-steps-list">
      {rows.map((row, i) => (
        <li key={i}>
          <details>
            <summary className="loki-steps-step">
              <Icon name={stepIcon(stepName(row))} size={16} className="loki-steps-icon" />
              <StepText row={row} />
            </summary>
            <StepDetail row={row} />
          </details>
        </li>
      ))}
    </ol>
  );
}

/** The phone's: a bottom sheet of the steps on a timeline; a step opens in the same sheet, Back returns to the list. */
function StepsSheet({ rows, title, onClose }: { rows: TranscriptRow[]; title: string; onClose: () => void }) {
  const [at, setAt] = useState<number | null>(null);
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
          <h2 className="loki-steps-title">{step ? stepName(step) : title}</h2>
          <span aria-hidden className="loki-steps-round-spacer" />
        </div>
      </div>
      {step ? (
        <StepDetail row={step} />
      ) : (
        <ol className="loki-steps-timeline">
          {rows.map((row, i) => (
            <li key={i}>
              <button type="button" className="loki-steps-step" onClick={() => setAt(i)}>
                <Icon name={stepIcon(stepName(row))} size={20} className="loki-steps-icon" />
                <StepText row={row} />
              </button>
            </li>
          ))}
        </ol>
      )}
    </Sheet>
  );
}

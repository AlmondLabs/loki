import { useEffect, useState } from "react";
import type { PendingQuestion } from "../attention/model";
import { btn } from "./ui";

/**
 * The agent asked (AskUserQuestion). Compact by design — the thread above is
 * the context you need to answer, so the card takes as little of it as it can:
 * one line per question with its options as pills, the chosen option's
 * description on one line beneath. A free-text line appears per question only
 * when there are several; with one question the host's message box is the
 * "in your own words" path.
 */
export function QuestionCard({ question, onAnswer }: { question: PendingQuestion; onAnswer: (answers: Record<string, string | string[]>) => void }) {
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const [peek, setPeek] = useState<string | null>(null); // hovered option label, for its description
  useEffect(() => {
    setPicked({});
    setOther({});
  }, [question.requestId]);

  const many = question.questions.length > 1;
  const answerFor = (q: PendingQuestion["questions"][number]): string | string[] | null => {
    const free = other[q.question]?.trim();
    const sel = picked[q.question] ?? [];
    if (q.multiSelect) {
      const all = [...sel, ...(free ? [free] : [])];
      return all.length ? all : null;
    }
    return free || sel[0] || null;
  };
  const complete = question.questions.length > 0 && question.questions.every((q) => answerFor(q) !== null);
  const submit = () => {
    if (!complete) return;
    const answers: Record<string, string | string[]> = {};
    for (const q of question.questions) answers[q.question] = answerFor(q)!;
    onAnswer(answers);
  };
  const toggle = (q: PendingQuestion["questions"][number], label: string) =>
    setPicked((p) => {
      const cur = p[q.question] ?? [];
      if (q.multiSelect) return { ...p, [q.question]: cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label] };
      return { ...p, [q.question]: cur[0] === label ? [] : [label] };
    });

  return (
    <div data-question style={{ padding: "8px 20px 10px", borderTop: "1px solid var(--loki-accent)", background: "var(--loki-brass-soft)", display: "grid", gap: 8, maxHeight: "38%", overflowY: "auto", flex: "0 0 auto" }}>
      {question.questions.map((q, qi) => {
        const sel = picked[q.question] ?? [];
        const shown = q.options.find((o) => o.label === peek) ?? q.options.find((o) => sel.includes(o.label));
        return (
          <div key={qi} style={{ display: "grid", gap: 6 }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
              <span className="loki-label" style={{ color: "var(--loki-accent)", fontSize: 9 }}>{qi === 0 ? (many ? `asks you · ${question.questions.length}` : "asks you") : `${qi + 1}`}</span>
              {q.header && <span className="loki-label" style={{ fontSize: 9 }}>{q.header}</span>}
              <span style={{ fontFamily: "var(--loki-display)", fontSize: 14, color: "var(--loki-fg)" }}>{q.question}</span>
            </div>
            <div role={q.multiSelect ? "group" : "radiogroup"} aria-label={q.question} style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }} onMouseLeave={() => setPeek(null)}>
              {q.options.map((o) => {
                const on = sel.includes(o.label);
                return (
                  <button
                    key={o.label}
                    role={q.multiSelect ? "checkbox" : "radio"}
                    aria-checked={on}
                    onClick={() => toggle(q, o.label)}
                    onMouseEnter={() => setPeek(o.label)}
                    onFocus={() => setPeek(o.label)}
                    style={{ ...btn(on ? "var(--loki-fg)" : "var(--loki-muted)"), padding: "4px 10px", fontSize: 12.5, borderRadius: 999, borderColor: on ? "var(--loki-accent)" : "var(--loki-border)", background: on ? "rgba(201,164,92,0.16)" : "transparent", gap: 6 }}
                  >
                    <span aria-hidden style={{ width: 8, height: 8, borderRadius: q.multiSelect ? 2 : 4, border: `1px solid ${on ? "var(--loki-accent)" : "var(--loki-muted)"}`, background: on ? "var(--loki-accent)" : "transparent" }} />
                    {o.label}
                  </button>
                );
              })}
              {many && (
                <input
                  value={other[q.question] ?? ""}
                  onChange={(e) => setOther((o) => ({ ...o, [q.question]: e.target.value }))}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      submit();
                    }
                    e.stopPropagation();
                  }}
                  placeholder="or your own…"
                  aria-label={`other answer: ${q.question}`}
                  autoComplete="off"
                  style={{ flex: "1 1 140px", minWidth: 120, padding: "4px 10px", fontSize: 12.5, background: "#101014", border: "1px solid var(--loki-border)", borderRadius: 999, color: "var(--loki-fg)", outline: "none", fontFamily: "var(--loki-font)" }}
                />
              )}
              {qi === question.questions.length - 1 && (
                <>
                  <span style={{ flex: 1 }} />
                  <button onClick={submit} disabled={!complete} style={{ ...btn("var(--loki-accent)"), padding: "4px 12px", fontSize: 12.5, opacity: complete ? 1 : 0.5 }} title={complete ? "send these answers" : many ? "answer every question" : "pick one, or type below"}>
                    answer
                  </button>
                </>
              )}
            </div>
            {q.options.some((o) => o.description) && (
              // Always one line tall, so hovering the pills never moves the thread above.
              <div style={{ fontSize: 11.5, color: "var(--loki-muted)", lineHeight: 1.4, marginLeft: 2, minHeight: "1.4em", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} aria-live="polite">
                {shown?.description ?? (sel.length ? "" : "hover an option for details")}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

import { useState } from "react";
import type { PendingQuestion } from "../../../core/attention/model.ts";
import { Button, Chip, Dot, Field } from "../components";

/**
 * The agent asked (AskUserQuestion). Compact by design — the thread above is
 * the context you need to answer, so the card takes as little of it as it can:
 * one line per question with its options as pills, the chosen option's
 * description on one line beneath. A free-text line appears per question only
 * when there are several; with one question the host's message box is the
 * "in your own words" path.
 */
export function QuestionCard(props: { question: PendingQuestion; onAnswer: (answers: Record<string, string | string[]>) => void; /** A touch screen: there is no hover, so the hint says tap. */ touch?: boolean }) {
  // A new request is a new card: picks and typed answers start empty with it.
  return <QuestionCardFor key={props.question.requestId} {...props} />;
}

function QuestionCardFor({ question, onAnswer, touch = false }: { question: PendingQuestion; onAnswer: (answers: Record<string, string | string[]>) => void; touch?: boolean }) {
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const [peek, setPeek] = useState<string | null>(null); // hovered option label, for its description

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
    <div data-question className="loki-question">
      {question.questions.map((q, qi) => {
        const sel = picked[q.question] ?? [];
        const shown = q.options.find((o) => o.label === peek) ?? q.options.find((o) => sel.includes(o.label));
        return (
          <div key={qi} style={{ display: "grid", gap: 6 }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
              <span className="loki-label loki-question-kicker">{qi === 0 ? (many ? `Asks you · ${question.questions.length}` : "Asks you") : `${qi + 1}`}</span>
              {q.header && <span className="loki-label">{q.header}</span>}
              <span className="loki-question-text">{q.question}</span>
            </div>
            <div role={q.multiSelect ? "group" : "radiogroup"} aria-label={q.question} style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }} onMouseLeave={() => setPeek(null)}>
              {q.options.map((o) => {
                const on = sel.includes(o.label);
                return (
                  <Chip key={o.label} role={q.multiSelect ? "checkbox" : "radio"} aria-checked={on} active={on} onClick={() => toggle(q, o.label)} onMouseEnter={() => setPeek(o.label)} onFocus={() => setPeek(o.label)}>
                    {q.multiSelect ? (
                      <span aria-hidden style={{ width: 8, height: 8, borderRadius: 1, border: `1px solid ${on ? "var(--loki-accent)" : "var(--loki-muted)"}`, background: on ? "var(--loki-accent)" : "transparent" }} />
                    ) : (
                      <Dot size={8} color={on ? "var(--loki-accent)" : "var(--loki-muted)"} ring={!on} aria-hidden />
                    )}
                    {o.label}
                  </Chip>
                );
              })}
              {many && (
                <Field
                  size="sm"
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
                  style={{ flex: "1 1 140px", minWidth: 120 }}
                />
              )}
              {qi === question.questions.length - 1 && (
                <>
                  <span style={{ flex: 1 }} />
                  <Button size="sm" tone="positive" className="loki-question-answer" onClick={submit} disabled={!complete} title={complete ? "send these answers" : many ? "answer every question" : "pick one, or type below"}>
                    answer
                  </Button>
                </>
              )}
            </div>
            {q.options.some((o) => o.description) && (
              // Always one line tall, so hovering the pills never moves the thread above.
              <div className="loki-meta" style={{ lineHeight: 1.4, marginLeft: 2, minHeight: "1.4em" }} aria-live="polite">
                {shown?.description ?? (sel.length ? "" : touch ? "tap an option for details" : "hover an option for details")}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

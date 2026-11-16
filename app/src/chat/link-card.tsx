import { useState } from "react";
import { LINK_DURATIONS, durationWords, linkAnswers, type LinkAsk, type LinkDirection, type LinkDuration } from "../../../core/chat-links.ts";
import { Button, Chip, Dot, sentence } from "../components";

const nameOf = (end: { title: string | null }) => end.title || "an untitled chat";

export function LinkCard(props: { requestId: string; ask: LinkAsk; onAnswer: (answers: Record<string, string>) => void; touch?: boolean }) {
  return <LinkCardFor key={props.requestId} {...props} />;
}

function LinkCardFor({ ask, onAnswer }: { ask: LinkAsk; onAnswer: (answers: Record<string, string>) => void }) {
  const [direction, setDirection] = useState<LinkDirection>("one_way");
  const [picked, setDuration] = useState<LinkDuration | null>(null);
  const duration = picked ?? ask.duration;
  const answer = (allow: boolean) => onAnswer(linkAnswers({ allow, direction, duration }));
  const to = `${nameOf(ask.to)}${ask.to.agent_name ? ` (${ask.to.agent_name}${ask.to.mac ? ` on ${ask.to.mac}` : ""})` : ""}`;
  const pick = <T extends string>(label: string, value: T, current: T, set: (v: T) => void, words: string) => (
    <Chip key={value} role="radio" aria-checked={value === current} active={value === current} onClick={() => set(value)} aria-label={`${label}: ${words}`}>
      <Dot size={8} color={value === current ? "var(--loki-accent)" : "var(--loki-muted)"} ring={value !== current} aria-hidden />
      {sentence(words)}
    </Chip>
  );
  return (
    <div data-link className="loki-question">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="loki-label loki-question-kicker">Wants to message another chat</span>
        <span className="loki-question-text">{to}</span>
      </div>
      <pre className="loki-approval-input">{ask.text}</pre>
      <div className="loki-link-choices">
        <div role="radiogroup" aria-label="Direction" className="loki-link-row">
          <span className="loki-label">Direction</span>
          {pick("direction", "one_way", direction, setDirection, "one way")}
          {pick("direction", "both_ways", direction, setDirection, "both ways")}
        </div>
        <div role="radiogroup" aria-label="For" className="loki-link-row">
          <span className="loki-label">For</span>
          {LINK_DURATIONS.map((d) => pick("for", d, duration, setDuration, durationWords(d)))}
        </div>
      </div>
      <div className="loki-link-row">
        <span className="flex-1" />
        <Button size="sm" onClick={() => answer(false)}>
          Deny
        </Button>
        <Button size="sm" tone="positive" className="loki-question-answer" onClick={() => answer(true)}>
          Allow
        </Button>
      </div>
    </div>
  );
}

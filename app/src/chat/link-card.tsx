import { useState } from "react";
import { LINK_DURATIONS, durationWords, linkAnswers, type LinkAsk, type LinkDirection, type LinkDuration } from "../../../core/chat-links.ts";
import { Button, Chip, Dot, sentence } from "../components";

/** The words of a control: lowercase on the desktop, sentence case on the phone. */
const say = (touch: boolean, words: string) => (touch ? sentence(words) : words);

/** A chat's name as the card says it. */
const nameOf = (end: { title: string | null }) => end.title || "an untitled chat";

/**
 * The link card (plan 067): an agent asks to message another chat that this chat has no link to. It shows both chats
 * and the message, and the person picks which way messages may go and for how long, then allows or denies. It sits
 * where a question card does, and is answered the same way, with the choices as its answers.
 */
export function LinkCard(props: { requestId: string; ask: LinkAsk; onAnswer: (answers: Record<string, string>) => void; touch?: boolean }) {
  // A new request is a new card: the choices start over with it.
  return <LinkCardFor key={props.requestId} {...props} />;
}

function LinkCardFor({ ask, onAnswer, touch = false }: { ask: LinkAsk; onAnswer: (answers: Record<string, string>) => void; touch?: boolean }) {
  const [direction, setDirection] = useState<LinkDirection>("one_way");
  const [duration, setDuration] = useState<LinkDuration>(ask.duration);
  const answer = (allow: boolean) => onAnswer(linkAnswers({ allow, direction, duration }));
  const to = `${nameOf(ask.to)}${ask.to.agent_name ? ` (${ask.to.agent_name}${ask.to.mac ? ` on ${ask.to.mac}` : ""})` : ""}`;
  const pick = <T extends string>(label: string, value: T, current: T, set: (v: T) => void, words: string) => (
    <Chip key={value} role="radio" aria-checked={value === current} active={value === current} onClick={() => set(value)} aria-label={`${label}: ${words}`}>
      <Dot size={8} color={value === current ? "var(--loki-accent)" : "var(--loki-muted)"} ring={value !== current} aria-hidden />
      {say(touch, words)}
    </Chip>
  );
  return (
    <div data-link className="loki-question">
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
        <span className="loki-label loki-question-kicker">{touch ? "Wants to message another chat" : "wants to message another chat"}</span>
        <span className="loki-question-text">{to}</span>
      </div>
      <pre className="loki-approval-input">{ask.text}</pre>
      <div className="loki-link-choices">
        <div role="radiogroup" aria-label="direction" className="loki-link-row">
          <span className="loki-label">{say(touch, "direction")}</span>
          {pick("direction", "one_way", direction, setDirection, "one way")}
          {pick("direction", "both_ways", direction, setDirection, "both ways")}
        </div>
        <div role="radiogroup" aria-label="for" className="loki-link-row">
          <span className="loki-label">{say(touch, "for")}</span>
          {LINK_DURATIONS.map((d) => pick("for", d, duration, setDuration, durationWords(d)))}
        </div>
      </div>
      <div className="loki-link-row">
        <span style={{ flex: 1 }} />
        <Button size="sm" onClick={() => answer(false)}>
          {say(touch, "deny")}
        </Button>
        <Button size="sm" tone="positive" className="loki-question-answer" onClick={() => answer(true)}>
          {say(touch, "allow")}
        </Button>
      </div>
    </div>
  );
}

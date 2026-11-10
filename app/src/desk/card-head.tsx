import type { ReactNode } from "react";
import type { OutsideReach } from "../../../core/frame-types.ts";
import { REACH_LABEL, REACH_LEVEL } from "../../../core/outside-reach.ts";
import { Chip, Dot } from "../components";
import { AgentFace } from "./agent-chip";

/**
 * An Inbox card's header (plan 073), the same shape on a Slack, mail, Jira or chat card: a face with a mark for where the
 * card came from, who on the first line, where or what and when on the second, and the tag and badge at the end.
 */
export function CardHead({
  face,
  who,
  whoHint,
  line,
  right,
}: {
  face: ReactNode;
  who: string;
  /** More on who, on hover: a mail sender's address. */
  whoHint?: string;
  /** The second line's parts, in order. */
  line: ReactNode;
  right?: ReactNode;
}) {
  return (
    <div className="loki-card-head">
      {face}
      <div className="loki-card-head-text">
        <div className="loki-card-head-who" title={whoHint ?? who}>
          {who}
        </div>
        <div className="loki-card-head-line">{line}</div>
      </div>
      {right && <div className="loki-card-head-right">{right}</div>}
    </div>
  );
}

/** Where an outside card came from, as the mark on its face: Slack, mail or Jira. A chat is loki's own and has none. */
export type CardMark = "slack" | "mail" | "jira";

/** The mark's glyph: plain signs, not the services' logos, which their brand terms keep for their own uses. */
const MARK_GLYPH: Record<CardMark, string> = { slack: "#", mail: "✉", jira: "◆" };
const MARK_CLASS: Record<CardMark, string> = {
  slack: "loki-card-mark loki-card-mark--slack",
  mail: "loki-card-mark loki-card-mark--mail",
  jira: "loki-card-mark loki-card-mark--jira",
};
const MARK_LABEL: Record<CardMark, string> = { slack: "from Slack", mail: "from mail", jira: "from Jira" };

/** A sender's or agent's face, 36 across, with the mark of where the card came from in its corner. */
export function CardFace({ name, src, mark }: { name: string; src: string | null; mark?: CardMark }) {
  return (
    <span className="loki-card-face">
      <AgentFace name={name} src={src} size={36} />
      {mark && (
        <span className={MARK_CLASS[mark]} aria-label={MARK_LABEL[mark]}>
          {MARK_GLYPH[mark]}
        </span>
      )}
    </span>
  );
}

/**
 * How directly a card is meant for the person, as a tag: the top of the scale with the attention dot, the middle plain,
 * the bottom muted, so the cards that need the person stand out and the rest step back.
 */
export function ReachTag({ reach }: { reach: OutsideReach }) {
  const level = REACH_LEVEL[reach];
  const label = REACH_LABEL[reach];
  if (level === 1)
    return (
      <Chip static className="loki-reach loki-reach--direct">
        <Dot color="var(--loki-attention)" />
        {label}
      </Chip>
    );
  return (
    <Chip static className={level >= 5 ? "loki-reach loki-reach--quiet" : "loki-reach"}>
      {label}
    </Chip>
  );
}

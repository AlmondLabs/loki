import { AgentFace } from "./agent-chip";

/** Where an outside card came from, as the mark on its face: Slack, mail or Jira. A chat is loki's own and has none. */
export type CardMark = "slack" | "mail" | "jira";

/** The mark's glyph: plain signs, not the services' logos, which their brand terms keep for their own uses. */
const MARK_GLYPH: Record<CardMark, string> = { slack: "#", mail: "✉", jira: "◆" };
const MARK_CLASS: Record<CardMark, string> = {
  slack: "loki-card-mark loki-card-mark--slack",
  mail: "loki-card-mark loki-card-mark--mail",
  jira: "loki-card-mark loki-card-mark--jira",
};
const MARK_LABEL: Record<CardMark, string> = { slack: "From Slack", mail: "From mail", jira: "From Jira" };

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

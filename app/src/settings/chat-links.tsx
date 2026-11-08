import { useEffect, useEffectEvent, useState } from "react";
import { LINK_DURATIONS, durationWords, timeLeft, type ChatLink, type LinkDuration } from "../../../core/chat-links.ts";
import { Button } from "../components";
import { Segmented, Setting } from "./layout";

/** What Preferences › Chat › Chat links reads and changes (useAttention's `links`, plan 067). */
export interface ChatLinksApi {
  list: () => Promise<{ links: ChatLink[]; default_duration: LinkDuration } | string>;
  close: (rt: { agent_id: string; conversation_id: string }, linkId: string) => Promise<string | null>;
  setDefault: (duration: LinkDuration) => Promise<{ links: ChatLink[]; default_duration: LinkDuration } | string>;
}

const DURATION_LABELS = Object.fromEntries(LINK_DURATIONS.map((d) => [d, durationWords(d)])) as Record<LinkDuration, string>;

/**
 * Preferences › Chat › Chat links (plan 067): the duration the link card starts on, and every live link of this Mac's
 * chats with which way it goes and how long it has left, each with close.
 */
export function ChatLinks({ api }: { api: ChatLinksApi }) {
  const [view, setView] = useState<{ links: ChatLink[]; default_duration: LinkDuration } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const apply = (r: { links: ChatLink[]; default_duration: LinkDuration } | string) => (typeof r === "string" ? setError(r) : (setError(null), setView(r)));
  const reload = () => void api.list().then(apply);
  const load = useEffectEvent(reload);
  useEffect(() => load(), []);
  if (view === null) return <Setting label="Links" help={error ?? "asking loki…"} />;
  const now = new Date();
  const close = async (l: ChatLink) => {
    // Either chat's Mac closes it on both; the first that answers does, so a paired Mac out of reach does not stop it.
    const err = (await api.close(l.to, l.id)) && (await api.close(l.from, l.id));
    if (err) setError(err);
    else reload();
  };
  return (
    <>
      <Setting label="Allow for" help="What the card starts on when an agent asks to message another chat.">
        <Segmented
          label="allow for"
          options={LINK_DURATIONS}
          value={view.default_duration}
          onPick={(d) => void api.setDefault(d).then(apply)}
          labels={DURATION_LABELS}
        />
      </Setting>
      {view.links.length === 0 && <Setting label="None open" help="An agent asks on a card the first time it messages another chat." />}
      {view.links.map((l) => (
        <Setting
          key={l.id}
          label={`${l.from.title || "untitled chat"} ${l.direction === "both_ways" ? "⇄" : "→"} ${l.to.title || "untitled chat"}`}
          help={`${l.direction === "both_ways" ? "both ways" : "one way"}, ${timeLeft(l, now)}`}
        >
          <Button size="sm" onClick={() => void close(l)}>
            close
          </Button>
        </Setting>
      ))}
      {error && <div className="loki-meta loki-meta--negative loki-meta--wrap">{error}</div>}
    </>
  );
}

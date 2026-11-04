import { useEffect, useState } from "react";
import { timeLeft, type LinkSeen } from "../../../core/chat-links.ts";
import { Chip, IconButton, sentence } from "../components";

/** How often the time left is read again: it is shown in minutes. */
const TICK_MS = 30_000;

/** Which way messages go along a link, from this chat. */
const ARROW: Record<LinkSeen["way"], string> = { out: "→", in: "←", both: "⇄" };
/** The same in words, for a screen reader and the chip's title. */
const WAY_WORDS: Record<LinkSeen["way"], string> = { out: "this chat may message", in: "may message this chat,", both: "linked both ways with" };

/**
 * A chat's live links (plan 067), in its header: the other chat's name with an arrow for the way messages go and the
 * time left, and a button that closes the link at once, on both chats' Macs.
 */
export function LinkHeader({ links, onClose, touch = false }: { links: LinkSeen[]; onClose?: (linkId: string) => void; touch?: boolean }) {
  // The time left is read from the clock, which moves without anything else changing.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!links.some((l) => l.expires_at !== null)) return;
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [links]);
  const live = links.filter((l) => l.expires_at === null || Date.parse(l.expires_at) > now);
  if (!live.length) return null;
  return (
    <div className="loki-chat-links" aria-label={touch ? "Links to other chats" : "links to other chats"}>
      {live.map((l) => {
        const name = l.other.title || "untitled chat";
        const words = l.way === "in" ? `${name} ${WAY_WORDS.in} ${timeLeft(l, new Date(now))}` : `${WAY_WORDS[l.way]} ${name}, ${timeLeft(l, new Date(now))}`;
        return (
          <Chip key={l.id} static title={words} aria-label={words}>
            <span aria-hidden>{ARROW[l.way]}</span>
            <span className="loki-chat-link-name">{name}</span>
            <span className="loki-meta">{timeLeft(l, new Date(now))}</span>
            {onClose && (
              <IconButton size={24} label={touch ? sentence(`close link to ${name}`) : `close link to ${name}`} onClick={() => onClose(l.id)}>
                ×
              </IconButton>
            )}
          </Chip>
        );
      })}
    </div>
  );
}

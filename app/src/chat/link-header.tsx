import { useEffect, useRef, useState } from "react";
import { timeLeft, type LinkSeen } from "../../../core/chat-links.ts";
import { Chip, IconButton, Popover } from "../components";
import { ArrowRightIcon, ArrowLeftIcon, ArrowLeftRightIcon, XIcon, type LucideIcon } from "lucide-react";
import { Glyph } from "../shared/icons";

/** How often the time left is read again: it is shown in minutes. */
const TICK_MS = 30_000;

/** Which way messages go along a link, from this chat, as Lucide's arrows. */
const ARROW_ICON: Record<LinkSeen["way"], LucideIcon> = { out: ArrowRightIcon, in: ArrowLeftIcon, both: ArrowLeftRightIcon };
/** The same in words, for a screen reader and the chip's title. */
const WAY_WORDS: Record<LinkSeen["way"], string> = { out: "this chat may message", in: "may message this chat,", both: "linked both ways with" };

/** A link in words, for a screen reader and a title: "linked both ways with infra, 2 h left". */
function linkWords(l: LinkSeen, now: number): string {
  const name = l.other.title || "Untitled chat";
  const left = timeLeft(l, new Date(now));
  return l.way === "in" ? `${name} ${WAY_WORDS.in} ${left}` : `${WAY_WORDS[l.way]} ${name}, ${left}`;
}

/** One link as the header names it: the other chat, the way, the time left, and its close button. */
function LinkLine({ link: l, now, onClose }: { link: LinkSeen; now: number; onClose?: (linkId: string) => void }) {
  const name = l.other.title || "Untitled chat";
  return (
    <>
      <span aria-hidden>
        <Glyph icon={ARROW_ICON[l.way]} inline />
      </span>
      <span className="loki-chat-link-name" title={linkWords(l, now)}>
        {name}
      </span>
      <span className="loki-meta">{timeLeft(l, new Date(now))}</span>
      {onClose && (
        <IconButton size={24} label={`Close link to ${name}`} onClick={() => onClose(l.id)}>
          <Glyph icon={XIcon} />
        </IconButton>
      )}
    </>
  );
}

/**
 * A chat's live links (plan 067), in its header. One link is a chip of its own: the other chat's name with an arrow
 * for the way messages go, the time left, and a button that closes the link at once, on both chats' Macs. Several
 * fold into one chip that says how many, and a click on it lists them, so the header stays one line however many
 * chats this one is linked to.
 */
export function LinkHeader({ links, onClose, touch = false }: { links: LinkSeen[]; onClose?: (linkId: string) => void; touch?: boolean }) {
  // The time left is read from the clock, which moves without anything else changing.
  const [now, setNow] = useState(() => Date.now());
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!links.some((l) => l.expires_at !== null)) return;
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [links]);
  // A press outside the list, or Esc, closes it; the chip toggles it itself.
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!anchor.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    // Capture phase: panes and popovers stop pointerdown from bubbling, and a press there must still close it.
    window.addEventListener("pointerdown", away, true);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("pointerdown", away, true);
      window.removeEventListener("keydown", esc);
    };
  }, [open]);
  const live = links.filter((l) => l.expires_at === null || Date.parse(l.expires_at) > now);
  if (!live.length) return null;
  const label = "Links to other chats";
  if (live.length === 1)
    return (
      <div className="loki-chat-links" aria-label={label}>
        <Chip static touch={touch} title={linkWords(live[0], now)} aria-label={linkWords(live[0], now)}>
          <LinkLine link={live[0]} now={now} onClose={onClose} />
        </Chip>
      </div>
    );
  const count = `${String(live.length)} links`;
  return (
    <span ref={anchor} className="loki-chat-links loki-chat-links--folded">
      <Chip touch={touch} aria-haspopup="dialog" aria-expanded={open} title={label} onClick={() => setOpen((v) => !v)}>
        <span aria-hidden>⇄</span>
        {count}
      </Chip>
      {open && (
        <Popover role="dialog" aria-label={label} anchor="right" width={touch ? 300 : 320} style={{ right: 0, maxWidth: "none", padding: 4 }}>
          <ul className="loki-chat-link-list">
            {live.map((l) => (
              <li key={l.id} className="loki-chat-link-row" aria-label={linkWords(l, now)}>
                <LinkLine link={l} now={now} onClose={onClose} />
              </li>
            ))}
          </ul>
        </Popover>
      )}
    </span>
  );
}

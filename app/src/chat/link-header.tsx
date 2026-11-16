import { useEffect, useState } from "react";
import { timeLeft, type LinkSeen } from "../../../core/chat-links.ts";
import { Chip, IconButton, Popover } from "../components";
import { ArrowRightIcon, ArrowLeftIcon, ArrowLeftRightIcon, XIcon, type LucideIcon } from "lucide-react";
import { Glyph } from "../shared/icons";

const TICK_MS = 30_000;

const ARROW_ICON: Record<LinkSeen["way"], LucideIcon> = { out: ArrowRightIcon, in: ArrowLeftIcon, both: ArrowLeftRightIcon };
const WAY_WORDS: Record<LinkSeen["way"], string> = { out: "this chat may message", in: "may message this chat,", both: "linked both ways with" };

function linkWords(l: LinkSeen, now: number): string {
  const name = l.other.title || "Untitled chat";
  const left = timeLeft(l, new Date(now));
  return l.way === "in" ? `${name} ${WAY_WORDS.in} ${left}` : `${WAY_WORDS[l.way]} ${name}, ${left}`;
}

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

export function LinkHeader({ links, onClose, touch = false }: { links: LinkSeen[]; onClose?: (linkId: string) => void; touch?: boolean }) {
  const [now, setNow] = useState(() => Date.now());
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!links.some((l) => l.expires_at !== null)) return;
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [links]);
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
    <span className="loki-chat-links loki-chat-links--folded">
      <Popover
        trigger={
          <Chip touch={touch} title={label}>
            <span aria-hidden>⇄</span>
            {count}
          </Chip>
        }
        open={open}
        onOpenChange={setOpen}
        touch={touch}
        role="dialog"
        aria-label={label}
        anchor="right"
        width={touch ? 300 : 320}
        style={{ maxWidth: "none", padding: 4, ...(touch ? { right: 0 } : {}) }}
      >
        <ul className="loki-chat-link-list">
          {live.map((l) => (
            <li key={l.id} className="loki-chat-link-row" aria-label={linkWords(l, now)}>
              <LinkLine link={l} now={now} onClose={onClose} />
            </li>
          ))}
        </ul>
      </Popover>
    </span>
  );
}

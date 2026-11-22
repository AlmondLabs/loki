import { useEffect, useEffectEvent, useState, type KeyboardEvent } from "react";
import type { EmojiChoice, SlackReaction } from "../../../core/frame-types.ts";

export const QUICK_EMOJI: readonly EmojiChoice[] = [
  { name: "eyes", emoji: { kind: "emoji", text: "👀" } },
  { name: "white_check_mark", emoji: { kind: "emoji", text: "✅" } },
  { name: "+1", emoji: { kind: "emoji", text: "👍" } },
  { name: "pray", emoji: { kind: "emoji", text: "🙏" } },
  { name: "raised_hands", emoji: { kind: "emoji", text: "🙌" } },
];

const QUICK_COUNT = 5;

export function quickChoices(used: readonly EmojiChoice[]): EmojiChoice[] {
  const names = new Set(used.map((c) => c.name));
  return [...used, ...QUICK_EMOJI.filter((c) => !names.has(c.name))].slice(0, QUICK_COUNT);
}

export type EmojiSearch = (query: string) => Promise<EmojiChoice[] | string>;

export function useQuickEmoji(accountId: string | null, search: EmojiSearch | null): EmojiChoice[] {
  const [found, setFound] = useState<{ accountId: string; used: EmojiChoice[] } | null>(null);
  const ask = useEffectEvent(() => search?.("") ?? Promise.resolve([]));
  const asks = !!search;
  useEffect(() => {
    if (!accountId || !asks) return;
    let live = true;
    void ask()
      .catch(() => [])
      .then((used) => {
        if (live) setFound({ accountId, used: typeof used === "string" ? [] : used });
      });
    return () => {
      live = false;
    };
  }, [accountId, asks]);
  return quickChoices(found?.accountId === accountId ? found.used : []);
}

const drawn = (emoji: EmojiChoice["emoji"]) => emoji.image ?? emoji.text.replaceAll("\uFE0F", "");

function sameReaction(r: SlackReaction, choice: EmojiChoice): boolean {
  return r.emoji !== null && drawn(r.emoji) === drawn(choice.emoji);
}

const pillFor = (reactions: readonly SlackReaction[], choice: EmojiChoice): SlackReaction | undefined =>
  reactions.find((r) => r.name === choice.name) ?? reactions.find((r) => sameReaction(r, choice));

export function pickReaction(reactions: readonly SlackReaction[], choice: EmojiChoice): { choice: EmojiChoice; on: boolean } {
  const had = pillFor(reactions, choice);
  return had ? { choice: { name: had.name, emoji: had.emoji ?? choice.emoji }, on: !had.mine } : { choice, on: true };
}

export function toggleReaction(reactions: readonly SlackReaction[], choice: EmojiChoice, on: boolean): SlackReaction[] {
  const had = pillFor(reactions, choice);
  if (!had) return on ? [...reactions, { name: choice.name, count: 1, mine: true, emoji: choice.emoji }] : [...reactions];
  if (had.mine === on) return [...reactions];
  const count = had.count + (on ? 1 : -1);
  return count > 0 ? reactions.map((r) => (r === had ? { ...r, count, mine: on } : r)) : reactions.filter((r) => r !== had);
}

export function Emoji({ emoji, name }: { emoji: EmojiChoice["emoji"] | null; name: string }) {
  if (!emoji) return <span>:{name}:</span>;
  return emoji.image ? <img className="loki-emoji" src={emoji.image} alt={`:${name}:`} /> : <span>{emoji.text}</span>;
}

export function Reactions({ reactions, onToggle }: { reactions: readonly SlackReaction[]; onToggle?: (r: SlackReaction) => void }) {
  if (reactions.length === 0) return null;
  return (
    <div className="loki-slack-reactions">
      {reactions.map((r) => (
        <button
          key={r.name}
          type="button"
          className="loki-slack-reaction"
          data-mine={r.mine ? "true" : undefined}
          disabled={!onToggle}
          title={`:${r.name}:`}
          aria-pressed={r.mine}
          onClick={() => onToggle?.(r)}
        >
          <Emoji emoji={r.emoji} name={r.name} />
          <span>{r.count}</span>
        </button>
      ))}
    </div>
  );
}

const SEARCH_WAIT_MS = 150;

export function emojiNote(shown: readonly EmojiChoice[] | string | null): string | null {
  if (shown === null) return "Searching…";
  if (typeof shown === "string") return `Couldn't search emoji: ${shown}`;
  return shown.length === 0 ? "No emoji by that name" : null;
}

export function EmojiPicker({
  search,
  quick = QUICK_EMOJI,
  onPick,
  onClose,
}: {
  search: EmojiSearch | null;
  quick?: readonly EmojiChoice[];
  onPick: (choice: EmojiChoice) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<{ query: string; emoji: EmojiChoice[] | string }>({ query: "", emoji: [] });
  const ask = useEffectEvent((q: string) => search?.(q) ?? Promise.resolve([]));
  useEffect(() => {
    const q = query.trim();
    if (!q) return;
    let live = true;
    const timer = setTimeout(() => {
      void ask(q).then((emoji) => {
        if (live) setFound({ query: q, emoji });
      });
    }, SEARCH_WAIT_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [query]);
  const q = query.trim();
  const shown = q ? (found.query === q ? found.emoji : null) : quick;
  const choices = typeof shown === "string" ? null : shown;
  const note = emojiNote(shown);
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation();
    if (e.key === "Escape") onClose();
    else if (e.key === "Enter" && choices?.[0]) onPick(choices[0]);
    else if (!q && /^[1-5]$/.test(e.key) && quick[Number(e.key) - 1]) {
      e.preventDefault();
      onPick(quick[Number(e.key) - 1]);
    }
  };
  return (
    <div
      className="loki-emoji-picker"
      role="dialog"
      aria-label="React with an emoji"
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) onClose();
      }}
    >
      <input
        className="loki-emoji-search"
        autoFocus
        value={query}
        placeholder={search ? "Search emoji" : "Pick one"}
        readOnly={!search}
        aria-label="Search emoji"
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onKey}
      />
      <div className="loki-emoji-choices">
        {note && <span className="loki-emoji-note">{note}</span>}
        {choices?.map((c, i) => (
          <button key={c.name} type="button" className="loki-emoji-choice" title={`:${c.name}:`} onClick={() => onPick(c)}>
            <Emoji emoji={c.emoji} name={c.name} />
            {!q && <kbd>{i + 1}</kbd>}
          </button>
        ))}
      </div>
    </div>
  );
}

import { useEffect, useEffectEvent, useState, type KeyboardEvent } from "react";
import type { EmojiChoice, SlackReaction } from "../../../core/frame-types.ts";

/**
 * Emoji reactions on a Slack card's messages (plan 079): the pills under a message, as Slack draws them, and the picker
 * that adds one, with five quick choices and a search that reaches every emoji, the workspace's own included. A
 * reaction is the person's own move in Slack; it moves nothing on the card.
 */

/**
 * The quick choices when Slack keeps no most-used emoji for the person (or a Mac on an older loki cannot say), each on
 * a number key while the search is empty: seen it, done, agreed, thanks, well done.
 */
export const QUICK_EMOJI: readonly EmojiChoice[] = [
  { name: "eyes", emoji: { kind: "emoji", text: "👀" } },
  { name: "white_check_mark", emoji: { kind: "emoji", text: "✅" } },
  { name: "+1", emoji: { kind: "emoji", text: "👍" } },
  { name: "pray", emoji: { kind: "emoji", text: "🙏" } },
  { name: "raised_hands", emoji: { kind: "emoji", text: "🙌" } },
];

/** How many quick reactions a card offers: the first three on a message's hover bar, all five on the picker's keys. */
const QUICK_COUNT = 5;

/** The person's most used emoji, filled up to five from QUICK_EMOJI with those not among them (plan 084). */
export function quickChoices(used: readonly EmojiChoice[]): EmojiChoice[] {
  const names = new Set(used.map((c) => c.name));
  return [...used, ...QUICK_EMOJI.filter((c) => !names.has(c.name))].slice(0, QUICK_COUNT);
}

/**
 * The quick reactions for a Slack card's account (plan 084): what the person uses most in Slack, as its hover bar
 * shows them, asked of the account's Mac once per account while the Inbox shows its cards, and QUICK_EMOJI until then.
 */
export function useQuickEmoji(accountId: string | null, search: ((query: string) => Promise<EmojiChoice[]>) | null): EmojiChoice[] {
  const [found, setFound] = useState<{ accountId: string; used: EmojiChoice[] } | null>(null);
  // The card makes its search afresh on each render; only another account asks again.
  const ask = useEffectEvent(() => search?.("") ?? Promise.resolve([]));
  const asks = !!search;
  useEffect(() => {
    if (!accountId || !asks) return;
    let live = true;
    void ask()
      .catch(() => [])
      .then((used) => {
        if (live) setFound({ accountId, used });
      });
    return () => {
      live = false;
    };
  }, [accountId, asks]);
  return quickChoices(found?.accountId === accountId ? found.used : []);
}

/**
 * A message's reactions after the person adds `choice` (`on`) or takes theirs back: the count moves by one and the pill
 * is theirs or not; a pill no one is left on goes. Reacting with what is already theirs, or taking back what is not,
 * changes nothing, as in Slack.
 */
export function toggleReaction(reactions: readonly SlackReaction[], choice: EmojiChoice, on: boolean): SlackReaction[] {
  const had = reactions.find((r) => r.name === choice.name);
  if (!had) return on ? [...reactions, { name: choice.name, count: 1, mine: true, emoji: choice.emoji }] : [...reactions];
  if (had.mine === on) return [...reactions];
  const count = had.count + (on ? 1 : -1);
  return count > 0 ? reactions.map((r) => (r === had ? { ...r, count, mine: on } : r)) : reactions.filter((r) => r !== had);
}

/** An emoji as Slack draws it: the character, or the workspace's own image at the height of a line. */
export function Emoji({ emoji, name }: { emoji: EmojiChoice["emoji"] | null; name: string }) {
  if (!emoji) return <span>:{name}:</span>;
  return emoji.image ? <img className="loki-emoji" src={emoji.image} alt={`:${name}:`} /> : <span>{emoji.text}</span>;
}

/** The pills under a message: each emoji and how many reacted with it, the person's own outlined; pressing one toggles theirs. */
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

/** How long the search waits after a key before asking, so a word typed fast asks once. */
const SEARCH_WAIT_MS = 150;

/**
 * The picker under a message: the quick choices on 1 to 5 (the person's most used, plan 084), and a search box that asks the account's Mac for every
 * emoji whose name holds what is typed; ↵ takes the first match, esc closes. It is a dialog, so esc closes it and not
 * the Inbox under it.
 */
export function EmojiPicker({
  search,
  quick = QUICK_EMOJI,
  onPick,
  onClose,
}: {
  search: ((query: string) => Promise<EmojiChoice[]>) | null;
  /** The quick choices on 1 to 5 (plan 084): the person's most used. */
  quick?: readonly EmojiChoice[];
  onPick: (choice: EmojiChoice) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<{ query: string; emoji: EmojiChoice[] }>({ query: "", emoji: [] });
  // The card makes its search afresh on each render; only what is typed asks again.
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
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation();
    if (e.key === "Escape") onClose();
    else if (e.key === "Enter" && shown?.[0]) onPick(shown[0]);
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
        placeholder={search ? "search emoji" : "pick one"}
        readOnly={!search}
        aria-label="Search emoji"
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onKey}
      />
      <div className="loki-emoji-choices">
        {shown === null && <span className="loki-emoji-note">Searching…</span>}
        {shown?.length === 0 && <span className="loki-emoji-note">No emoji by that name</span>}
        {shown?.map((c, i) => (
          <button key={c.name} type="button" className="loki-emoji-choice" title={`:${c.name}:`} onClick={() => onPick(c)}>
            <Emoji emoji={c.emoji} name={c.name} />
            {!q && <kbd>{i + 1}</kbd>}
          </button>
        ))}
      </div>
    </div>
  );
}

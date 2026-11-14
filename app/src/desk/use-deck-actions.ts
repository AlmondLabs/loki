import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import type { AttentionItem } from "../../../core/attention/model.ts";
import type { ResolvedLane } from "../../../core/attention/lanes.ts";
import type { MailAddressing } from "../../../core/frame-types.ts";
import { idOf, type Decision } from "../../../core/attention/queue.ts";
import { outsideReplies } from "../shared/outside-replies";
import { EMPTY_REPLY, createDeckMoves, type DeckMoveApi, type OpenedThread, type PickerKind, type ReplyBox } from "./deck-moves";
import { freshSeeds, mendLabel, withSeeds } from "./outside-words";
import { notify } from "../components";

/** How long a word stays on the badge. */
export const FLASH_MS = 900;

/**
 * The badge's word (`set`), shown for FLASH_MS and then cleared. A newer word cancels the older word's clear, so a
 * move and its rollback a moment later ("read", then "not read: why") leave the reason up for its full time. `stop`
 * cancels the pending clear, for when the deck goes.
 */
export function createFlash(set: (word: string | null) => void, ms = FLASH_MS): { say: (word: string) => void; stop: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    say(word) {
      clearTimeout(timer);
      set(word);
      timer = setTimeout(() => {
        timer = undefined;
        set(null);
      }, ms);
    },
    stop() {
      clearTimeout(timer);
      timer = undefined;
    },
  };
}

/**
 * What moves a card, and the small state those moves leave behind: the flash on the badge
 * ("read", "later", "archived", "labelled", "approved", "sent"), the count of replies this visit, which way the last
 * move went so the next card enters from that side, the picker open on the card, and an outside card's reply box,
 * which the deck holds so its keys can send it (KTD9). The moves themselves are `createDeckMoves`, the same on every
 * card: read (⌘]) marks it read and it rests, later (⌘[) keeps it unread and brings it back, archive (⌘E) is done. The
 * queue and the decisions are the deck's (useDeckQueue); this hook only writes to them. Every move pops the head and
 * re-orders the rest by score at that moment (popHead), the way a scheduler picks its next process when one leaves
 * the CPU. A Jira comment the person approved for the agent goes into the box of its card once, when the card is on top,
 * after whatever is typed there, and waits for them to send it (plan 2026-11-10-1451, KTD18).
 */
export function useDeckActions({
  current,
  decided,
  setDecided,
  setQueue,
  moves,
  lane = null,
  onSignIn,
}: {
  current: AttentionItem | undefined;
  decided: Decision[];
  setDecided: Dispatch<SetStateAction<Decision[]>>;
  setQueue: Dispatch<SetStateAction<AttentionItem[]>>;
  moves: DeckMoveApi;
  /** The lane Flow is in, null for Everything: undo takes back the last decision on a card it holds (KTD6). */
  lane?: ResolvedLane | null;
  /** Open where a disconnected account is mended (Preferences › Accounts); a refusal's notice offers it. */
  onSignIn?: () => void;
}) {
  const [flash, setFlash] = useState<string | null>(null);
  /** Replies and answers sent this visit. A reply on a chat keeps you on the card; the deck's keys move it. */
  const [replies, setReplies] = useState(0);
  /** Which way the last move went; the next card enters from that side. */
  const [dir, setDir] = useState<"next" | "back">("next");
  /** The picker open, and on which card; another card on top closes it. */
  const [picking, setPicking] = useState<{ id: string; kind: PickerKind } | null>(null);
  /**
   * The reply box of one outside card, and the approved comments it took in by proposal id; another card on top starts
   * with an empty one, but for the words the person left unsent in that card's box, which are kept for the session
   * (plan 087, KTD7) so a lane switch does not lose them, and the comments still waiting on that card, taken in again
   * unless the kept words already hold them.
   */
  const [box, setBox] = useState<{ id: string; seeded: readonly string[] } & ReplyBox>({ id: "", seeded: [], ...EMPTY_REPLY });

  const currentId = current ? idOf(current) : "";
  const own = box.id === currentId ? box : { id: currentId, seeded: [], ...EMPTY_REPLY, text: outsideReplies.get(currentId) };
  const fresh = currentId ? freshSeeds(current?.outside?.seeds, own.seeded) : [];
  if (fresh.length > 0) {
    // Taken in as the deck renders, the way React adjusts state to new props: no effect copies them in a frame later.
    // The kept words learn them once the person edits the box, so nothing outside React changes during render.
    const missing = fresh.filter((s) => !own.text.includes(s.text));
    setBox({ ...own, text: withSeeds(own.text, missing), seeded: [...own.seeded, ...fresh.map((s) => s.id)] });
  }
  const reply: ReplyBox = box.id === currentId ? box : { ...EMPTY_REPLY, text: outsideReplies.get(currentId) };
  const picker = picking?.id === currentId ? picking.kind : null;

  // One flash for the deck's life, made once from the stable setter, and its pending clear cancelled when the deck goes.
  const [flasher] = useState(() => createFlash(setFlash));
  useEffect(() => () => flasher.stop(), [flasher]);
  const say = flasher.say;
  const setReply = (id: string, patch: Partial<ReplyBox>) => {
    if (patch.text !== undefined) outsideReplies.set(id, patch.text);
    setBox((b) => ({ ...(b.id === id ? b : { id, seeded: [], ...EMPTY_REPLY, text: outsideReplies.get(id) }), ...patch }));
  };
  const deck = createDeckMoves({
    current,
    decided,
    lane,
    reply,
    setReply,
    setDecided,
    setQueue,
    say,
    notice: (item, words) => {
      const cause = item.outside?.disconnected;
      const mend = cause && item.outside && onSignIn ? mendLabel(cause, item.outside.provider) : null;
      notify(words, mend && onSignIn ? { action: { label: mend, onClick: onSignIn } } : undefined);
    },
    setDir,
    pick: (kind) => setPicking(kind && currentId ? { id: currentId, kind } : null),
    sent: () => setReplies((n) => n + 1),
    moves,
  });
  /**
   * A reply or an answer went out on a chat: the card stays — you may want to watch the answer arrive, and a
   * follow-up typed while it streams in lands while the conversation's prompt is still cached. Moving on
   * is yours (⌘]); if you do, the answer brings the card back by score, new and in focus, behind whatever
   * you are reading then. Sending already marks the conversation seen.
   */
  const sent = () => {
    setReplies((n) => n + 1);
    say("Sent");
  };
  return {
    flash,
    replies,
    dir,
    picker,
    reply,
    setText: (text: string) => setReply(currentId, { text }),
    /** How the mail reply on top is addressed (plan 076). */
    setMail: (mail: MailAddressing) => setReply(currentId, { mail }),
    /** The thread opened on the Slack card on top, which its reply goes into (plan 085); null back in its conversation. */
    setThread: (thread: OpenedThread | null) => setReply(currentId, { thread }),
    openPicker: (kind: PickerKind | null) => setPicking(kind && currentId ? { id: currentId, kind } : null),
    ...deck,
    sent,
  };
}

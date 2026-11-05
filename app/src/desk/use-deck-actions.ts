import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import type { AttentionItem } from "../../../core/attention/model.ts";
import { idOf, type Decision } from "../../../core/attention/queue.ts";
import { EMPTY_REPLY, createDeckMoves, type DeckMoveApi, type PickerKind, type ReplyBox } from "./deck-moves";

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
 * the CPU.
 */
export function useDeckActions({
  current,
  decided,
  setDecided,
  setQueue,
  moves,
  agent = null,
}: {
  current: AttentionItem | undefined;
  decided: Decision[];
  setDecided: Dispatch<SetStateAction<Decision[]>>;
  setQueue: Dispatch<SetStateAction<AttentionItem[]>>;
  moves: DeckMoveApi;
  /** The agent pill on, if one is: undo takes back that agent's last decision, the one you can see. */
  agent?: string | null;
}) {
  const [flash, setFlash] = useState<string | null>(null);
  /** Replies and answers sent this visit. A reply on a chat keeps you on the card; the deck's keys move it. */
  const [replies, setReplies] = useState(0);
  /** Which way the last move went; the next card enters from that side. */
  const [dir, setDir] = useState<"next" | "back">("next");
  /** The picker open, and on which card; another card on top closes it. */
  const [picking, setPicking] = useState<{ id: string; kind: PickerKind } | null>(null);
  /** The reply box of one outside card; another card on top starts with an empty one. */
  const [box, setBox] = useState<{ id: string } & ReplyBox>({ id: "", ...EMPTY_REPLY });

  const currentId = current ? idOf(current) : "";
  const reply: ReplyBox = box.id === currentId ? box : EMPTY_REPLY;
  const picker = picking?.id === currentId ? picking.kind : null;

  // One flash for the deck's life, made once from the stable setter, and its pending clear cancelled when the deck goes.
  const [flasher] = useState(() => createFlash(setFlash));
  useEffect(() => () => flasher.stop(), [flasher]);
  const say = flasher.say;
  const setReply = (id: string, patch: Partial<ReplyBox>) => setBox((b) => ({ ...(b.id === id ? b : { id, ...EMPTY_REPLY }), ...patch }));
  const deck = createDeckMoves({
    current,
    decided,
    agent,
    reply,
    setReply,
    setDecided,
    setQueue,
    say,
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
    say("sent");
  };
  return {
    flash,
    replies,
    dir,
    picker,
    reply,
    setText: (text: string) => setReply(currentId, { text }),
    openPicker: (kind: PickerKind | null) => setPicking(kind && currentId ? { id: currentId, kind } : null),
    ...deck,
    sent,
  };
}

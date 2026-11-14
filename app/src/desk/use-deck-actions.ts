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
 * The cards whose reply is on its way, outside React so a second press in the same event already sees the first. `set`
 * returns a copy for drawing.
 */
export function createSending(): { has: (id: string) => boolean; set: (id: string, on: boolean) => ReadonlySet<string> } {
  const ids = new Set<string>();
  return {
    has: (id) => ids.has(id),
    set(id, on) {
      if (on) ids.add(id);
      else ids.delete(id);
      return new Set(ids);
    },
  };
}

/**
 * What moves a card, and the small state those moves leave behind: the flash on the badge
 * ("read", "later", "archived", "labelled", "approved", "sent"), the count of replies this visit, which way the last
 * move went so the next card enters from that side, the picker open on the card, and an outside card's reply box,
 * which the deck holds so its keys can send it (KTD9). The moves themselves are `createDeckMoves`, the same on every
 * card: read (⌘]) marks it read and it rests, later (⌘[) keeps it unread and brings it back, archive (⌘E) is done. The
 * rows, the selection and the decisions are the deck's (useDeckQueue); this hook only writes to them. Every move acts on
 * the selected card, takes it out of the rows and selects the row after it. A Jira comment the person approved for the
 * agent goes into the box of its card once, when the card is selected, after whatever is typed there, and waits for
 * them to send it (plan 2026-11-10-1451, KTD18).
 */
export function useDeckActions({
  current,
  selected,
  queue,
  select,
  decided,
  setDecided,
  setQueue,
  moves,
  lane = null,
  onSignIn,
}: {
  /** The selected card as drawn, whose reply box and picker these are. */
  current: AttentionItem | undefined;
  /** The card the moves act on, read at the press; undefined while there is none to act on (R11). */
  selected: () => AttentionItem | undefined;
  /** The visit's rows, in the list's order. */
  queue: AttentionItem[];
  select: (id: string | null) => void;
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
  /** The picker open, and on which card; another card selected closes it. */
  const [picking, setPicking] = useState<{ id: string; kind: PickerKind } | null>(null);
  /**
   * The reply box of one outside card, and the approved comments it took in by proposal id; another card selected starts
   * with an empty one, but for the words the person left unsent in that card's box, which are kept for the session
   * (plan 087, KTD7) so a lane switch does not lose them, and the comments still waiting on that card, taken in again
   * unless the kept words already hold them.
   */
  const [box, setBox] = useState<{ id: string; seeded: readonly string[] } & ReplyBox>({ id: "", seeded: [], ...EMPTY_REPLY });
  /**
   * The cards whose reply is on its way, by id: kept apart from the box, which another card selected replaces, so a card
   * stays busy until its send settles however the selection moves. `sendingNow` is what a press reads, current within the
   * same event; the state draws it.
   */
  const [sendingNow] = useState(() => createSending());
  const [sending, setSendingIds] = useState<ReadonlySet<string>>(() => new Set());

  const currentId = current ? idOf(current) : "";
  const own = box.id === currentId ? box : { id: currentId, seeded: [], ...EMPTY_REPLY, text: outsideReplies.get(currentId) };
  const fresh = currentId ? freshSeeds(current?.outside?.seeds, own.seeded) : [];
  if (fresh.length > 0) {
    // Taken in as the deck renders, the way React adjusts state to new props: no effect copies them in a frame later.
    // The kept words learn them once the person edits the box, so nothing outside React changes during render.
    const missing = fresh.filter((s) => !own.text.includes(s.text));
    setBox({ ...own, text: withSeeds(own.text, missing), seeded: [...own.seeded, ...fresh.map((s) => s.id)] });
  }
  /** A card's box as written so far: the held box when it is that card's, else its kept words. */
  const boxOf = (id: string): ReplyBox => (box.id === id ? box : { ...EMPTY_REPLY, text: outsideReplies.get(id) });
  const reply: ReplyBox = { ...boxOf(currentId), busy: sending.has(currentId) };
  const picker = picking?.id === currentId ? picking.kind : null;

  // One flash for the deck's life, made once from the stable setter, and its pending clear cancelled when the deck goes.
  const [flasher] = useState(() => createFlash(setFlash));
  useEffect(() => () => flasher.stop(), [flasher]);
  const say = flasher.say;
  const setReply = (id: string, patch: Partial<ReplyBox>) => {
    if (patch.text !== undefined) outsideReplies.set(id, patch.text);
    setBox((b) => ({ ...(b.id === id ? b : { id, seeded: [], ...EMPTY_REPLY, text: outsideReplies.get(id) }), ...patch }));
  };
  const setSending = (id: string, on: boolean) => {
    setSendingIds(sendingNow.set(id, on));
  };
  const deck = createDeckMoves({
    selected,
    queue,
    select,
    decided,
    lane,
    replyOf: (id) => ({ ...boxOf(id), busy: sendingNow.has(id) }),
    setReply,
    setSending,
    setDecided,
    setQueue,
    say,
    notice: (item, words) => {
      const cause = item.outside?.disconnected;
      const mend = cause && item.outside && onSignIn ? mendLabel(cause, item.outside.provider) : null;
      notify(words, mend && onSignIn ? { action: { label: mend, onClick: onSignIn } } : undefined);
    },
    setDir,
    pick: (id, kind) => setPicking((p) => (kind ? { id, kind } : p?.id === id ? null : p)),
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
    /** How the selected mail reply is addressed (plan 076). */
    setMail: (mail: MailAddressing) => setReply(currentId, { mail }),
    /** The thread opened on the selected Slack card, which its reply goes into (plan 085); null back in its conversation. */
    setThread: (thread: OpenedThread | null) => setReply(currentId, { thread }),
    openPicker: (kind: PickerKind | null) => setPicking(kind && currentId ? { id: currentId, kind } : null),
    ...deck,
    sent,
  };
}

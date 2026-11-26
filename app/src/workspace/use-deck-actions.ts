import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import type { AttentionItem } from "../../../core/attention/model.ts";
import type { ResolvedLane } from "../../../core/attention/lanes.ts";
import type { MailAddressing } from "../../../core/frame-types.ts";
import { idOf, type Decision } from "../../../core/attention/queue.ts";
import { outsideReplies } from "../shared/outside-replies";
import { EMPTY_REPLY, createDeckMoves, type DeckMoveApi, type OpenedThread, type PickerKind, type ReplyBox } from "./deck-moves";
import { freshSeeds, mendLabel, withSeeds } from "./outside-words";
import { notify } from "../components";

export const FLASH_MS = 900;

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
  current: AttentionItem | undefined;
  selected: () => AttentionItem | undefined;
  queue: AttentionItem[];
  select: (id: string | null) => void;
  decided: Decision[];
  setDecided: Dispatch<SetStateAction<Decision[]>>;
  setQueue: Dispatch<SetStateAction<AttentionItem[]>>;
  moves: DeckMoveApi;
  lane?: ResolvedLane | null;
  onSignIn?: () => void;
}) {
  const [flash, setFlash] = useState<string | null>(null);
  const [replies, setReplies] = useState(0);
  const [dir, setDir] = useState<"next" | "back">("next");
  const [picking, setPicking] = useState<{ id: string; kind: PickerKind } | null>(null);
  const [box, setBox] = useState<{ id: string; seeded: readonly string[] } & ReplyBox>({ id: "", seeded: [], ...EMPTY_REPLY });
  const [sendingNow] = useState(() => createSending());
  const [sending, setSendingIds] = useState<ReadonlySet<string>>(() => new Set());

  const currentId = current ? idOf(current) : "";
  const own = box.id === currentId ? box : { id: currentId, seeded: [], ...EMPTY_REPLY, text: outsideReplies.get(currentId) };
  const fresh = currentId ? freshSeeds(current?.outside?.seeds, own.seeded) : [];
  if (fresh.length > 0) {
    const missing = fresh.filter((s) => !own.text.includes(s.text));
    setBox({ ...own, text: withSeeds(own.text, missing), seeded: [...own.seeded, ...fresh.map((s) => s.id)] });
  }
  const boxOf = (id: string): ReplyBox => (box.id === id ? box : { ...EMPTY_REPLY, text: outsideReplies.get(id) });
  const reply: ReplyBox = { ...boxOf(currentId), busy: sending.has(currentId) };
  const picker = picking?.id === currentId ? picking.kind : null;

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
    setMail: (mail: MailAddressing) => setReply(currentId, { mail }),
    setThread: (thread: OpenedThread | null) => setReply(currentId, { thread }),
    openPicker: (kind: PickerKind | null) => setPicking(kind && currentId ? { id: currentId, kind } : null),
    ...deck,
    sent,
  };
}

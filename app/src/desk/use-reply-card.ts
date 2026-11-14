import { useCallback, useEffect, useState } from "react";
import type { ReplyOutcome } from "../../../core/attention/chat-store.ts";
import type { ReplyAttachment, ReplyProposal } from "../../../core/frame-types.ts";
import type { ReplyAction, ReplyDecideOptions } from "../../../core/frames.ts";
import { messageOf } from "../../../core/errors.ts";
import { osWords } from "../shell/os-words";
import { platform, type Platform } from "./env";

/*
 * What both reply cards share (plan 2026-11-14-1134, U7): the person's edit and the files they took off, Send, Undo and
 * Reject, and a sent reply kept on screen for a moment after the push drops it. The desktop's card (item/proposal.tsx)
 * and the phone's (desk/reply-proposal-card.tsx) draw these in their own looks.
 */

/** How long a sent reply's card says "Sent" before it leaves. */
export const SENT_MS = 3000;

/** How a card asks for one of its actions, and what it carries beside it. */
export type DecideReply = (action: ReplyAction, opts: ReplyDecideOptions) => Promise<ReplyOutcome>;

/**
 * What a Send carries as the person's edit: their text when they changed it, else none, so the proposal goes as the
 * agent wrote it last, even when it was still being written when the card opened.
 */
export function replyEdit(edited: string | null, proposed: string): string | null {
  return edited === null || edited === proposed ? null : edited;
}

/**
 * What pressing Send asks for: the person's edit, and the names of exactly the files the card shows as kept, so nothing
 * goes that the card did not show.
 */
export function replySend(edited: string | null, p: Pick<ReplyProposal, "text" | "attachments">, removed: ReadonlySet<string>): ReplyDecideOptions {
  return { text: replyEdit(edited, p.text), files: (p.attachments ?? []).filter((f) => !removed.has(f.name)).map((f) => f.name) };
}

/** The proposal's status and reason in one string, so a last action's message can be tied to the state it answered. */
const answeredKey = (p: Pick<ReplyProposal, "status" | "reason">): string => `${p.status}:${p.reason ?? ""}`;

/** Why the last action did not go through, with the proposal state it was pressed on. */
export interface FailedAction {
  message: string;
  answered: string;
}

/** A last action's message, tied to the proposal as it was when the action was pressed. */
export function failedAction(message: string, p: Pick<ReplyProposal, "status" | "reason">): FailedAction {
  return { message, answered: answeredKey(p) };
}

/**
 * What the card says is wrong: nothing while it sends; else the last action's message while the proposal is as it was
 * when that action was pressed, and the proposal's own reason once the server has said more since. So a late Undo's
 * "too late to undo" does not hide why the send then failed.
 */
export function cardReason(p: Pick<ReplyProposal, "status" | "reason">, failed: FailedAction | null): string | null {
  if (p.status === "sending") return null;
  return failed?.answered === answeredKey(p) ? failed.message : p.reason;
}

/** One card's state and its three actions; `undoRef` goes on Undo, which takes the focus when Send is pressed. */
export interface ReplyCard {
  /** The text as the card shows it: the person's edit, or the proposal's as it is now. */
  text: string;
  setText: (text: string) => void;
  /** The files the card shows as going with the reply. */
  kept: ReplyAttachment[];
  /** Take a file off the reply, or put it back. */
  toggleFile: (name: string) => void;
  /** Held after Send until the hold ends or Undo. */
  sending: boolean;
  /** An action is waiting on its answer. */
  busy: boolean;
  /** Why the last action did not go through, or why the reply is waiting again; null when nothing went wrong. */
  reason: string | null;
  send: () => void;
  undo: () => void;
  reject: () => void;
  undoRef: (el: HTMLButtonElement | null) => void;
}

/** The state behind one reply card: the person's edits stay theirs, and the proposal's own fields are read as they are now. */
export function useReplyCard(p: ReplyProposal, onDecide: DecideReply): ReplyCard {
  // Null until the person changes the text: until then the text follows the proposal, and Send carries no edit.
  const [edited, setEdited] = useState<string | null>(null);
  const [removed, setRemoved] = useState<ReadonlySet<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<FailedAction | null>(null);
  // Set by Send, so Undo takes the focus when it appears, and only then: a card opened mid-send leaves the focus alone.
  const [focusUndo, setFocusUndo] = useState(false);
  const act = async (action: ReplyAction, opts: ReplyDecideOptions) => {
    setBusy(true);
    try {
      const out = await onDecide(action, opts);
      setFailed(out.done || out.message === null ? null : failedAction(out.message, p));
    } catch (err: unknown) {
      // A call that throws leaves the card usable and says why, rather than holding its buttons off for good.
      setFailed(failedAction(messageOf(err), p));
    } finally {
      setBusy(false);
    }
  };
  const undoRef = useCallback(
    (el: HTMLButtonElement | null) => {
      if (el && focusUndo) el.focus();
    },
    [focusUndo],
  );
  const sending = p.status === "sending";
  return {
    text: edited ?? p.text,
    setText: setEdited,
    kept: (p.attachments ?? []).filter((f) => !removed.has(f.name)),
    toggleFile: (name) =>
      setRemoved((was) => {
        const next = new Set(was);
        if (!next.delete(name)) next.add(name);
        return next;
      }),
    sending,
    busy,
    reason: cardReason(p, failed),
    send: () => {
      setFocusUndo(true);
      void act("approve", replySend(edited, p, removed));
    },
    undo: () => {
      setFocusUndo(false);
      void act("undo", {});
    },
    reject: () => void act("reject", {}),
    undoRef,
  };
}

/** The open proposals' ids and states in one string, so a list read anew with the same contents counts as the same. */
const stateKey = (ps: readonly ReplyProposal[]): string => ps.map((p) => `${p.id}:${p.status}`).join(",");

/**
 * The replies that went between two pushes of a chat's open proposals: each one that was sending and is gone, marked
 * sent. One that was sending leaves the list only by being sent: Undo or a failed send returns it pending, and only a
 * pending one is rejected or withdrawn.
 */
export function justSent(before: readonly ReplyProposal[], now: readonly ReplyProposal[]): ReplyProposal[] {
  const open = new Set(now.map((p) => p.id));
  return before.filter((p) => p.status === "sending" && !open.has(p.id)).map((p): ReplyProposal => ({ ...p, status: "sent" }));
}

/**
 * The replies that just went, each for SENT_MS. The push carries only open proposals, so the list seen last is kept to
 * tell which left (justSent).
 */
export function useSentReplies(proposals: readonly ReplyProposal[]): ReplyProposal[] {
  const [seen, setSeen] = useState(() => ({ key: stateKey(proposals), proposals }));
  const [sent, setSent] = useState<ReplyProposal[]>([]);
  const key = stateKey(proposals);
  if (key !== seen.key) {
    // Adjusting state while rendering for a changed list, as React's docs have it, so no frame shows the reply gone.
    const gone = justSent(seen.proposals, proposals);
    setSeen({ key, proposals });
    if (gone.length) setSent((was) => [...was.filter((p) => !proposals.some((x) => x.id === p.id) && !gone.some((g) => g.id === p.id)), ...gone]);
  }
  useEffect(() => {
    if (sent.length === 0) return;
    const t = setTimeout(() => setSent([]), SENT_MS);
    return () => clearTimeout(t);
  }, [sent]);
  return sent;
}

/** The name of the control that shows a file in the system's file manager: Show in Finder on the Mac. */
export function revealLabel(os: Platform = platform): string {
  return os === "linux" ? "Show in Folder" : `Show in ${osWords(os).fileManager}`;
}

/** Show a file in its folder through the desktop app's opener, as a message's file chips do. */
export function revealFile(path: string): void {
  void import("@tauri-apps/plugin-opener").then(({ revealItemInDir }) => revealItemInDir(path)).catch((err: unknown) => console.warn("loki: reveal file", err));
}

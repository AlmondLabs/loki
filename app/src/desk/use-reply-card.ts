import { useCallback, useEffect, useState } from "react";
import type { ReplyOutcome } from "../../../core/attention/chat-store.ts";
import type { ReplyAttachment, ReplyMention, ReplyProposal } from "../../../core/frame-types.ts";
import { lastByName, liveMentions } from "../../../core/mentions.ts";
import type { ReplyAction, ReplyDecideOptions } from "../../../core/frames.ts";
import { messageOf } from "../../../core/errors.ts";
import { osWords } from "../shell/os-words";
import { platform, type Platform } from "./env";
import { revealItemInDir } from "../shell/desktop";

export const SENT_MS = 3000;

export type DecideReply = (action: ReplyAction, opts: ReplyDecideOptions) => Promise<ReplyOutcome>;

export function replyEdit(edited: string | null, proposed: string): string | null {
  return edited === null || edited === proposed ? null : edited;
}

export function replySend(
  edited: string | null,
  p: Pick<ReplyProposal, "text" | "attachments">,
  removed: ReadonlySet<string>,
  picked: readonly ReplyMention[] = [],
  title: string | null = null,
): ReplyDecideOptions {
  const mentions = liveMentions(edited ?? p.text, lastByName(picked));
  return {
    text: replyEdit(edited, p.text),
    ...(title?.trim() ? { title } : {}),
    files: (p.attachments ?? []).filter((f) => !removed.has(f.name)).map((f) => f.name),
    ...(mentions.length ? { mentions } : {}),
  };
}

export function cardMentions(text: string, p: Pick<ReplyProposal, "mentions">, picked: readonly ReplyMention[]): ReplyMention[] {
  const all = [
    ...(p.mentions ?? []),
    ...picked.filter((m) => !(p.mentions ?? []).some((x) => x.display === m.display && x.id === m.id && x.address === m.address)),
  ];
  return liveMentions(text, lastByName(all));
}

const answeredKey = (p: Pick<ReplyProposal, "status" | "reason">): string => `${p.status}:${p.reason ?? ""}`;

export interface FailedAction {
  message: string;
  answered: string;
}

export function failedAction(message: string, p: Pick<ReplyProposal, "status" | "reason">): FailedAction {
  return { message, answered: answeredKey(p) };
}

export function cardReason(p: Pick<ReplyProposal, "status" | "reason">, failed: FailedAction | null): string | null {
  if (p.status === "sending") return null;
  return failed?.answered === answeredKey(p) ? failed.message : p.reason;
}

export interface ReplyCard {
  text: string;
  setText: (text: string) => void;
  title: string;
  setTitle: (title: string) => void;
  kept: ReplyAttachment[];
  toggleFile: (name: string) => void;
  mentions: ReplyMention[];
  pick: (mention: ReplyMention) => void;
  sending: boolean;
  busy: boolean;
  reason: string | null;
  send: () => void;
  undo: () => void;
  reject: () => void;
  undoRef: (el: HTMLButtonElement | null) => void;
}

export function useReplyCard(p: ReplyProposal, onDecide: DecideReply): ReplyCard {
  const [edited, setEdited] = useState<string | null>(null);
  const [title, setTitle] = useState<string | null>(null);
  const [removed, setRemoved] = useState<ReadonlySet<string>>(() => new Set());
  const [picked, setPicked] = useState<readonly ReplyMention[]>([]);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<FailedAction | null>(null);
  const [focusUndo, setFocusUndo] = useState(false);
  const act = async (action: ReplyAction, opts: ReplyDecideOptions) => {
    setBusy(true);
    try {
      const out = await onDecide(action, opts);
      setFailed(out.done || out.message === null ? null : failedAction(out.message, p));
    } catch (err: unknown) {
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
  const text = edited ?? p.text;
  return {
    text,
    setText: setEdited,
    title: title ?? p.subject,
    setTitle,
    kept: (p.attachments ?? []).filter((f) => !removed.has(f.name)),
    toggleFile: (name) =>
      setRemoved((was) => {
        const next = new Set(was);
        if (!next.delete(name)) next.add(name);
        return next;
      }),
    mentions: cardMentions(text, p, picked),
    pick: (m) => setPicked((was) => [...was, m]),
    sending,
    busy,
    reason: cardReason(p, failed),
    send: () => {
      setFocusUndo(true);
      void act("approve", replySend(edited, p, removed, picked, title !== null && title !== p.subject ? title : null));
    },
    undo: () => {
      setFocusUndo(false);
      void act("undo", {});
    },
    reject: () => void act("reject", {}),
    undoRef,
  };
}

const stateKey = (ps: readonly ReplyProposal[]): string => ps.map((p) => `${p.id}:${p.status}`).join(",");

export function justSent(before: readonly ReplyProposal[], now: readonly ReplyProposal[]): ReplyProposal[] {
  const open = new Set(now.map((p) => p.id));
  return before.filter((p) => p.status === "sending" && !open.has(p.id)).map((p): ReplyProposal => ({ ...p, status: "sent" }));
}

export function useSentReplies(proposals: readonly ReplyProposal[]): ReplyProposal[] {
  const [seen, setSeen] = useState(() => ({ key: stateKey(proposals), proposals }));
  const [sent, setSent] = useState<ReplyProposal[]>([]);
  const key = stateKey(proposals);
  if (key !== seen.key) {
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

export function revealLabel(os: Platform = platform): string {
  return os === "linux" ? "Show in Folder" : `Show in ${osWords(os).fileManager}`;
}

export function revealFile(path: string): void {
  void revealItemInDir(path).catch((err: unknown) => console.warn("loki: reveal file", err));
}

import { useCallback, useEffect, useRef, useState } from "react";
import { lessonBrief } from "../../../core/recall/extract.ts";
import type { Grade } from "../../../core/recall/fsrs.ts";
import { dueCount, learnTitle, type CardWithSchedule, type RecallSnapshot } from "../../../core/recall/model.ts";
import type { Segment } from "./keymap";
import type { Desk } from "./types";

/**
 * Recall as the window sees it: the snapshot from the mod (cards with their schedules, the deleted pile,
 * the worker's state), the count due for the rail, and the moves — grade, delete and its undo, edit,
 * restore, the worker's knobs, a run now, an export. Refreshes when the mod says the cards changed, when
 * the segment opens, and once a minute while it shows (cards come due with the clock).
 */
export function useRecall(desk: Desk, segment: Segment, notice: (m: string) => void) {
  const [snap, setSnap] = useState<RecallSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  /** The last card deleted here, for Z. */
  const lastDeleted = useRef<string | null>(null);
  /** A lead whose lesson is being created (the harness takes a moment). */
  const [starting, setStarting] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (desk.connection !== "open") return;
    const s = await desk.recall.list();
    if (s) {
      setSnap(s);
      setError(null);
    } else setError("recall did not answer");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [desk.connection]);
  useEffect(() => {
    if (desk.connection === "open") void refresh();
  }, [desk.recallVersion, desk.connection, refresh]);
  useEffect(() => {
    if (segment !== "learn") return;
    void refresh();
    const t = setInterval(() => void refresh(), 60_000);
    return () => clearInterval(t);
  }, [segment, refresh]);

  /** One card changed (or went): update in place so the deck does not wait for the refetch. */
  const patch = (id: string, card: CardWithSchedule | null) =>
    setSnap((s) => (s ? { ...s, cards: card ? s.cards.map((c) => (c.card.id === id ? card : c)) : s.cards.filter((c) => c.card.id !== id) } : s));

  const grade = async (id: string, g: Grade) => {
    const r = await desk.recall.grade(id, g);
    if (!r.ok) return notice(r.message);
    patch(id, r.card);
  };
  const remove = async (id: string) => {
    const r = await desk.recall.reject(id);
    if (!r.ok) return notice(r.message);
    lastDeleted.current = id;
    patch(id, null);
    notice("card deleted — Z brings it back");
    void refresh();
  };
  const undo = async () => {
    const id = lastDeleted.current;
    if (!id) return;
    lastDeleted.current = null;
    const r = await desk.recall.restore(id);
    if (!r.ok) return notice(r.message);
    notice("card restored");
    void refresh();
  };
  const restore = async (id: string) => {
    const r = await desk.recall.restore(id);
    if (!r.ok) return notice(r.message);
    void refresh();
  };
  const forget = async (id: string) => {
    const r = await desk.recall.forget(id);
    if (!r.ok) return notice(r.message);
    void refresh();
  };
  const edit = async (id: string, text: { front?: string; back?: string; tags?: string[] }) => {
    const r = await desk.recall.edit(id, text);
    if (!r.ok) return notice(r.message);
    patch(id, r.card);
  };
  const settings = async (s: { enabled?: boolean; model?: string | null; dailyCap?: number; tickMinutes?: number }) => {
    const next = await desk.recall.settings(s);
    if (next) setSnap(next);
    else notice("the setting did not take");
  };
  const run = async () => {
    setRunning(true);
    const note = await desk.recall.run();
    setRunning(false);
    notice(`learn: ${note}`);
    void refresh();
  };
  const exportCards = async () => {
    const tsv = await desk.recall.export();
    if (tsv === null) return notice("export did not answer");
    const n = snap?.cards.length ?? 0;
    try {
      await navigator.clipboard.writeText(tsv);
      notice(`${n} card${n === 1 ? "" : "s"} copied as Anki text — front, back, tags per line`);
    } catch {
      notice("the clipboard refused");
    }
  };

  /**
   * Start a lesson from a lead: the mod makes the [Learn] conversation and furnishes its desk; the caller opens the
   * desk and sends the brief (the person's first message) over the app's live socket. Null when the mod refused.
   */
  const startLead = async (id: string): Promise<{ agentId: string; conversationId: string; brief: string; title: string } | null> => {
    const lead = snap?.leads.find((l) => l.id === id);
    if (!lead) return null;
    setStarting(id);
    const r = await desk.recall.leadStart(id);
    setStarting(null);
    if (!r.ok) {
      notice(r.message);
      return null;
    }
    void refresh();
    return { agentId: r.agentId, conversationId: r.conversationId, brief: lessonBrief(lead), title: learnTitle(lead.title) };
  };
  const dismissLead = async (id: string) => {
    const next = await desk.recall.leadDismiss(id);
    if (next) setSnap(next);
    else notice("the lead did not go");
  };
  const restoreLead = async (id: string) => {
    const next = await desk.recall.leadRestore(id);
    if (next) setSnap(next);
    else notice("nothing to restore");
  };

  const due = snap ? dueCount(snap.cards) : 0;
  return { snap, error, due, running, starting, refresh, grade, remove, undo, restore, forget, edit, settings, run, exportCards, startLead, dismissLead, restoreLead };
}

export type Recall = ReturnType<typeof useRecall>;

import { toAnkiTsv, type Lesson, type RecallSnapshot } from "../../core/recall/model.ts";
import { clampTickMinutes, DEFAULT_TICK_MINUTES, type RecallStore } from "../recall.ts";
import type { StartLesson } from "../recall-worker.ts";
import { fail, reply, type FrameContext, type FrameHandlers } from "./context.ts";

export interface RecallDeps {
  /** Learn (mod/recall.ts, mod/recall-worker.ts): the cards on disk and a way to run the worker now. */
  recall?: {
    store: RecallStore;
    run: () => Promise<{ note: string }>;
    /** The sweep timer follows the setting: called with the new interval when `tickMinutes` changes. */
    reschedule?: (minutes: number) => void;
    startLesson?: StartLesson;
    /** True while the lesson's conversation holds no message: the brief never arrived and the app offers to send it again. */
    lessonEmpty?: (lesson: Lesson) => boolean;
  };
}

/** Learn: the cards, a review, edits, setting aside and back, the writer's settings and a run, export, and its leads. Every change tells other tabs and phones to refetch. */
export function recallFrames({ recall }: RecallDeps): FrameHandlers {
  if (!recall) {
    const off = () => fail("recall is not available in this mod");
    return { recall_list: off, recall_grade: off, recall_edit: off, recall_reject: off, recall_restore: off, recall_forget: off, recall_settings: off, recall_run: off, recall_export: off, recall_lead_dismiss: off, recall_lead_restore: off, recall_lead_start: off };
  }
  const { store } = recall;
  const snapshot = (): RecallSnapshot => ({ cards: store.cards(), rejected: store.rejected(), worker: store.status(), leads: store.leads(), dismissedLeads: store.dismissedLeads(), lessons: store.lessons().map((l) => ({ ...l, empty: recall.lessonEmpty?.(l) ?? false })) });
  const changed = (ctx: FrameContext) => ctx.broadcast({ type: "recall_changed" });
  return {
    recall_list: () => reply(snapshot()),
    recall_grade: ({ id, grade }, ctx) => {
      if (!store.grade(id, grade)) return fail("no such card");
      changed(ctx);
      return reply({ card: store.card(id) });
    },
    recall_edit: ({ id, front, back, tags }, ctx) => {
      if (!store.edit(id, { front, back, tags }, "you")) return fail("no such card");
      changed(ctx);
      return reply({ card: store.card(id) });
    },
    recall_reject: ({ id }, ctx) => {
      if (!store.reject(id)) return fail("no such card");
      changed(ctx);
      return reply({ card: null });
    },
    recall_restore: ({ id }, ctx) => {
      if (!store.restore(id)) return fail("nothing to restore");
      changed(ctx);
      return reply({ card: store.card(id) });
    },
    recall_forget: ({ id }, ctx) => {
      store.forget(id);
      changed(ctx);
      return reply({ card: null });
    },
    recall_settings: ({ enabled, model, dailyCap, tickMinutes }, ctx) => {
      const update = { ...(enabled !== undefined ? { enabled } : {}), ...(model !== undefined ? { model } : {}), ...(dailyCap !== undefined ? { dailyCap } : {}), ...(tickMinutes !== undefined ? { tickMinutes: clampTickMinutes(tickMinutes) } : {}) };
      const before = store.worker().tickMinutes ?? DEFAULT_TICK_MINUTES;
      store.saveWorker(update);
      if (update.tickMinutes !== undefined && update.tickMinutes !== before) recall.reschedule?.(update.tickMinutes);
      changed(ctx);
      return reply(snapshot());
    },
    recall_run: async (_, ctx) => {
      const r = await recall.run();
      changed(ctx);
      return reply({ note: r.note });
    },
    recall_export: () => reply({ tsv: toAnkiTsv(store.cards()) }),
    recall_lead_dismiss: ({ id }, ctx) => {
      if (!store.dismissLead(id)) return fail("no such lead");
      changed(ctx);
      return reply(snapshot());
    },
    recall_lead_restore: ({ id }, ctx) => {
      if (!store.restoreLead(id)) return fail("nothing to restore");
      changed(ctx);
      return reply(snapshot());
    },
    recall_lead_start: async ({ id }, ctx) => {
      if (!recall.startLesson) return fail("lessons are not available in this mod");
      const lesson = await recall.startLesson(id); // the tab opens the desk; the tree reads the new conversation from disk on its next list
      changed(ctx);
      return reply(lesson);
    },
  };
}

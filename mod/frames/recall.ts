import { toAnkiTsv, type Lesson, type RecallSnapshot, type WorkerStatus } from "../../core/recall/model.ts";
import type { RecallStore } from "../recall.ts";
import type { StartLesson } from "../recall-worker.ts";
import { fail, reply, type FrameContext, type FrameHandlers } from "./context.ts";

export interface RecallDeps {
  recall?: {
    store: RecallStore;
    status: () => WorkerStatus;
    setSettings: (s: { enabled?: boolean; daily_cap?: number }) => Promise<void>;
    run: () => Promise<{ note: string }>;
    startLesson?: StartLesson;
    lessonEmpty?: (lesson: Lesson) => boolean;
  };
}

export function recallFrames({ recall }: RecallDeps): FrameHandlers {
  if (!recall) {
    const off = () => fail("recall is not available in this mod");
    return {
      recall_list: off,
      recall_grade: off,
      recall_edit: off,
      recall_reject: off,
      recall_restore: off,
      recall_forget: off,
      recall_settings: off,
      recall_run: off,
      recall_export: off,
      recall_lead_dismiss: off,
      recall_lead_restore: off,
      recall_lead_start: off,
    };
  }
  const { store } = recall;
  const snapshot = (): RecallSnapshot => ({
    cards: store.cards(),
    rejected: store.rejected(),
    worker: recall.status(),
    leads: store.leads(),
    dismissed_leads: store.dismissedLeads(),
    lessons: store.lessons().map((l) => ({ ...l, empty: recall.lessonEmpty?.(l) ?? false })),
  });
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
    recall_settings: async ({ enabled, daily_cap: dailyCap }, ctx) => {
      await recall.setSettings({ ...(enabled !== undefined ? { enabled } : {}), ...(dailyCap !== undefined ? { daily_cap: dailyCap } : {}) });
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
      const lesson = await recall.startLesson(id);
      changed(ctx);
      return reply(lesson);
    },
  };
}

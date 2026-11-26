import { toAnkiTsv, type Lesson, type LearnSnapshot, type WorkerStatus } from "../../core/learn/model.ts";
import type { LearnStore } from "../learn.ts";
import type { StartLesson } from "../learn-worker.ts";
import { fail, reply, type FrameContext, type FrameHandlers } from "./context.ts";

export interface LearnDeps {
  learn?: {
    store: LearnStore;
    status: () => WorkerStatus;
    setSettings: (s: { enabled?: boolean; daily_cap?: number }) => Promise<void>;
    run: () => Promise<{ note: string }>;
    startLesson?: StartLesson;
    lessonEmpty?: (lesson: Lesson) => boolean;
  };
}

export function learnFrames({ learn }: LearnDeps): FrameHandlers {
  if (!learn) {
    const off = () => fail("learn is not available in this mod");
    return {
      learn_list: off,
      learn_grade: off,
      learn_edit: off,
      learn_reject: off,
      learn_restore: off,
      learn_forget: off,
      learn_settings: off,
      learn_run: off,
      learn_export: off,
      learn_lead_dismiss: off,
      learn_lead_restore: off,
      learn_lead_start: off,
    };
  }
  const { store } = learn;
  const snapshot = (): LearnSnapshot => ({
    cards: store.cards(),
    rejected: store.rejected(),
    worker: learn.status(),
    leads: store.leads(),
    dismissed_leads: store.dismissedLeads(),
    lessons: store.lessons().map((l) => ({ ...l, empty: learn.lessonEmpty?.(l) ?? false })),
  });
  const changed = (ctx: FrameContext) => ctx.broadcast({ type: "learn_changed" });
  return {
    learn_list: () => reply(snapshot()),
    learn_grade: ({ id, grade }, ctx) => {
      if (!store.grade(id, grade)) return fail("no such card");
      changed(ctx);
      return reply({ card: store.card(id) });
    },
    learn_edit: ({ id, front, back, tags }, ctx) => {
      if (!store.edit(id, { front, back, tags }, "you")) return fail("no such card");
      changed(ctx);
      return reply({ card: store.card(id) });
    },
    learn_reject: ({ id }, ctx) => {
      if (!store.reject(id)) return fail("no such card");
      changed(ctx);
      return reply({ card: null });
    },
    learn_restore: ({ id }, ctx) => {
      if (!store.restore(id)) return fail("nothing to restore");
      changed(ctx);
      return reply({ card: store.card(id) });
    },
    learn_forget: ({ id }, ctx) => {
      store.forget(id);
      changed(ctx);
      return reply({ card: null });
    },
    learn_settings: async ({ enabled, daily_cap: dailyCap }, ctx) => {
      await learn.setSettings({ ...(enabled !== undefined ? { enabled } : {}), ...(dailyCap !== undefined ? { daily_cap: dailyCap } : {}) });
      changed(ctx);
      return reply(snapshot());
    },
    learn_run: async (_, ctx) => {
      const r = await learn.run();
      changed(ctx);
      return reply({ note: r.note });
    },
    learn_export: () => reply({ tsv: toAnkiTsv(store.cards()) }),
    learn_lead_dismiss: ({ id }, ctx) => {
      if (!store.dismissLead(id)) return fail("no such lead");
      changed(ctx);
      return reply(snapshot());
    },
    learn_lead_restore: ({ id }, ctx) => {
      if (!store.restoreLead(id)) return fail("nothing to restore");
      changed(ctx);
      return reply(snapshot());
    },
    learn_lead_start: async ({ id }, ctx) => {
      if (!learn.startLesson) return fail("lessons are not available in this mod");
      const lesson = await learn.startLesson(id);
      changed(ctx);
      return reply(lesson);
    },
  };
}

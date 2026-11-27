import { Type } from "typebox";
import { compiledCheck, isNum, nothing, LearnIdSchema, strOr, strings, type Raw } from "./primitives.ts";
import { PHONE, push, request } from "./types.ts";

const checkLearnId = compiledCheck(LearnIdSchema);
const GradeSchema = Type.Union([Type.Literal(1), Type.Literal(2), Type.Literal(3), Type.Literal(4)]);
const checkGrade = compiledCheck(GradeSchema);

const learnId = <T extends object>(m: Raw, rest: (id: string) => T | string = () => ({}) as T): ({ id: string } & T) | string => {
  if (!checkLearnId(m.id)) return "a card or lead id required";
  const r = rest(m.id);
  return typeof r === "string" ? r : { id: m.id, ...r };
};

export const learnFrames = {
  learn_list: request("learn", "the whole Learn section", nothing, PHONE),
  learn_grade: request(
    "learn_card",
    "grade a card, 1 (again) to 4 (easy)",
    (m: Raw) => learnId(m, () => (checkGrade(m.grade) ? { grade: m.grade } : "a grade is 1 (again) to 4 (easy)")),
    PHONE,
  ),
  learn_edit: request(
    "learn_card",
    "edit a card's front, back or tags",
    (m: Raw) =>
      learnId(m, () => ({ front: strOr(m.front, undefined), back: strOr(m.back, undefined), tags: Array.isArray(m.tags) ? strings(m.tags) : undefined })),
    PHONE,
  ),
  learn_reject: request("learn_card", "set a card aside (card: null)", (m: Raw) => learnId(m), PHONE),
  learn_restore: request("learn_card", "bring a set-aside card back", (m: Raw) => learnId(m), PHONE),
  learn_forget: request("learn_card", "forget a set-aside card for good (card: null)", (m: Raw) => learnId(m)),
  learn_settings: request("learn", "Learn's settings: on or off, and the most cards it writes in a day", (m: Raw) => ({
    enabled: typeof m.enabled === "boolean" ? m.enabled : undefined,
    daily_cap: isNum(m.daily_cap) && m.daily_cap >= 0 ? Math.round(m.daily_cap) : undefined,
  })),
  learn_run: request("learn_ran", "run Learn now over every chat with new material", nothing),
  learn_export: request("learn_export", "every card as Anki TSV", nothing, PHONE),
  learn_lead_dismiss: request("learn", "set a lead aside", (m: Raw) => learnId(m), PHONE),
  learn_lead_restore: request("learn", "bring a set-aside lead back", (m: Raw) => learnId(m), PHONE),
  learn_lead_start: request("learn_lesson", "a lead becomes a [Learn] conversation; the app then sends the brief", (m: Raw) => learnId(m), PHONE),

  learn_changed: push("Learn changed: other tabs and phones refetch"),
} as const;

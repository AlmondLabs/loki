import { describe, expect, test } from "vitest";
import { askQuestions, buildQuestionAnswer, buildUserContent, environmentReminder, environmentNote, ENV_NOTE_EVERY_MS } from "../core/attention/content.ts";

describe("user message content", () => {
  const img = { id: "i1", mediaType: "image/jpeg", data: "QUJD", url: "data:image/jpeg;base64,QUJD" };
  test("text only stays a plain string", () => {
    expect(buildUserContent("hi", [])).toBe("hi");
  });
  test("images become base64 parts after the text, in Letta's create_message shape", () => {
    expect(buildUserContent("look", [img])).toEqual([
      { type: "text", text: "look" },
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "QUJD" } },
    ]);
  });
  test("an image with no text has no empty text part", () => {
    expect(buildUserContent("  ", [img])).toEqual([{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "QUJD" } }]);
  });
});

describe("AskUserQuestion", () => {
  const input = { questions: [{ question: "Which db?", header: "DB", options: [{ label: "Postgres", description: "boring" }, { label: "Mongo" }], multiSelect: false }, { question: "Regions?", options: [{ label: "eu" }, { label: "us" }], multiSelect: true }, { question: "   ", options: [] }] };
  test("askQuestions keeps well-formed questions only", () => {
    const qs = askQuestions(input);
    expect(qs.map((q) => q.question)).toEqual(["Which db?", "Regions?"]);
    expect(qs[0].options[0]).toEqual({ label: "Postgres", description: "boring" });
    expect(qs[1].multiSelect).toBe(true);
    expect(askQuestions(null)).toEqual([]);
  });
  test("buildQuestionAnswer fills answers keyed by question text, joining multi-select with commas", () => {
    const out = buildQuestionAnswer(input, { "Which db?": "Postgres", "Regions?": ["eu", "us"] });
    expect(out.answers).toEqual({ "Which db?": "Postgres", "Regions?": "eu, us" });
    expect((out.questions as unknown[]).length).toBe(3); // the rest of the input rides along
  });
});

describe("environment reminder", () => {
  test("carries the local time and the chat in Desktop's shape, ahead of the text; the folder left out", () => {
    const note = environmentReminder({ now: new Date(2026, 8, 6, 2, 35), desk: "Supplier ledger", locale: "en-GB" });
    expect(note.startsWith("<system-reminder>")).toBe(true);
    expect(note).toContain("via loki, on their Mac or a paired phone");
    expect(note).toMatch(/User's device local time: Sunday,? 6 September 2026(,| at) 02:35/);
    expect(note).toContain('the chat ("Supplier ledger")');
    expect(note).not.toContain("working directory");
    const content = buildUserContent("hi", [], note);
    expect(Array.isArray(content) && content.length).toBe(2);
    expect((content as Array<{ type: string; text?: string }>)[1].text).toBe("hi");
  });
});

describe("environment note: only when the agent's picture would be wrong", () => {
  const at = (h: number, m: number, d = 6) => new Date(2026, 8, d, h, m);
  const zone = "Asia/Kolkata";
  test("a chat's first message gets the full note; the next ones within 30 minutes get none", () => {
    const first = environmentNote(undefined, { now: at(10, 0), desk: "Ledger", zone });
    expect(first.text).toContain("via loki, on their Mac or a paired phone");
    const soon = environmentNote(first.told, { now: at(10, 29), desk: "Ledger", zone });
    expect(soon.text).toBeNull();
    expect(soon.told.at).toBe(first.told.at); // the clock runs from the last note sent, not the last message
  });
  test("30 minutes on, it comes back short: the time only", () => {
    const first = environmentNote(undefined, { now: at(10, 0), desk: "Ledger", zone, locale: "en-GB" });
    const later = environmentNote(first.told, { now: at(10, 0 + ENV_NOTE_EVERY_MS / 60_000), desk: "Ledger", zone, locale: "en-GB" });
    expect(later.text).toMatch(/User's device local time: .*10:30/);
    expect(later.text).not.toContain("paired phone");
    expect(later.text).not.toContain("Ledger");
  });
  test("a new day, another time zone or a renamed chat sends it early", () => {
    const late = environmentNote(undefined, { now: at(23, 50), desk: "Ledger", zone });
    expect(environmentNote(late.told, { now: at(0, 5, 7), desk: "Ledger", zone }).text).not.toBeNull();
    expect(environmentNote(late.told, { now: at(23, 55), desk: "Ledger", zone: "Europe/London" }).text).not.toBeNull();
    const renamed = environmentNote(late.told, { now: at(23, 55), desk: "Supplier ledger", zone });
    expect(renamed.text).toContain('the chat ("Supplier ledger")');
    expect(environmentNote(renamed.told, { now: at(23, 56), desk: "Supplier ledger", zone }).text).toBeNull();
  });
});


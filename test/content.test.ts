import { describe, expect, test } from "bun:test";
import { askQuestions, buildQuestionAnswer, buildUserContent, environmentReminder } from "../app/src/attention/content";

describe("user message content", () => {
  const img = { id: "i1", mediaType: "image/jpeg", data: "QUJD", url: "data:image/jpeg;base64,QUJD" };
  test("text only stays a plain string", () => {
    expect(buildUserContent("hi", [])).toBe("hi");
  });
  test("images become base64 parts after the text, in the app-server's shape", () => {
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
  test("carries the local time (and folder when known) in Desktop's shape, ahead of the text", () => {
    const note = environmentReminder({ now: new Date(2026, 8, 6, 2, 35), folder: "/Users/x/proj", locale: "en-GB" });
    expect(note.startsWith("<system-reminder>")).toBe(true);
    expect(note).toContain("via the loki canvas");
    expect(note).toMatch(/User's device local time: Sunday,? 6 September 2026(,| at) 02:35/);
    expect(note).toContain("Current remote working directory: /Users/x/proj");
    const content = buildUserContent("hi", [], note);
    expect(Array.isArray(content) && content.length).toBe(2);
    expect((content as Array<{ type: string; text?: string }>)[1].text).toBe("hi");
  });
});

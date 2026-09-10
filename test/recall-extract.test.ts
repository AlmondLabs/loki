import { describe, expect, test } from "bun:test";
import { buildPrompt, parseExtraction, similarFront } from "../core/recall/extract.ts";

describe("recall prompt", () => {
  test("quotes rejections and existing cards, states the room, and asks for JSON", () => {
    const p = buildPrompt({
      agentName: "ira", title: "Infra AWS", transcript: "you: what does KMS rotation do?\nira: it re-keys yearly…", room: 2,
      existing: [{ id: "c1", front: "What is an SSM session log?", back: "…" }],
      rejected: [{ front: "What is the project's AWS account id?", back: "0303", reps: 0 }],
      failing: [],
    });
    expect(p).toContain("at most 2 new cards");
    expect(p).toContain("[0 reviews] Q: What is the project's AWS account id?");
    expect(p).toContain("c1: Q: What is an SSM session log?");
    expect(p).toContain("<transcript>\nyou: what does KMS rotation do?");
    expect(p).toContain('{"cards":[');
    expect(p).not.toContain("keeps failing");
  });
  test("a long transcript is cut to its tail", () => {
    const p = buildPrompt({ agentName: null, title: null, transcript: "x".repeat(30_000) + "END", room: 1, existing: [], rejected: [], failing: [] });
    expect(p).toContain("END\n</transcript>");
    expect(p.length).toBeLessThan(27_000);
  });
});

describe("recall extraction parsing", () => {
  const known = new Set(["c1"]);
  test("plain JSON, fenced JSON, and JSON with prose around it all parse", () => {
    const body = '{"cards":[{"front":"Q?","back":"A.","tags":["Aws"," IAM "]}],"revisions":[{"id":"c1","back":"B.","reason":"tighter"}]}';
    for (const text of [body, "```json\n" + body + "\n```", "Here you go:\n" + body + "\nDone."]) {
      const e = parseExtraction(text, known);
      expect(e.cards).toEqual([{ front: "Q?", back: "A.", tags: ["aws", "iam"] }]);
      expect(e.revisions).toEqual([{ id: "c1", front: undefined, back: "B.", reason: "tighter" }]);
    }
  });
  test("drops cards missing a side, revisions for unknown ids or with no change, and garbage", () => {
    const e = parseExtraction('{"cards":[{"front":"only front"},{"front":"","back":"x"},{"front":"ok","back":"ok"}],"revisions":[{"id":"nope","back":"x"},{"id":"c1","reason":"nothing"}]}', known);
    expect(e.cards).toEqual([{ front: "ok", back: "ok", tags: [] }]);
    expect(e.revisions).toEqual([]);
    expect(parseExtraction("not json at all", known)).toEqual({ cards: [], revisions: [] });
    expect(parseExtraction("{broken", known)).toEqual({ cards: [], revisions: [] });
    expect(parseExtraction("[]", known)).toEqual({ cards: [], revisions: [] });
  });
});

describe("similar fronts", () => {
  test("same question in different casing or punctuation, or one containing the other", () => {
    expect(similarFront("What does KMS rotation do?", "what does kms rotation do")).toBe(true);
    expect(similarFront("Which flag makes tar strip the top folder?", "What is the tar flag that strips the top-level folder?")).toBe(false);
    expect(similarFront("How does FSRS compute the next interval from stability?", "How does FSRS compute the next interval from stability and difficulty?")).toBe(true);
    expect(similarFront("What is X?", "What is Y?")).toBe(false);
    expect(similarFront("", "What is Y?")).toBe(false);
  });
});

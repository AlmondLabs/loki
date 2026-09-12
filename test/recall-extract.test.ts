import { describe, expect, test } from "bun:test";
import { buildPrompt, lessonBrief, parseExtraction, similarFront } from "../core/recall/extract.ts";

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
    expect(parseExtraction("not json at all", known)).toEqual({ cards: [], revisions: [], leads: [] });
    expect(parseExtraction("{broken", known)).toEqual({ cards: [], revisions: [], leads: [] });
    expect(parseExtraction("[]", known)).toEqual({ cards: [], revisions: [], leads: [] });
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

describe("learning leads in the writer's call", () => {
  const base = { agentName: "ira", title: "Infra AWS", transcript: "you: what does KMS rotation do?\nira: it re-keys yearly…", room: 2, existing: [], rejected: [], failing: [] };
  test("with room, the prompt asks for leads, quotes the ones already known, and the JSON shape gains them", () => {
    const p = buildPrompt({ ...base, leads: { open: ["KMS key rotation"], started: ["IAM permission boundaries"], dismissed: ["Kubernetes"], room: 5 } });
    expect(p).toContain("name up to 2 things");
    expect(p).toContain("- KMS key rotation");
    expect(p).toContain("- IAM permission boundaries");
    expect(p).toContain("dismissed (never again");
    expect(p).toContain("- Kubernetes");
    expect(p).toContain('"leads":[{"title"');
  });
  test("without room, or without the leads input, the prompt says nothing about leads", () => {
    expect(buildPrompt({ ...base, leads: { open: [], started: [], dismissed: [], room: 0 } })).not.toContain("leads");
    expect(buildPrompt(base)).not.toContain('"leads"');
  });
  test("leads parse with a default depth, a trimmed title, and at most two", () => {
    const ext = parseExtraction('{"cards":[],"revisions":[],"leads":[{"title":"Savings Plan utilisation?","why":"you asked what covered means","depth":"course"},{"title":"NAT processing","why":"went by unquestioned"},{"title":"third","why":"too many"}]}', new Set());
    expect(ext.leads).toEqual([
      { title: "Savings Plan utilisation", why: "you asked what covered means", depth: "course" },
      { title: "NAT processing", why: "went by unquestioned", depth: "primer" },
    ]);
    expect(parseExtraction('{"cards":[]}', new Set()).leads).toEqual([]);
  });
  test("the lesson brief names the topic, the moment, the desk-first rule and the cold quiz", () => {
    const b = lessonBrief({ title: "Savings Plan utilisation", why: "you took my word for 'fully covered'", depth: "primer", source: { title: "[Long] - cost control" } });
    expect(b).toContain("I want to understand: Savings Plan utilisation.");
    expect(b).toContain('came up in "[Long] - cost control": you took my word');
    expect(b).toContain("sized for one sitting");
    expect(b).toContain("furnish this desk");
    expect(b).toContain("quiz me cold");
  });
});

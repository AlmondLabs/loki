import { describe, expect, test } from "bun:test";
import { buildPrompt, lessonBrief, parseExtraction, similarFront } from "../core/recall/extract.ts";

describe("recall prompt", () => {
  test("quotes rejections and existing cards, states the room, and asks for JSON", () => {
    const p = buildPrompt({
      agentName: "ira", slices: [{ id: "s1", title: 'Infra "AWS"', mode: "new", text: "you: what does KMS rotation do?\nira: it re-keys yearly…" }], room: 2,
      existing: [{ id: "c1", front: "What is an SSM session log?", back: "…" }],
      rejected: [{ front: "What is the project's AWS account id?", back: "0303", reps: 0 }],
      failing: [],
    });
    expect(p).toContain("at most 2 new cards across everything below");
    expect(p).toContain("[0 reviews] Q: What is the project's AWS account id?");
    expect(p).toContain("c1: Q: What is an SSM session log?");
    expect(p).toContain("One stretch follows, new since you last read it, labelled s1.");
    expect(p).toContain(`<slice id="s1" conversation="Infra 'AWS'" mode="new" chars="55">\nyou: what does KMS rotation do?`);
    expect(p).toContain('{"cards":[{"slice":"s1"');
    expect(p).not.toContain("keeps failing");
    expect(p).not.toContain("The deck has");
  });
  test("a long slice is cut to its tail", () => {
    const p = buildPrompt({ agentName: null, slices: [{ id: "s1", title: null, mode: "new", text: "x".repeat(30_000) + "END" }], room: 1, existing: [], rejected: [], failing: [] });
    expect(p).toContain("END\n</slice>");
    expect(p).toContain('conversation="untitled"');
    expect(p.length).toBeLessThan(27_000);
  });
  test("several slices are read together, a replay says what it is for, and the deck on disk is pointed at", () => {
    const p = buildPrompt({
      agentName: "ira",
      slices: [
        { id: "s1", title: "Jira cleanup", mode: "new", text: "you: what is a sprint carry-over?\nira: …" },
        { id: "s2", title: "KMS keys", mode: "new", text: "you: what does KMS rotation do?\nira: …" },
        { id: "s3", title: "Terraform state", mode: "replay", forCard: "c_8f2", text: "you: why is the state locked?\nira: …" },
      ],
      room: 3, existing: [{ id: "c_8f2", front: "What locks Terraform state?", back: "DynamoDB" }], deck: { path: "/tmp/recall", total: 41 }, rejected: [], failing: [{ id: "c_8f2", front: "What locks Terraform state?", back: "DynamoDB" }],
      leads: { open: [], started: [], dismissed: [], room: 12 },
    });
    expect(p).toContain("Stretches from 3 conversations follow, labelled s1, s2, s3");
    expect(p).toContain("the same fact in two places is one card");
    expect(p).toContain("Name the slice each card, revision and lead came from");
    expect(p).toContain('<slice id="s3" conversation="Terraform state" mode="replay" for="c_8f2" chars="');
    expect(p).toContain("here because card c_8f2 keeps failing");
    expect(p).toContain("Existing cards whose wording touches these stretches");
    expect(p).toContain("The deck has 41 cards in all; 40 are not listed above. Every card is a file under /tmp/recall/cards/");
    expect(p).toContain("never run shell commands");
    expect(p).toContain("name up to 4 things"); // two per new slice; the replay adds none
    expect(p).toContain('"leads":[{"slice":"s1"');
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
    const labelled = parseExtraction('{"cards":[{"slice":"s2","front":"Q?","back":"A."}],"revisions":[{"id":"c1","slice":"s1","back":"B."}],"leads":[{"slice":"s2","title":"T","why":"w"}]}', known);
    expect(labelled.cards[0].slice).toBe("s2");
    expect(labelled.revisions[0].slice).toBe("s1");
    expect(labelled.leads[0].slice).toBe("s2");
    {
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
  const base = { agentName: "ira", slices: [{ id: "s1" as const, title: "Infra AWS", mode: "new" as const, text: "you: what does KMS rotation do?\nira: it re-keys yearly…" }], room: 2, existing: [], rejected: [], failing: [] };
  test("with room, the prompt asks for leads, quotes the ones already known, and the JSON shape gains them", () => {
    const p = buildPrompt({ ...base, leads: { open: ["KMS key rotation"], started: ["IAM permission boundaries"], dismissed: ["Kubernetes"], room: 5 } });
    expect(p).toContain("name up to 2 things");
    expect(p).toContain("- KMS key rotation");
    expect(p).toContain("- IAM permission boundaries");
    expect(p).toContain("dismissed (never again");
    expect(p).toContain("- Kubernetes");
    expect(p).toContain('"leads":[{"slice":"s1","title"');
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
    // A sweep over several slices allows two leads per new slice.
    const three = '{"leads":[{"title":"a","why":"w"},{"title":"b","why":"w"},{"title":"c","why":"w"}]}';
    expect(parseExtraction(three, new Set(), { maxLeads: 4 }).leads).toHaveLength(3);
    expect(parseExtraction(three, new Set()).leads).toHaveLength(2);
  });
  test("the lesson brief names the topic, the moment, the desk-first rule and the cold quiz", () => {
    const b = lessonBrief({ title: "Savings Plan utilisation", why: "you took my word for 'fully covered'", depth: "primer", source: { title: "[Long] - cost control" } });
    expect(b).toContain("I want to understand: Savings Plan utilisation.");
    expect(b).toContain('came up in "[Long] - cost control": you took my word');
    expect(b).toContain("sized for one sitting");
    expect(b).toContain("furnish this desk");
    expect(b).toContain("why this matters to me");
    expect(b).toContain("quiz me cold");
  });
});

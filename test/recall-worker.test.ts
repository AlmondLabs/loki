import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import type { ChatBackend } from "../mod/frames/chat.ts";
import { scopeFor } from "../core/desk-core.ts";
import { join } from "node:path";
import { RecallStore } from "../mod/recall.ts";
import { formatTranscript, isPassChat, lessonCard, overlappingCards, ownsRecallChat, startLessonViaChats } from "../mod/recall-worker.ts";

let dir: string;
let store: RecallStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "loki-recall-w-"));
  store = new RecallStore(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("Learn's shared pieces", () => {
  test("cards are quoted only when their words overlap the stretch", () => {
    const cards = [
      { id: "1", front: "What does KMS key rotation do?", back: "…", tags: [] },
      { id: "2", front: "Which port does Postgres use?", back: "5432", tags: ["postgres"] },
      { id: "3", front: "What is a sprint?", back: "…", tags: ["jira"] },
    ];
    expect(overlappingCards(cards, ["you: is rotation of a KMS key automatic? ira: yes, and jira has nothing to do with it"]).map((c) => c.id)).toEqual([
      "1",
      "3",
    ]);
    expect(overlappingCards(cards, ["nothing here"])).toEqual([]);
    expect(overlappingCards(cards, ["postgres port"], 1).map((c) => c.id)).toEqual(["2"]);
  });

  test("formatTranscript keeps only what was said", () => {
    const t = formatTranscript(
      [
        { role: "user", text: " hi " },
        { role: "tool", text: "Read x" },
        { role: "event", text: "compacted" },
        { role: "assistant", text: "hello" },
      ],
      "ira",
    );
    expect(t).toBe("you: hi\nira: hello");
  });

  test("Learn's own hidden chats are its writer chats; the passes' chats, Learn's, reflection's and a review's, are none of the person's", () => {
    expect(ownsRecallChat("recall-a1")).toBe(true);
    expect(ownsRecallChat("local-conv-person")).toBe(false);
    for (const id of ["recall-a1", "reflection-a1", "doctor-a1"]) expect(isPassChat(id), id).toBe(true);
    for (const id of ["default", "local-conv-person", "reflections-on-design"]) expect(isPassChat(id), id).toBe(false);
  });
});

describe("a lesson's first widget", () => {
  test("the info card carries the lead: depth, where it came up, the moment, and who lays the lesson out", () => {
    const card = lessonCard({
      id: "l1",
      title: "Envelope encryption",
      why: "you asked what a data key was",
      depth: "primer",
      source: { agent_id: "a1", agent_name: "ira", conversation_id: "c1", title: "[Long] - KMS", at: null },
      created_at: "2026-09-13T00:00:00Z",
    });
    expect(card.type).toBe("info-card");
    expect(card.title).toBe("Envelope encryption");
    expect(card.data.lines).toEqual([
      "a primer — one sitting",
      'it came up in "[Long] - KMS" with ira',
      "you asked what a data key was",
      "ira lays the lesson out here; the chat opens with the brief",
    ]);
    expect(
      lessonCard({
        id: "l2",
        title: "T",
        why: "w",
        depth: "course",
        source: { agent_id: "a1", agent_name: null, conversation_id: "c1", title: null, at: null },
        created_at: "2026-09-13T00:00:00Z",
      }).data.lines.slice(0, 2),
    ).toEqual(["a course — a few sittings", "it came up in a conversation with the agent"]);
  });
});

describe("a lesson on loki's daemon", () => {
  test("starting one makes its [Learn] chat in the home folder, furnishes its desk with the card, and records the lesson", async () => {
    store.addLead({
      id: "l1",
      title: "Envelope encryption",
      why: "w",
      depth: "primer",
      source: { agent_id: "a1", agent_name: "ira", conversation_id: "c1", title: null, at: null },
      created_at: "2026-09-13T00:00:00Z",
    });
    const made: string[] = [];
    const chats = {
      create: (agentId: string, cwd: string | null, title: string | null) => (
        made.push(`${agentId} ${cwd} ${title}`),
        Promise.resolve({ agentId, conversationId: "conv-7" })
      ),
    } as unknown as ChatBackend;
    const widgets = join(dir, "widgets");
    const started = await startLessonViaChats(chats, { store, widgetsDir: widgets })("l1");
    expect(started).toEqual({ agent_id: "a1", conversation_id: "conv-7" });
    expect(made).toEqual([`a1 ${homedir()} [Learn] · Envelope encryption`]);
    expect((JSON.parse(readFileSync(join(widgets, scopeFor("conv-7", "a1"), "lesson.json"), "utf8")) as { title: unknown }).title).toBe("Envelope encryption");
    expect(store.lessons()[0]).toMatchObject({ agent_id: "a1", conversation_id: "conv-7" });
  });
});

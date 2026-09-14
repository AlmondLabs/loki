import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RecallStore } from "../mod/recall.ts";
import { MAX_OPEN_LEADS, MIN_NEW_CHARS, QUIET_MS, RecallWorker, WRITER_SETTINGS, ensureWriterDir, formatTranscript, lessonCard, overlappingCards, packSlices, scoreStretch } from "../mod/recall-worker.ts";
import type { InboxRow, LocalTranscriptMessage } from "../mod/desks.ts";
import { review } from "../core/recall/fsrs.ts";

// Whole file runs in ~120 ms alone, yet "rejected cards are quoted…" crossed bun's 5 s default twice on a
// loaded machine (a Vite build and a browser beside the suite) — the flaky test the launch review could not
// name. Twenty seconds keeps a real hang visible without failing on a busy runner.
setDefaultTimeout(20_000);

const T0 = new Date("2026-09-10T09:00:00Z").getTime();
const row = (id: string, over: Partial<InboxRow> = {}): InboxRow => ({ id, agentId: "a1", agentName: "ira", title: `desk ${id}`, lastMessageAt: new Date(T0 - QUIET_MS - 1000).toISOString(), archived: false, lastRole: "assistant", lastAssistantText: null, ...over });
const chatter = (n: number): LocalTranscriptMessage[] => [{ role: "user", text: "what does KMS key rotation do in AWS? ".repeat(n) }, { role: "assistant", text: "It re-keys the CMK yearly while keeping old material to decrypt. ".repeat(n) }];

let dir: string;
let store: RecallStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "loki-recall-w-"));
  store = new RecallStore(dir);
  store.saveWorker({ enabled: true }); // off by default; these tests are about a writer that is on
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const logs = (per: Record<string, LocalTranscriptMessage[]>) => (conversationId: string, _a: string | null, from: number) => {
  const rows = per[conversationId] ?? [];
  return { rows: rows.slice(from), lines: rows.length };
};

describe("recall worker", () => {
  test("a quiet conversation with new text is asked once; cards are written, cursor advances, day count grows", async () => {
    const prompts: string[] = [];
    const worker = new RecallWorker({
      store,
      listInbox: () => [row("c1")],
      readSince: logs({ c1: chatter(4) }),
      now: () => T0,
      ask: async (agentId, prompt) => {
        prompts.push(prompt);
        expect(agentId).toBe("a1");
        return '{"cards":[{"front":"What does KMS key rotation do?","back":"Re-keys yearly, keeps old material for decrypting.","tags":["aws"]},{"front":"What does KMS key rotation do in AWS?","back":"dup","tags":[]}],"revisions":[]}';
      },
    });
    const r = await worker.tick();
    expect(r.asked).toBe(1);
    expect(r.written).toBe(1); // the second is a near-duplicate of the first
    const cards = store.cards();
    expect(cards).toHaveLength(1);
    expect(cards[0].card.source).toEqual({ agentId: "a1", agentName: "ira", conversationId: "c1", title: "desk c1", at: row("c1").lastMessageAt });
    expect(cards[0].card.updatedBy).toBe("recall");
    expect(store.worker().cursors["a1/c1"]).toBe(2);
    expect(store.writtenToday(T0)).toBe(1);
    expect(store.worker().lastRunNote).toContain("1 new");
    expect(prompts[0]).toContain("you: what does KMS");
    // nothing new: no second ask
    const again = await worker.tick();
    expect(again.asked).toBe(0);
    expect(again.note).toBe("nothing new");
  });
  test("still-active conversations, the worker's own (today's writer and the old cleared one), and short chatter are not asked", async () => {
    store.saveWorker({ recallConversations: { a1: "mine" }, writers: { a1: "writer" } });
    let asked = 0;
    const worker = new RecallWorker({
      store,
      listInbox: () => [row("busy", { lastMessageAt: new Date(T0 - 1000).toISOString() }), row("mine"), row("writer"), row("short")],
      readSince: logs({ busy: chatter(4), mine: chatter(4), writer: chatter(4), short: [{ role: "user", text: "ok thanks" }] }),
      now: () => T0,
      ask: async () => (asked++, '{"cards":[],"revisions":[]}'),
    });
    const r = await worker.tick();
    expect(asked).toBe(0);
    expect(r.looked).toBe(1);
    expect(store.worker().cursors["a1/short"]).toBe(1); // read and moved past
    expect(store.worker().cursors["a1/busy"]).toBeUndefined();
    expect(worker.owns("mine")).toBe(true);
    expect(worker.owns("writer")).toBe(true);
    expect(worker.owns("short")).toBe(false);
  });

  test("the writer's folder carries Letta's project settings with reflection off, and keeps what else is there", () => {
    const wd = join(dir, "writer");
    expect(ensureWriterDir(wd)).toBe(wd);
    const file = join(wd, ".letta", "settings.local.json");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(WRITER_SETTINGS);
    // Someone set the trigger back on and added a key of their own: the trigger goes off again, the key stays.
    writeFileSync(file, JSON.stringify({ reflectionTrigger: "step-count", theirs: 1 }));
    ensureWriterDir(wd);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ reflectionTrigger: "off", theirs: 1 });
    // Garbage in the file is replaced rather than left to break Letta's read of it.
    writeFileSync(file, "{not json");
    ensureWriterDir(wd);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(WRITER_SETTINGS);
    expect(existsSync(join(wd, ".letta"))).toBe(true);
  });
  test("rejected cards are quoted and never come back; two quiet conversations of one agent go in one call, and the room is shared", async () => {
    store.add({ id: "old", front: "What does KMS key rotation do?", back: "x", tags: [], source: { agentId: "a1", agentName: "ira", conversationId: "c0", title: null, at: null }, createdAt: "2026-09-09T00:00:00Z", updatedAt: "2026-09-09T00:00:00Z", updatedBy: "recall", previous: [] });
    store.reject("old", T0 - 1000);
    store.saveWorker({ dailyCap: 1 });
    let prompt = "";
    const worker = new RecallWorker({
      store,
      listInbox: () => [row("c1"), row("c2", { lastMessageAt: new Date(T0 - QUIET_MS - 5000).toISOString() })],
      readSince: logs({ c1: chatter(4), c2: chatter(4) }),
      now: () => T0,
      ask: async (_a, p) => {
        prompt = p;
        return '{"cards":[{"front":"what does kms key rotation do","back":"back","tags":[]},{"front":"Which service stores session logs?","back":"S3 via SSM.","tags":["aws"]}],"revisions":[]}';
      },
    });
    const r = await worker.tick();
    expect(prompt).toContain("[0 reviews] Q: What does KMS key rotation do?");
    expect(prompt).toContain('<slice id="s1" conversation="desk c1" mode="new"');
    expect(prompt).toContain('<slice id="s2" conversation="desk c2" mode="new"');
    expect(prompt).toContain(`The deck has 0 cards in all. Every card is a file under ${dir}/cards/`);
    expect(store.cards().map((c) => c.card.front)).toEqual(["Which service stores session logs?"]); // the rejected one stayed out
    expect(r.written).toBe(1);
    expect(r.asked).toBe(1); // one call for the agent
    expect(r.slices).toBe(2);
    expect(r.note).toBe("1 new · 0 revised from 2 conversations");
    // Both stretches were read in an uncapped call: both cursors move.
    expect(store.worker().cursors["a1/c2"]).toBe(2);
    expect(store.worker().leadCursors?.["a1/c2"]).toBe(2);
  });

  test("cards and leads land on the conversation their slice names; an unknown label falls back to the first slice; agents get a call each", async () => {
    const prompts: string[] = [];
    const worker = new RecallWorker({
      store,
      listInbox: () => [row("c1"), row("c2", { lastMessageAt: new Date(T0 - QUIET_MS - 5000).toISOString() }), row("c3", { agentId: "a2", agentName: "bo" })],
      readSince: logs({ c1: chatter(4), c2: chatter(4), c3: chatter(4) }),
      now: () => T0,
      ask: async (agentId, p) => {
        prompts.push(p);
        if (agentId === "a2") return '{"cards":[{"slice":"s1","front":"Who is bo?","back":"An agent.","tags":[]}],"revisions":[],"leads":[]}';
        return '{"cards":[{"slice":"s2","front":"Which service stores session logs?","back":"S3 via SSM.","tags":[]},{"slice":"nope","front":"What is a CMK?","back":"A customer master key.","tags":[]}],"revisions":[],"leads":[{"slice":"s2","title":"Envelope encryption","why":"w","depth":"primer"}]}';
      },
    });
    const r = await worker.tick();
    expect(r.asked).toBe(2);
    expect(r.slices).toBe(3);
    expect(r.note).toBe("3 new · 0 revised · 1 lead from 3 conversations in 2 asks");
    const by = Object.fromEntries(store.cards().map((c) => [c.card.front, c.card.source]));
    expect(by["Which service stores session logs?"]).toMatchObject({ agentId: "a1", conversationId: "c2", title: "desk c2" });
    expect(by["What is a CMK?"]).toMatchObject({ agentId: "a1", conversationId: "c1" }); // "nope" → first slice
    expect(by["Who is bo?"]).toMatchObject({ agentId: "a2", agentName: "bo", conversationId: "c3" });
    expect(store.leads()[0].source).toMatchObject({ conversationId: "c2" });
    expect(prompts.filter((p) => p.includes('conversation="desk c3"'))).toHaveLength(1); // the other agent's stretch stays out of a1's call
  });

  test("a replay of the conversation a failing card came from rides along, marked, and yields no new card", async () => {
    store.add({ id: "k1", front: "What does KMS key rotation do?", back: "Rotates keys.", tags: [], source: { agentId: "a1", agentName: "ira", conversationId: "c0", title: "desk c0", at: null }, createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z", updatedBy: "recall", previous: [] });
    store.grade("k1", 3, T0 - 9 * 86_400_000);
    for (const d of [8, 7, 6]) store.grade("k1", 1, T0 - d * 86_400_000);
    let prompt = "";
    const worker = new RecallWorker({
      store,
      listInbox: () => [row("c1")], // c0 is not quiet-with-new-text; it comes back only as a replay
      readSince: logs({ c1: chatter(4), c0: chatter(5) }),
      now: () => T0,
      ask: async (_a, p) => ((prompt = p), '{"cards":[{"slice":"s2","front":"From the replay","back":"x","tags":[]},{"slice":"s1","front":"Which service stores session logs?","back":"S3.","tags":[]}],"revisions":[{"id":"k1","slice":"s2","back":"Creates new key material yearly.","reason":"clearer"}]}'),
    });
    const r = await worker.tick();
    expect(prompt).toContain('<slice id="s2" conversation="desk c0" mode="replay" for="k1"');
    expect(prompt).toContain("here because card k1 keeps failing");
    expect(r.slices).toBe(1); // the replay is not a conversation read
    expect(r.revised).toBe(1);
    expect(store.cards().map((c) => c.card.front).sort()).toEqual(["What does KMS key rotation do?", "Which service stores session logs?"]); // nothing new from the replay
    expect(store.worker().cursors["a1/c0"]).toBeUndefined(); // a replay moves no cursor
  });

  test("slices are packed by score within the budget, the rest wait; cards are quoted only when their words overlap", () => {
    const quiet = [{ role: "assistant", text: "a long monologue ".repeat(40) }] as LocalTranscriptMessage[];
    const lively = [{ role: "user", text: "what is a CMK? why does it rotate? " .repeat(10) }, { role: "assistant", text: "explained ".repeat(20) }] as LocalTranscriptMessage[];
    expect(scoreStretch(lively)).toBeGreaterThan(scoreStretch(quiet));
    expect(scoreStretch([])).toBe(0);
    const picked = packSlices([{ text: "a".repeat(300), score: 1 }, { text: "b".repeat(700), score: 3 }, { text: "c".repeat(500), score: 2 }], 1000);
    expect(picked.map((p) => p.text[0])).toEqual(["b", "a"]); // c would not fit after b; a still does
    expect(packSlices([{ text: "x".repeat(5000), score: 1 }], 100)).toHaveLength(1); // always at least one
    expect(packSlices(Array.from({ length: 12 }, (_, i) => ({ text: "y", score: i })), 1000, 8)).toHaveLength(8);
    const cards = [
      { id: "1", front: "What does KMS key rotation do?", back: "…", tags: [] },
      { id: "2", front: "Which port does Postgres use?", back: "5432", tags: ["postgres"] },
      { id: "3", front: "What is a sprint?", back: "…", tags: ["jira"] },
    ];
    expect(overlappingCards(cards, ["you: is rotation of a KMS key automatic? ira: yes, and jira has nothing to do with it"]).map((c) => c.id)).toEqual(["1", "3"]);
    expect(overlappingCards(cards, ["nothing here"])).toEqual([]);
    expect(overlappingCards(cards, ["postgres port"], 1).map((c) => c.id)).toEqual(["2"]);
  });

  test("with the day's cards written and the lead pile full, nothing is asked and the cursor waits", async () => {
    store.saveWorker({ dailyCap: 0 });
    for (let i = 0; i < MAX_OPEN_LEADS; i++) store.addLead({ id: `l${i}`, title: `topic ${i}`, why: "w", depth: "primer", source: { agentId: "a1", agentName: "ira", conversationId: "c0", title: null, at: null }, createdAt: new Date(T0).toISOString() });
    let asked = 0;
    const worker = new RecallWorker({ store, listInbox: () => [row("c1")], readSince: logs({ c1: chatter(4) }), now: () => T0, ask: async () => ((asked += 1), '{"cards":[],"revisions":[],"leads":[]}') });
    const r = await worker.tick();
    expect(asked).toBe(0);
    expect(r.note).toBe("daily cap reached");
    expect(store.worker().cursors["a1/c1"]).toBeUndefined();
  });
  test("revisions rewrite an existing card and keep the old wording; failing cards are offered for a rewrite", async () => {
    store.add({ id: "k1", front: "What does KMS key rotation do?", back: "Rotates keys.", tags: [], source: { agentId: "a1", agentName: "ira", conversationId: "c0", title: null, at: null }, createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z", updatedBy: "recall", previous: [] });
    let s = store.card("k1")!.schedule;
    for (const [g, t] of [[3, 1], [1, 2], [1, 3], [1, 4]] as const) s = review(s, g, T0 - (10 - t) * 86_400_000);
    // write the failing schedule straight to disk through grade calls is awkward; use the store's own grading path instead
    store.grade("k1", 3, T0 - 9 * 86_400_000);
    store.grade("k1", 1, T0 - 8 * 86_400_000);
    store.grade("k1", 1, T0 - 7 * 86_400_000);
    store.grade("k1", 1, T0 - 6 * 86_400_000);
    let prompt = "";
    const worker = new RecallWorker({
      store,
      listInbox: () => [row("c1")],
      readSince: logs({ c1: chatter(4) }),
      now: () => T0,
      ask: async (_a, p) => {
        prompt = p;
        return '{"cards":[],"revisions":[{"id":"k1","back":"Creates new key material yearly; old material stays to decrypt.","reason":"clearer"},{"id":"nope","back":"x","reason":"?"}]}';
      },
    });
    const r = await worker.tick();
    expect(prompt).toContain("keeps failing");
    expect(prompt).toContain("k1: Q: What does KMS key rotation do?");
    expect(r.revised).toBe(1);
    const c = store.card("k1")!;
    expect(c.card.back).toContain("Creates new key material");
    expect(c.card.previous[0].back).toBe("Rotates keys.");
    expect(c.schedule.reps).toBe(4); // untouched
  });
  test("a model failure leaves the cursor so the next tick retries; the worker can be switched off", async () => {
    const worker = new RecallWorker({ store, listInbox: () => [row("c1")], readSince: logs({ c1: chatter(4) }), now: () => T0, ask: async () => { throw new Error("boom"); } });
    const r = await worker.tick();
    expect(r.asked).toBe(1);
    expect(r.written).toBe(0);
    expect(r.note).toContain("boom");
    expect(store.worker().cursors["a1/c1"]).toBeUndefined();
    store.saveWorker({ enabled: false });
    expect((await worker.tick()).note).toBe("off");
  });
  test("formatTranscript keeps only what was said", () => {
    const t = formatTranscript([{ role: "user", text: " hi " }, { role: "tool", text: "Read x" }, { role: "event", text: "compacted" }, { role: "assistant", text: "hello" }], "ira");
    expect(t).toBe("you: hi\nira: hello");
    expect(MIN_NEW_CHARS).toBeGreaterThan(t.length);
  });
});

describe("learning leads", () => {
  test("leads come back with the cards, near-duplicates of open, started or dismissed leads are dropped, and the pile is capped", async () => {
    store.addLead({ id: "open1", title: "KMS key rotation", why: "w", depth: "primer", source: { agentId: "a1", agentName: "ira", conversationId: "c0", title: null, at: null }, createdAt: new Date(T0).toISOString() });
    store.addLead({ id: "d1", title: "Kubernetes networking", why: "w", depth: "course", source: { agentId: "a1", agentName: "ira", conversationId: "c0", title: null, at: null }, createdAt: new Date(T0).toISOString() });
    store.dismissLead("d1", T0);
    const prompts: string[] = [];
    const worker = new RecallWorker({
      store,
      listInbox: () => [row("c1")],
      readSince: logs({ c1: chatter(4) }),
      now: () => T0,
      ask: async (_a, prompt) => {
        prompts.push(prompt);
        return '{"cards":[],"revisions":[],"leads":[{"title":"KMS key rotation in AWS","why":"same as the open one","depth":"primer"},{"title":"Envelope encryption","why":"you asked what a data key was","depth":"course"}]}';
      },
    });
    const r = await worker.tick();
    expect(r.leads).toBe(1);
    expect(r.note).toContain("1 lead");
    const leads = store.leads();
    expect(leads.map((l) => l.title).sort()).toEqual(["Envelope encryption", "KMS key rotation"]);
    const added = leads.find((l) => l.title === "Envelope encryption")!;
    expect(added.depth).toBe("course");
    expect(added.source).toMatchObject({ agentId: "a1", conversationId: "c1", title: "desk c1" });
    expect(prompts[0]).toContain("- KMS key rotation");
    expect(prompts[0]).toContain("- Kubernetes networking");
  });
  test("a full card day still finds leads: the prompt asks for none, leads are written, and tomorrow's card pass reads the same stretch", async () => {
    store.saveWorker({ dailyCap: 1, written: { day: new Date(T0).toISOString().slice(0, 10), count: 1 } });
    const prompts: string[] = [];
    const reply = '{"cards":[{"front":"Which service stores session logs?","back":"S3 via SSM.","tags":[]}],"revisions":[],"leads":[{"title":"Envelope encryption","why":"you asked what a data key was","depth":"primer"}]}';
    const worker = new RecallWorker({ store, listInbox: () => [row("c1")], readSince: logs({ c1: chatter(4) }), now: () => T0, ask: async (_a, p) => (prompts.push(p), reply) });
    const r = await worker.tick();
    expect(prompts[0]).toContain("write no new cards this time");
    expect(prompts[0]).toContain('"leads"');
    expect(r.written).toBe(0);
    expect(r.leads).toBe(1);
    expect(r.note).toBe("0 new · 0 revised · 1 lead from 1 conversation · cards at the day's cap");
    expect(store.leads().map((l) => l.title)).toEqual(["Envelope encryption"]);
    expect(store.worker().cursors["a1/c1"]).toBeUndefined();
    expect(store.worker().leadCursors?.["a1/c1"]).toBe(2);
    // The same stretch, once the lead cursor is ahead, is not read again for leads today.
    expect((await worker.tick()).asked).toBe(0);
    // Tomorrow: the card pass starts at the card cursor, writes the card, and the lead is not written twice.
    const tomorrow = new RecallWorker({ store, listInbox: () => [row("c1")], readSince: logs({ c1: chatter(4) }), now: () => T0 + 86_400_000, ask: async (_a, p) => (prompts.push(p), reply) });
    const t = await tomorrow.tick();
    expect(prompts[1]).toContain("at most 1 new card");
    expect(t.written).toBe(1);
    expect(t.leads).toBe(0);
    expect(store.worker().cursors["a1/c1"]).toBe(2);
  });
  test("a full pile asks for no leads and writes none", async () => {
    for (let i = 0; i < MAX_OPEN_LEADS; i++) store.addLead({ id: `l${i}`, title: `topic ${i}`, why: "w", depth: "primer", source: { agentId: "a1", agentName: "ira", conversationId: "c0", title: null, at: null }, createdAt: new Date(T0).toISOString() });
    let prompt = "";
    const worker = new RecallWorker({ store, listInbox: () => [row("c1")], readSince: logs({ c1: chatter(4) }), now: () => T0, ask: async (_a, p) => ((prompt = p), '{"cards":[],"revisions":[],"leads":[{"title":"One more","why":"w","depth":"primer"}]}') });
    const r = await worker.tick();
    expect(prompt).not.toContain('"leads"');
    expect(r.leads).toBe(0);
    expect(store.leads()).toHaveLength(MAX_OPEN_LEADS);
  });
});

describe("a lesson's first widget", () => {
  test("the info card carries the lead: depth, where it came up, the moment, and who lays the lesson out", () => {
    const card = lessonCard({ id: "l1", title: "Envelope encryption", why: "you asked what a data key was", depth: "primer", source: { agentId: "a1", agentName: "ira", conversationId: "c1", title: "[Long] - KMS", at: null }, createdAt: "2026-09-13T00:00:00Z" });
    expect(card.type).toBe("info-card");
    expect(card.title).toBe("Envelope encryption");
    expect(card.data.lines).toEqual(["a primer — one sitting", 'it came up in "[Long] - KMS" with ira', "you asked what a data key was", "ira lays the lesson out here; the chat opens with the brief"]);
    expect(lessonCard({ id: "l2", title: "T", why: "w", depth: "course", source: { agentId: "a1", agentName: null, conversationId: "c1", title: null, at: null }, createdAt: "2026-09-13T00:00:00Z" }).data.lines.slice(0, 2)).toEqual(["a course — a few sittings", "it came up in a conversation with the agent"]);
  });
});

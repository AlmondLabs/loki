import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RecallStore } from "../mod/recall.ts";
import { MIN_NEW_CHARS, QUIET_MS, RecallWorker, formatTranscript } from "../mod/recall-worker.ts";
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
  test("still-active conversations, the worker's own, and short chatter are not asked", async () => {
    store.saveWorker({ recallConversations: { a1: "mine" } });
    let asked = 0;
    const worker = new RecallWorker({
      store,
      listInbox: () => [row("busy", { lastMessageAt: new Date(T0 - 1000).toISOString() }), row("mine"), row("short")],
      readSince: logs({ busy: chatter(4), mine: chatter(4), short: [{ role: "user", text: "ok thanks" }] }),
      now: () => T0,
      ask: async () => (asked++, '{"cards":[],"revisions":[]}'),
    });
    const r = await worker.tick();
    expect(asked).toBe(0);
    expect(r.looked).toBe(1);
    expect(store.worker().cursors["a1/short"]).toBe(1); // read and moved past
    expect(store.worker().cursors["a1/busy"]).toBeUndefined();
    expect(worker.owns("mine")).toBe(true);
  });
  test("rejected cards are quoted and never come back; the daily cap holds the cursor", async () => {
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
    expect(store.cards().map((c) => c.card.front)).toEqual(["Which service stores session logs?"]); // the rejected one stayed out
    expect(r.written).toBe(1);
    expect(r.note).toBe("daily cap reached");
    expect(store.worker().cursors["a1/c2"]).toBeUndefined(); // waits for tomorrow
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

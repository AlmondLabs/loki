import { afterEach, describe, expect, test, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SetStateAction } from "react";
import type { AttentionItem } from "../core/attention/model.ts";
import { idOf, mergeQueue, type Decision } from "../core/attention/queue.ts";
import type { MoveResult, OutsideReplyResult } from "../core/attention/use-attention.ts";
import type { ReplyThen } from "../core/frame-types.ts";
import { opensChat } from "../app/src/desk/use-deck-keys.ts";
import { FLASH_MS, createFlash } from "../app/src/desk/use-deck-actions.ts";
import { EMPTY_REPLY, cardKey, createDeckMoves, type PickerKind, type ReplyBox } from "../app/src/desk/deck-moves.ts";
import { LATER_MAX_DAYS, dateChoice, returnChoices } from "../app/src/desk/return-picker.tsx";
import { pickableLabels } from "../app/src/desk/label-picker.tsx";
import { COMMIT_REST_MS, createListSelection } from "../app/src/shell/list-keys.ts";
import { replyBoxKey } from "../app/src/desk/outside-card.tsx";
import { attentionItem } from "./fixtures/attention.ts";
import { jiraItem, outsideItem } from "./fixtures/outside-item.ts";
import { must } from "./fixtures/must.ts";

/** The desktop deck's keys (app/src/desk/use-deck-keys.ts, deck-moves.ts): what each press does to the selected card. */

describe("Esc and focus in Flow (plan 2026-11-14-1330, KTD7, KTD14)", () => {
  const source = (...path: string[]) => readFileSync(join(import.meta.dirname, "..", "app", "src", ...path), "utf8");
  test("Esc in the list does not leave Flow: the deck has no Esc of its own, the reply box's hands the keys back, and the shell's skips Flow", () => {
    expect(source("desk", "use-deck-keys.ts")).not.toContain("Escape");
    const deck = source("desk", "catch-up.tsx");
    expect(deck).not.toMatch(/onEscapeEmpty=\{(deck\.)?onClose\}/);
    expect(deck).toContain("onEscapeEmpty={leaveBox}");
    expect(source("shell", "use-shell-keys.ts")).not.toMatch(/segment === "inbox"[^\n]*\n[^\n]*toDesk/);
  });
  test("a new selection never focuses the reply box on its own; R or a click does", () => {
    const deck = source("desk", "catch-up.tsx");
    expect(deck).not.toContain("setTimeout(() => replyRef.current?.focus()");
    expect(source("desk", "use-deck-keys.ts")).toContain('case "reply":\n        return replyRef.current?.focus();');
  });
});

describe("O on a card", () => {
  test("a chat's card opens its chat", () => {
    expect(opensChat(attentionItem("c1"))).toBe(true);
  });
  test("an email or Slack thread has no chat to open, so O does nothing and the deck stays", () => {
    expect(opensChat(outsideItem("Quarterly numbers"))).toBe(false);
  });
  test("with no card up there is nothing to open", () => {
    expect(opensChat(undefined)).toBe(false);
  });
});

const DONE: MoveResult = { error: null, ask: false, rest: null };
const settle = () => new Promise<void>((r) => setImmediate(r));

/** A deck with `queue` up and its first row selected, recording every call its moves make. */
function deck(
  queue: AttentionItem[],
  over: {
    /** Archive's answer out there: the reason when it refused. */
    archive?: string | null;
    /** The selected card was answered elsewhere (R11): the deck hands the moves no card. */
    elsewhere?: boolean;
    asks?: boolean;
    text?: string;
    reply?: OutsideReplyResult | Promise<OutsideReplyResult>;
    read?: MoveResult;
    /** Mail replies are held for their undo (plan 076): what stopping one answers. */
    unsend?: (outboxId: string) => boolean;
    /** The host's notices; absent, refusals flash on the badge. */
    notices?: string[];
    later?: MoveResult;
  } = {},
) {
  const calls: Array<[string, ...unknown[]]> = [];
  const first = queue.at(0);
  const firstId = first ? idOf(first) : "";
  const state = {
    queue,
    selected: null as string | null,
    decided: [] as Decision[],
    flash: [] as string[],
    picker: null as PickerKind | null,
    /** The card the open picker is on. */
    pickerId: null as string | null,
    /** The one full reply box, as the deck holds it: the first row's to begin with. */
    box: { ...EMPTY_REPLY, text: over.text ?? "" },
    boxId: firstId,
    /** The words left in every card's box, kept by id as the session keeps them. */
    texts: new Map<string, string>([[firstId, over.text ?? ""]]),
    /** The cards whose reply is on its way. */
    sending: new Set<string>(),
  };
  const apply = <T>(v: SetStateAction<T>, old: T): T => (typeof v === "function" ? (v as (o: T) => T)(old) : v);
  /** The selected card: the one picked, else the first row, as the deck falls back. */
  const selected = () => state.queue.find((i) => idOf(i) === state.selected) ?? state.queue.at(0);
  /** A card's reply box, as useDeckActions resolves it: the full box when it is that card's, else its kept words. */
  const replyOf = (id: string) => {
    const base = id === state.boxId ? state.box : { ...EMPTY_REPLY, text: state.texts.get(id) ?? "" };
    return { ...base, busy: state.sending.has(id) };
  };
  /** Write to a card's box, as the deck's setReply does: another card's box replaces the one held. */
  const setReply = (id: string, patch: Partial<ReplyBox>) => {
    if (patch.text !== undefined) state.texts.set(id, patch.text);
    if (id !== state.boxId) {
      state.boxId = id;
      state.box = { ...EMPTY_REPLY, text: state.texts.get(id) ?? "" };
    }
    state.box = { ...state.box, ...patch };
  };
  const moves = () =>
    createDeckMoves({
      selected: over.elsewhere ? () => undefined : selected,
      queue: state.queue,
      select: (id) => (state.selected = id),
      decided: state.decided,
      lane: null,
      replyOf,
      setReply,
      setSending: (id: string, on: boolean) => (on ? state.sending.add(id) : state.sending.delete(id)),
      setDecided: (v) => (state.decided = apply(v, state.decided)),
      setQueue: (v) => (state.queue = apply(v, state.queue)),
      say: (w) => state.flash.push(w),
      ...(over.notices ? { notice: (_item: AttentionItem, w: string) => over.notices?.push(w) } : {}),
      setDir: () => {},
      pick: (id: string, k: PickerKind | null) => ((state.picker = k), (state.pickerId = k ? id : null)),
      sent: () => calls.push(["sent"]),
      newId: () => "o1",
      moves: {
        read: (item) => (calls.push(["read", item.id]), Promise.resolve(over.read ?? DONE)),
        later: (item, until) => (calls.push(["later", item.id, until]), Promise.resolve(over.later ?? DONE)),
        laterAsks: () => over.asks ?? false,
        archive: (item) => (calls.push(["archive", item.id]), Promise.resolve(over.archive ?? null)),
        label: (item, ids) => (calls.push(["label", item.id, ids]), Promise.resolve(null)),
        undo: (item) => (calls.push(["undo", item.id]), Promise.resolve(null)),
        replyOutside: (item, text: string, then: ReplyThen, extra) => (
          calls.push(extra?.outbox_id || extra?.thread_ts ? ["reply", item.id, text, then, extra] : ["reply", item.id, text, then]),
          Promise.resolve(over.reply ?? { sent: true, error: null })
        ),
        ...(over.unsend
          ? {
              unsendOutside: (item: AttentionItem, outboxId: string) => {
                calls.push(["unsend", item.id, outboxId]);
                return Promise.resolve(over.unsend?.(outboxId) ?? false);
              },
            }
          : {}),
        seen: () => {},
        unread: () => {},
        approve: () => {},
      },
    });
  /** Select the row `id` names, as a click or the arrows commit it. */
  const select = (id: string) => (state.selected = `a1/${id}`);
  const shown = () => selected()?.id;
  /** Type into the box of the card `cardId` names, as the person does once it is selected. */
  const type = (cardId: string, text: string) => setReply(cardId, { text });
  return { state, calls, moves, select, shown, type };
}

describe("the selected card (R9)", () => {
  const abc = () => [attentionItem("a"), attentionItem("b"), attentionItem("c")];
  test("a move acts on the selected card, closes the gap, and selects the row below; the rows above keep their places", async () => {
    const d = deck(abc());
    d.select("b");
    d.moves().read();
    await settle();
    expect(d.calls).toEqual([["read", "b"]]);
    expect(d.state.queue.map((i) => i.id)).toEqual(["a", "c"]);
    expect(d.shown()).toBe("c");
  });
  test("Read on the last row selects the row above", async () => {
    const d = deck(abc());
    d.select("c");
    d.moves().read();
    await settle();
    expect(d.state.queue.map((i) => i.id)).toEqual(["a", "b"]);
    expect(d.shown()).toBe("b");
  });
  test("a refused Archive brings the card back selected, at its old place", async () => {
    const d = deck(abc(), { archive: "Gmail refused" });
    d.select("b");
    d.moves().archive();
    expect(d.shown()).toBe("c");
    await settle();
    expect(d.state.queue.map((i) => i.id)).toEqual(["a", "b", "c"]);
    expect(d.shown()).toBe("b");
    expect(d.state.decided).toEqual([]);
  });
  test("Undo selects the card it restores, at its old place", async () => {
    const d = deck(abc());
    d.select("c");
    d.moves().later();
    await settle();
    expect(d.shown()).toBe("b");
    d.moves().undo();
    await settle();
    expect(d.state.queue.map((i) => i.id)).toEqual(["a", "b", "c"]);
    expect(d.shown()).toBe("c");
  });
  test("Approve answers the selected approval and selects the row below", () => {
    const asks = attentionItem("b", { status: "approval", pendingApproval: { requestId: "p1", toolName: "Bash", input: {}, at: "2026-09-05T10:00:00Z" } });
    const d = deck([attentionItem("a"), asks, attentionItem("c")]);
    d.select("b");
    d.moves().approve("allow");
    expect(d.state.queue.map((i) => i.id)).toEqual(["a", "c"]);
    expect(d.shown()).toBe("c");
    expect(d.state.decided.map((x) => [x.item.id, x.via])).toEqual([["b", "approve"]]);
  });
  test("Covers AE2. a selected card answered elsewhere is no card to act on: every move does nothing (R11)", async () => {
    const d = deck(abc(), { elsewhere: true });
    d.select("b");
    const m = d.moves();
    m.read();
    m.later();
    m.archive();
    m.approve("allow");
    await settle();
    expect(d.calls).toEqual([]);
    expect(d.state.queue.map((i) => i.id)).toEqual(["a", "b", "c"]);
  });
  test("Covers AE1. Read on B, with D just arrived under it, selects D", async () => {
    const a = attentionItem("a", { score: 5 }),
      b = attentionItem("b", { score: 3 }),
      c = attentionItem("c", { score: 1 }),
      dd = attentionItem("d", { score: 50 });
    const d = deck(mergeQueue([a, b, c], [a, b, c, dd], [], { selectedId: "a1/b" }));
    d.select("b");
    d.moves().read();
    await settle();
    expect(d.state.queue.map((i) => i.id)).toEqual(["a", "d", "c"]);
    expect(d.shown()).toBe("d");
  });
  test("Covers AE4. E pressed within the arrows' rest archives the newly highlighted card", () => {
    const d = deck(abc());
    const jobs: Array<() => void> = [];
    const sel = createListSelection({
      committed: () => d.state.selected ?? "a1/a",
      commit: (id) => (d.state.selected = id),
      focusDetail: () => {},
      onHighlight: () => {},
      schedule: (run, ms) => (expect(ms).toBe(COMMIT_REST_MS), jobs.push(run), () => {}),
    });
    sel.press(["a1/a", "a1/b", "a1/c"], "down");
    expect(d.shown()).toBe("a");
    sel.act(() => d.moves().archive());
    expect(d.calls).toEqual([["archive", "b"]]);
    expect(d.state.queue.map((i) => i.id)).toEqual(["a", "c"]);
  });
  /** Two outside cards: A, with words in its box, drawn first; and B, another thread of the same account. */
  const twoThreads = () => {
    const a = outsideItem("A");
    const b = outsideItem("B", { id: "t2#1", outside: { ...must(a.outside, "facts"), thread_id: "t2", subject: "B" } });
    return { a, b };
  };
  test("Covers AE4. a move on a newly highlighted card reads that card's box, never the drawn card's words", async () => {
    const { a, b } = twoThreads();
    const d = deck([a, b], { text: "For A only" });
    // The moves were made while A was drawn; the highlight commits B in the same event as the key.
    const m = d.moves();
    d.state.selected = idOf(b);
    m.archive();
    await settle();
    expect(d.calls).toEqual([["archive", "t2#1"]]);
    expect(d.state.texts.get(idOf(a))).toBe("For A only");
  });
  test("Covers AE4. a second Later on a newly highlighted card opens its picker on that card", () => {
    const { a, b } = twoThreads();
    const d = deck([a, b], { asks: true });
    const m = d.moves();
    d.state.selected = idOf(b);
    m.later();
    expect(d.state.picker).toBe("later");
    expect(d.state.pickerId).toBe(idOf(b));
  });
  test("a card whose reply is on its way refuses its moves after the person typed on another card and came back", async () => {
    const { a, b } = twoThreads();
    const slack = (i: AttentionItem): AttentionItem => ({ ...i, outside: { ...must(i.outside, "facts"), provider: "slack" } });
    let finish: (r: OutsideReplyResult) => void = () => {};
    const pending = new Promise<OutsideReplyResult>((r) => (finish = r));
    const d = deck([slack(a), slack(b)], { text: "on it", reply: pending });
    d.moves().read();
    // While it goes, the person selects B and types there, then comes back to A and presses ⌘] again.
    d.state.selected = idOf(b);
    d.type(idOf(b), "h");
    d.state.selected = idOf(a);
    d.moves().read();
    d.moves().archive();
    d.moves().later();
    d.moves().sendReply();
    finish({ sent: true, error: null });
    await settle();
    expect(d.calls.filter((c) => c[0] === "reply")).toEqual([["reply", "t1#1", "on it", "read"]]);
  });
});

describe("⌘] and ⌘[ on a card", () => {
  test("⌘[ on a chat card calls the later move and the card goes, flashing later", async () => {
    const d = deck([attentionItem("c1"), attentionItem("c2")]);
    d.moves().later();
    await settle();
    expect(d.calls).toEqual([["later", "c1", undefined]]);
    expect(d.state.queue.map((i) => i.id)).toEqual(["c2"]);
    expect(d.state.flash).toEqual(["Later"]);
  });
  test("⌘] reads the card; a refusal out there brings it back on top with the reason", async () => {
    const d = deck([outsideItem("Lunch"), attentionItem("c2")], { read: { error: "Gmail refused", ask: false, rest: null } });
    d.moves().read();
    expect(d.state.queue.map((i) => i.id)).toEqual(["c2"]);
    await settle();
    expect(d.state.queue.map((i) => i.id)).toEqual(["t1#1", "c2"]);
    expect(d.state.decided).toEqual([]);
    expect(d.state.flash).toEqual(["Read", "Not marked read: Gmail refused"]);
  });
  test("⌘] with text in the reply box sends the reply with read, clears the box, and the card moves on", async () => {
    const d = deck([outsideItem("Lunch"), attentionItem("c2")], { text: "Thursday works" });
    d.moves().read();
    await settle();
    expect(d.calls).toEqual([["reply", "t1#1", "Thursday works", "read"], ["sent"]]);
    expect(d.state.box.text).toBe("");
    expect(d.state.queue.map((i) => i.id)).toEqual(["c2"]);
  });
  test("a reply sent whose move failed keeps the card with the error, and is never sent again", async () => {
    const d = deck([outsideItem("Lunch")], { text: "Thursday works", reply: { sent: true, error: "could not mark it read" } });
    d.moves().later();
    await settle();
    expect(d.state.box).toEqual({ text: "", mail: null, busy: false, error: "could not mark it read" });
    expect(d.state.queue.map((i) => i.id)).toEqual(["t1#1"]);
    d.moves().later();
    await settle();
    expect(d.calls.filter((c) => c[0] === "reply")).toHaveLength(1);
  });
  test("⌘Enter in a mail's box sends it held for its undo, and the card stays on top (plan 083)", async () => {
    const d = deck([outsideItem("Lunch"), attentionItem("c2")], { text: "ok", unsend: () => true });
    d.moves().sendReply();
    expect(d.state.box).toMatchObject({ text: "", held: { outbox_id: "o1", text: "ok", mail: null } });
    await settle();
    expect(d.calls).toEqual([["reply", "t1#1", "ok", "stay", { mail: null, outbox_id: "o1" }], ["sent"]]);
    expect(d.state.box.held).toBeNull();
    expect(d.state.queue.map((i) => i.id)).toEqual(["t1#1", "c2"]);
    expect(d.state.decided).toEqual([]);
    expect(d.state.flash).toEqual(["Sending · z undo", "Sent"]);
  });
  test("Z while a mail sent alone waits stops it and puts the words back, the card where it was", async () => {
    let finish: (r: OutsideReplyResult) => void = () => {};
    const waiting = new Promise<OutsideReplyResult>((r) => (finish = r));
    const d = deck([outsideItem("Lunch"), attentionItem("c2")], { text: "ok", unsend: () => true, reply: waiting });
    d.moves().sendReply();
    d.moves().undo();
    await settle();
    expect(d.calls).toContainEqual(["unsend", "t1#1", "o1"]);
    expect(d.state.box).toMatchObject({ text: "ok", held: null, error: null });
    finish({ sent: false, error: null, undone: true });
    await settle();
    expect(d.state.box.text).toBe("ok");
    expect(d.state.queue.map((i) => i.id)).toEqual(["t1#1", "c2"]);
    expect(d.state.flash).toEqual(["Sending · z undo", "Not sent"]);
  });
  test("Enter in a Slack card's box only sends: the card stays on top for the person's own next move (plan 083)", async () => {
    const lunch = outsideItem("Lunch");
    const slack = { ...lunch, outside: lunch.outside ? { ...lunch.outside, provider: "slack" as const, account_id: "slack:T1:U1" } : undefined };
    const d = deck([slack, attentionItem("c2")], { text: "on it" });
    d.moves().sendReply();
    await settle();
    expect(d.calls).toEqual([["reply", "t1#1", "on it", "stay"], ["sent"]]);
    expect(d.state.box.text).toBe("");
    expect(d.state.queue.map((i) => i.id)).toEqual(["t1#1", "c2"]);
    expect(d.state.decided).toEqual([]);
    expect(d.state.flash).toEqual(["Sent"]);
  });
  test("a reply on a Slack card goes into the thread opened on it, after a newer message too, and not on another card (plans 085, 090)", async () => {
    const lunch = outsideItem("Lunch");
    const slack = { ...lunch, outside: lunch.outside ? { ...lunch.outside, provider: "slack" as const, account_id: "slack:T1:U1" } : undefined };
    const d = deck([slack], { text: "on it" });
    d.state.box = { ...d.state.box, thread: { key: cardKey(slack), ts: "7.0" } };
    d.moves().sendReply();
    await settle();
    expect(d.calls[0]).toEqual(["reply", "t1#1", "on it", "stay", { mail: null, thread_ts: "7.0" }]);
    // A newer message, the person's own reply among them, is the same card: the thread stays open.
    const newer = { ...slack, outside: slack.outside ? { ...slack.outside, newest_message_id: "9.0" } : undefined };
    expect(cardKey(newer)).toBe(cardKey(slack));
    d.state.box = { ...d.state.box, text: "again", thread: { key: "another card", ts: "7.0" } };
    d.moves().read();
    await settle();
    expect(d.calls.filter((c) => c[0] === "reply")[1]).toEqual(["reply", "t1#1", "again", "read"]);
  });
  test("the second ⌘[ on the same card opens the picker; picking tomorrow rests it until tomorrow", async () => {
    const d = deck([outsideItem("Lunch"), attentionItem("c2")], { asks: true });
    d.moves().later();
    expect(d.state.picker).toBe("later");
    expect(d.calls).toEqual([]);
    expect(d.state.queue.map((i) => i.id)).toEqual(["t1#1", "c2"]);
    const now = new Date(2026, 10, 5, 14, 30);
    const tomorrow = must(
      returnChoices(now).find((c) => c.id === "tomorrow"),
      "tomorrow",
    );
    expect(tomorrow.at).toEqual(new Date(2026, 10, 6, 9, 0));
    d.moves().pickLater(tomorrow.at.toISOString());
    await settle();
    expect(d.calls).toEqual([["later", "t1#1", tomorrow.at.toISOString()]]);
    expect(d.state.picker).toBeNull();
    expect(d.state.queue.map((i) => i.id)).toEqual(["c2"]);
  });
});

describe("a mail reply held for its undo (plan 076)", () => {
  /** A reply that answers when the test says. */
  const later = () => {
    let answer: (r: OutsideReplyResult) => void = () => {};
    const reply = new Promise<OutsideReplyResult>((r) => (answer = r));
    return { reply, answer: (r: OutsideReplyResult) => answer(r) };
  };
  test("⌘] moves the card on at once, empties the box, and holds the reply with its addressing and id", async () => {
    const r = later();
    const d = deck([outsideItem("Lunch"), attentionItem("c2")], { text: "Thursday works", reply: r.reply, unsend: () => true });
    d.state.box = { ...d.state.box, mail: { mode: "reply", to: ["grace@acme.com"], cc: [], bcc: [], from: null, signature: true } };
    d.moves().read();
    expect(d.state.queue.map((i) => i.id)).toEqual(["c2"]);
    expect(d.state.box.text).toBe("");
    expect(d.state.flash).toEqual(["Sending · z undo"]);
    expect(d.state.decided.map((x) => x.held?.outbox_id)).toEqual(["o1"]);
    expect(d.calls[0]).toEqual([
      "reply",
      "t1#1",
      "Thursday works",
      "read",
      { mail: { mode: "reply", to: ["grace@acme.com"], cc: [], bcc: [], from: null, signature: true }, outbox_id: "o1" },
    ]);
    r.answer({ sent: true, error: null });
    await settle();
    // Sent: the decision is an ordinary one now, so Z takes back the read and not the reply.
    expect(d.state.decided.map((x) => x.held)).toEqual([undefined]);
    expect(d.state.flash).toEqual(["Sending · z undo", "Sent"]);
  });
  test("Z while it is held stops it, and the card comes back with the words and addressing in its box", async () => {
    const r = later();
    const d = deck([outsideItem("Lunch"), attentionItem("c2")], { text: "Thursday works", reply: r.reply, unsend: () => true });
    d.moves().read();
    d.moves().undo();
    await settle();
    r.answer({ sent: false, error: null, undone: true });
    await settle();
    expect(d.calls.filter((c) => c[0] === "unsend")).toEqual([["unsend", "t1#1", "o1"]]);
    expect(d.state.queue.map((i) => i.id)).toEqual(["t1#1", "c2"]);
    expect(d.state.decided).toEqual([]);
    expect(d.state.box).toMatchObject({ text: "Thursday works", mail: null, error: null });
    expect(d.state.flash.at(-1)).toBe("Not sent");
  });
  test("Z after it went says so and leaves the card where it is", async () => {
    const r = later();
    const d = deck([outsideItem("Lunch"), attentionItem("c2")], { text: "ok", reply: r.reply, unsend: () => false });
    d.moves().read();
    d.moves().undo();
    await settle();
    expect(d.state.queue.map((i) => i.id)).toEqual(["c2"]);
    expect(d.state.flash.at(-1)).toBe("Already sent");
  });
  test("a send that fails brings the card back on top with the words and the reason", async () => {
    const d = deck([outsideItem("Lunch"), attentionItem("c2")], { text: "ok", reply: { sent: false, error: "Gmail refused it" }, unsend: () => true });
    d.moves().archive();
    await settle();
    expect(d.state.queue.map((i) => i.id)).toEqual(["t1#1", "c2"]);
    expect(d.state.decided).toEqual([]);
    expect(d.state.box).toMatchObject({ text: "ok", error: "Gmail refused it" });
    expect(d.state.flash.at(-1)).toBe("Not sent");
  });
  test("a Slack card's reply is never held: it goes at once, as before", async () => {
    const slack = outsideItem("Lunch");
    const item = { ...slack, outside: slack.outside && { ...slack.outside, provider: "slack" as const } };
    const d = deck([item], { text: "ok", unsend: () => true });
    d.moves().read();
    await settle();
    expect(d.calls[0]).toEqual(["reply", "t1#1", "ok", "read"]);
  });
});

describe("⌘E and L", () => {
  test("AE6: ⌘E on a main chat springs back with main chats stay", () => {
    const d = deck([attentionItem("default")]);
    d.moves().archive();
    expect(d.calls).toEqual([]);
    expect(d.state.queue.map((i) => i.id)).toEqual(["default"]);
    expect(d.state.flash).toEqual(["Main chats stay"]);
  });
  test("⌘E with text sends it, then archives", async () => {
    const d = deck([outsideItem("Lunch")], { text: "done, thanks" });
    d.moves().archive();
    await settle();
    expect(d.calls[0]).toEqual(["reply", "t1#1", "done, thanks", "archive"]);
    expect(d.state.flash).toEqual(["Archived"]);
  });
  test("AE8: L on an email card opens the labels; picking Clients adds it and the card stays", async () => {
    const d = deck([outsideItem("Lunch"), attentionItem("c2")]);
    d.moves().label();
    expect(d.state.picker).toBe("label");
    expect(await d.moves().pickLabels(["Label_7"])).toBeNull();
    expect(d.calls).toEqual([["label", "t1#1", ["Label_7"]]]);
    expect(d.state.picker).toBeNull();
    expect(d.state.queue.map((i) => i.id)).toEqual(["t1#1", "c2"]);
    expect(d.state.flash).toEqual(["Labelled"]);
  });
  test("L on a chat card, or a Slack card, does nothing", () => {
    const chat = deck([attentionItem("c1")]);
    chat.moves().label();
    expect(chat.state.picker).toBeNull();
    const base = outsideItem("x");
    const slack = deck([{ ...base, outside: { ...must(base.outside, "facts"), provider: "slack" } }]);
    slack.moves().label();
    expect(slack.state.picker).toBeNull();
  });
  test("the label picker offers the account's own labels, by name, not Gmail's system ones", () => {
    expect(
      pickableLabels([
        { id: "INBOX", name: "INBOX", type: "system" },
        { id: "Label_7", name: "Clients", type: "user" },
        { id: "Label_2", name: "Accounts", type: "user" },
      ]).map((l) => l.name),
    ).toEqual(["Accounts", "Clients"]);
  });
});

describe("⌘E and L on a Jira card (plan 2026-11-10-1451, U6)", () => {
  test("Covers AE8. ⌘E leaves it on top, says why, and sends nothing, even with text in its box", async () => {
    const d = deck([jiraItem(), attentionItem("c2")], { text: "on it" });
    d.moves().archive();
    await settle();
    expect(d.calls).toEqual([]);
    expect(d.state.queue.map((i) => i.id)).toEqual(["10001#1", "c2"]);
    expect(d.state.decided).toEqual([]);
    expect(d.state.box.text).toBe("on it");
    expect(d.state.flash).toEqual(["A Jira card ends with read"]);
  });
  test("L does nothing", () => {
    const d = deck([jiraItem()]);
    d.moves().label();
    expect(d.state.picker).toBeNull();
    expect(d.calls).toEqual([]);
  });
});

describe("a comment from a Jira card's box (plan 2026-11-10-1451, U7)", () => {
  test("Covers F3, AE1. Enter posts it alone: the card stays on top and nothing is decided", async () => {
    const d = deck([jiraItem(), attentionItem("c2")], { text: "On it" });
    d.moves().sendReply();
    await settle();
    expect(d.calls).toEqual([["reply", "10001#1", "On it", "stay"], ["sent"]]);
    expect(d.state.box.text).toBe("");
    expect(d.state.queue.map((i) => i.id)).toEqual(["10001#1", "c2"]);
    expect(d.state.decided).toEqual([]);
    expect(d.state.flash).toEqual(["Sent"]);
  });
  test("⌘] with text posts it and then reads the card, which moves on", async () => {
    const d = deck([jiraItem(), attentionItem("c2")], { text: "Done" });
    d.moves().read();
    await settle();
    expect(d.calls).toEqual([["reply", "10001#1", "Done", "read"], ["sent"]]);
    expect(d.state.queue.map((i) => i.id)).toEqual(["c2"]);
    expect(d.state.decided.map((x) => x.action)).toEqual(["seen"]);
  });
  test("⌘[ with text posts it and then puts the card off, unread", async () => {
    const d = deck([jiraItem(), attentionItem("c2")], { text: "Tomorrow" });
    d.moves().later();
    await settle();
    expect(d.calls).toEqual([["reply", "10001#1", "Tomorrow", "later"], ["sent"]]);
    expect(d.state.decided.map((x) => x.action)).toEqual(["later"]);
  });
  test("a post that fails keeps the text and the reason, and is not sent again", async () => {
    const d = deck([jiraItem(), attentionItem("c2")], { text: "On it", reply: { sent: false, error: "Jira answered 500" } });
    d.moves().sendReply();
    await settle();
    expect(d.calls).toEqual([["reply", "10001#1", "On it", "stay"]]);
    expect(d.state.box).toMatchObject({ text: "On it", error: "Jira answered 500", busy: false });
    expect(d.state.queue.map((i) => i.id)).toEqual(["10001#1", "c2"]);
  });
});

describe("undo", () => {
  test("takes back the last move and the card is back on top", async () => {
    const d = deck([attentionItem("c1"), attentionItem("c2")]);
    d.moves().read();
    await settle();
    d.moves().undo();
    await settle();
    expect(d.calls).toEqual([
      ["read", "c1"],
      ["undo", "c1"],
    ]);
    expect(d.state.queue.map((i) => i.id)).toEqual(["c1", "c2"]);
    expect(d.state.decided).toEqual([]);
  });
});

describe("the reply box's keys", () => {
  const key = (k: string, mods: Partial<{ meta: boolean; shift: boolean }> = {}) =>
    ({ key: k, metaKey: !!mods.meta, ctrlKey: false, shiftKey: !!mods.shift, altKey: false, isComposing: false }) as KeyboardEvent;
  test("⌘], ⌘[ and ⌘E go through to the deck; the plain arrows and E stay the text's", () => {
    expect([
      replyBoxKey(key("]", { meta: true }), "macos"),
      replyBoxKey(key("[", { meta: true }), "macos"),
      replyBoxKey(key("e", { meta: true }), "macos"),
    ]).toEqual(["deck", "deck", "deck"]);
    expect([replyBoxKey(key("ArrowRight"), "macos"), replyBoxKey(key("ArrowLeft"), "macos"), replyBoxKey(key("e"), "macos")]).toEqual(["own", "own", "own"]);
  });
  test("Enter sends; Shift-Enter starts a line", () => {
    expect(replyBoxKey(key("Enter"), "macos")).toBe("send");
    expect(replyBoxKey(key("Enter", { shift: true }), "macos")).toBe("own");
    expect(replyBoxKey(key("Escape"), "macos")).toBe("escape");
  });
  test("in a mail's box Enter starts a line, ⌘Enter sends and ⌘⇧C opens the recipients, as in Gmail (plan 076)", () => {
    expect(replyBoxKey(key("Enter"), "macos", true)).toBe("own");
    expect(replyBoxKey(key("Enter", { meta: true }), "macos", true)).toBe("send");
    expect(replyBoxKey(key("C", { meta: true, shift: true }), "macos", true)).toBe("recipients");
    expect(replyBoxKey(key("]", { meta: true }), "macos", true)).toBe("deck");
  });
});

describe("when a card put off twice comes back", () => {
  const now = new Date(2026, 10, 5, 14, 30);
  test("later today, tomorrow, in 3 days and next week, each after now", () => {
    expect(returnChoices(now).map((c) => [c.id, c.at])).toEqual([
      ["today", new Date(2026, 10, 5, 17, 30)],
      ["tomorrow", new Date(2026, 10, 6, 9, 0)],
      ["days", new Date(2026, 10, 8, 9, 0)],
      ["week", new Date(2026, 10, 12, 9, 0)],
    ]);
  });
  test("a date is that morning, only after today and at most about a month on", () => {
    expect(dateChoice("2026-11-20", now)).toEqual(new Date(2026, 10, 20, 9, 0));
    expect(dateChoice("2026-11-05", now)).toBeNull();
    expect(dateChoice("2026-11-01", now)).toBeNull();
    expect(dateChoice("2027-01-20", now)).toBeNull();
    expect(dateChoice("", now)).toBeNull();
    expect(LATER_MAX_DAYS).toBeLessThanOrEqual(31);
  });
});

describe("the word on the badge", () => {
  afterEach(() => {
    vi.useRealTimers();
  });
  test("a second word soon after the first keeps its full time, and stopping clears nothing later", () => {
    vi.useFakeTimers();
    const shown: Array<string | null> = [];
    const flash = createFlash((w) => shown.push(w));
    flash.say("read");
    vi.advanceTimersByTime(FLASH_MS - 100);
    flash.say("not archived: Slack is out of reach");
    vi.advanceTimersByTime(FLASH_MS - 1);
    expect(shown).toEqual(["read", "not archived: Slack is out of reach"]);
    vi.advanceTimersByTime(1);
    expect(shown.at(-1)).toBeNull();
    flash.say("later");
    flash.stop();
    vi.advanceTimersByTime(FLASH_MS * 2);
    expect(shown.at(-1)).toBe("later");
  });
});

describe("a refusal says so, and a card whose account needs a sign-in never stops the deck (plan 2026-11-14-0852, 1)", () => {
  const signedOut = () => {
    const item = outsideItem("Lunch");
    const outside = must(item.outside, "the card's account");
    return { ...item, outside: { ...outside, disconnected: "sign_in_again" as const } };
  };

  test("a refused move goes to a notice, which stays to be read, not the badge's 900 ms flash", async () => {
    const notices: string[] = [];
    const d = deck([outsideItem("Lunch"), attentionItem("c2")], { read: { error: "Gmail refused", ask: false, rest: null }, notices });
    d.moves().read();
    await settle();
    expect(d.state.flash).toEqual(["Read"]);
    expect(notices).toEqual(["Not marked read: Gmail refused"]);
    expect(d.state.queue.map((i) => i.id)).toEqual(["t1#1", "c2"]);
  });

  test("Later on a card that needs a sign-in passes it for this visit, writes nothing, and says why", async () => {
    const notices: string[] = [];
    const d = deck([signedOut(), attentionItem("c2")], { notices });
    d.moves().later();
    await settle();
    expect(d.calls).toEqual([]);
    expect(d.state.queue.map((i) => i.id)).toEqual(["c2"]);
    expect(notices).toEqual(["Skipped for this visit: nothing changed in its account"]);
  });

  test("an account that is only failing for now still writes Later as usual", async () => {
    const item = outsideItem("Lunch");
    const failing = { ...item, outside: { ...must(item.outside, "the card's account"), disconnected: "temporarily_failing" as const } };
    const d = deck([failing, attentionItem("c2")], { notices: [] });
    d.moves().later();
    await settle();
    expect(d.calls).toEqual([["later", "t1#1", undefined]]);
  });
});

describe("the control that mends a disconnected account", () => {
  test("Sign In… for Gmail and Slack, Add Token… for Jira, Connect Again… after a block, nothing while it only fails for now", async () => {
    const { mendLabel } = await import("../app/src/desk/outside-words.ts");
    expect(mendLabel("sign_in_again", "gmail")).toBe("Sign In…");
    expect(mendLabel("sign_in_again", "jira")).toBe("Add Token…");
    expect(mendLabel("admin_blocks", "slack")).toBe("Connect Again…");
    expect(mendLabel("temporarily_failing", "gmail")).toBeNull();
  });
});

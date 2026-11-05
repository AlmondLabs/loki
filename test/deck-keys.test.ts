import { afterEach, describe, expect, test, vi } from "vitest";
import type { SetStateAction } from "react";
import type { AttentionItem } from "../core/attention/model.ts";
import type { Decision } from "../core/attention/queue.ts";
import type { MoveResult, OutsideReplyResult } from "../core/attention/use-attention.ts";
import type { ReplyThen } from "../core/frame-types.ts";
import { opensChat } from "../app/src/desk/use-deck-keys.ts";
import { FLASH_MS, createFlash } from "../app/src/desk/use-deck-actions.ts";
import { EMPTY_REPLY, createDeckMoves, type PickerKind } from "../app/src/desk/deck-moves.ts";
import { LATER_MAX_DAYS, dateChoice, returnChoices } from "../app/src/desk/return-picker.tsx";
import { pickableLabels } from "../app/src/desk/label-picker.tsx";
import { replyBoxKey } from "../app/src/desk/outside-card.tsx";
import { attentionItem } from "./fixtures/attention.ts";
import { outsideItem } from "./fixtures/outside-item.ts";
import { must } from "./fixtures/must.ts";

/** The desktop deck's keys (app/src/desk/use-deck-keys.ts, deck-moves.ts): what each press does to the card on top. */

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

/** A deck with `queue` up, recording every call its moves make. */
function deck(queue: AttentionItem[], over: { asks?: boolean; text?: string; reply?: OutsideReplyResult; read?: MoveResult } = {}) {
  const calls: Array<[string, ...unknown[]]> = [];
  const state = {
    queue,
    decided: [] as Decision[],
    flash: [] as string[],
    picker: null as PickerKind | null,
    box: { ...EMPTY_REPLY, text: over.text ?? "" },
  };
  const apply = <T>(v: SetStateAction<T>, old: T): T => (typeof v === "function" ? (v as (o: T) => T)(old) : v);
  const moves = () =>
    createDeckMoves({
      current: state.queue[0],
      decided: state.decided,
      agent: null,
      reply: state.box,
      setReply: (_id, patch) => (state.box = { ...state.box, ...patch }),
      setDecided: (v) => (state.decided = apply(v, state.decided)),
      setQueue: (v) => (state.queue = apply(v, state.queue)),
      say: (w) => state.flash.push(w),
      setDir: () => {},
      pick: (k) => (state.picker = k),
      sent: () => calls.push(["sent"]),
      moves: {
        read: (item) => (calls.push(["read", item.id]), Promise.resolve(over.read ?? DONE)),
        later: (item, until) => (calls.push(["later", item.id, until]), Promise.resolve(DONE)),
        laterAsks: () => over.asks ?? false,
        archive: (item) => (calls.push(["archive", item.id]), Promise.resolve(null)),
        label: (item, ids) => (calls.push(["label", item.id, ids]), Promise.resolve(null)),
        undo: (item) => (calls.push(["undo", item.id]), Promise.resolve(null)),
        replyOutside: (item, text: string, then: ReplyThen) => (
          calls.push(["reply", item.id, text, then]),
          Promise.resolve(over.reply ?? { sent: true, error: null })
        ),
        seen: () => {},
        unread: () => {},
        approve: () => {},
      },
    });
  return { state, calls, moves };
}

describe("⌘] and ⌘[ on a card", () => {
  test("⌘[ on a chat card calls the later move and the card goes, flashing later", async () => {
    const d = deck([attentionItem("c1"), attentionItem("c2")]);
    d.moves().later();
    await settle();
    expect(d.calls).toEqual([["later", "c1", undefined]]);
    expect(d.state.queue.map((i) => i.id)).toEqual(["c2"]);
    expect(d.state.flash).toEqual(["later"]);
  });
  test("⌘] reads the card; a refusal out there brings it back on top with the reason", async () => {
    const d = deck([outsideItem("Lunch"), attentionItem("c2")], { read: { error: "Gmail refused", ask: false, rest: null } });
    d.moves().read();
    expect(d.state.queue.map((i) => i.id)).toEqual(["c2"]);
    await settle();
    expect(d.state.queue.map((i) => i.id)).toEqual(["t1#1", "c2"]);
    expect(d.state.decided).toEqual([]);
    expect(d.state.flash).toEqual(["read", "not marked read: Gmail refused"]);
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
    expect(d.state.box).toEqual({ text: "", busy: false, error: "could not mark it read" });
    expect(d.state.queue.map((i) => i.id)).toEqual(["t1#1"]);
    d.moves().later();
    await settle();
    expect(d.calls.filter((c) => c[0] === "reply")).toHaveLength(1);
  });
  test("Enter in the box sends with read", async () => {
    const d = deck([outsideItem("Lunch")], { text: "ok" });
    d.moves().sendReply();
    await settle();
    expect(d.calls[0]).toEqual(["reply", "t1#1", "ok", "read"]);
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

describe("⌘E and L", () => {
  test("AE6: ⌘E on a main chat springs back with main chats stay", () => {
    const d = deck([attentionItem("default")]);
    d.moves().archive();
    expect(d.calls).toEqual([]);
    expect(d.state.queue.map((i) => i.id)).toEqual(["default"]);
    expect(d.state.flash).toEqual(["main chats stay"]);
  });
  test("⌘E with text sends it, then archives", async () => {
    const d = deck([outsideItem("Lunch")], { text: "done, thanks" });
    d.moves().archive();
    await settle();
    expect(d.calls[0]).toEqual(["reply", "t1#1", "done, thanks", "archive"]);
    expect(d.state.flash).toEqual(["archived"]);
  });
  test("AE8: L on an email card opens the labels; picking Clients adds it and the card stays", async () => {
    const d = deck([outsideItem("Lunch"), attentionItem("c2")]);
    d.moves().label();
    expect(d.state.picker).toBe("label");
    expect(await d.moves().pickLabels(["Label_7"])).toBeNull();
    expect(d.calls).toEqual([["label", "t1#1", ["Label_7"]]]);
    expect(d.state.picker).toBeNull();
    expect(d.state.queue.map((i) => i.id)).toEqual(["t1#1", "c2"]);
    expect(d.state.flash).toEqual(["labelled"]);
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

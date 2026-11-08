import { describe, expect, test } from "vitest";
import { DemoChats, type Schedule } from "../site/src/demo-chats.ts";
import { dismissLead, gradeCard, removeCard, restoreCard, startingLearn } from "../site/src/demo-learn.ts";
import { dueCount } from "../core/recall/model.ts";

/** The website's made-up chats (site/src/demo-chats.ts, plan 066): what the Inbox demo reads and how its agents answer. */

const NOW = Date.parse("2026-11-02T10:00:00Z");

/** Timers held until `flush` runs them all, so the agent's streamed answer arrives at once. */
function heldTimers() {
  let queue: Array<() => void> = [];
  const schedule: Schedule = (run) => {
    queue.push(run);
    return () => {
      queue = queue.filter((r) => r !== run);
    };
  };
  const flush = () => {
    while (queue.length) {
      const [run] = queue.splice(0, 1);
      run();
    }
  };
  return { schedule, flush };
}

describe("the demo's Inbox", () => {
  test("a stopped agent comes first, then the newest; every card is unread", () => {
    const chats = new DemoChats(() => NOW, heldTimers().schedule);
    const items = chats.items();
    expect(
      items
        .map((i) => i.status)
        .slice(0, 2)
        .sort(),
    ).toEqual(["approval", "question"]);
    expect(items.every((i) => i.unread)).toBe(true);
    expect(chats.items()).toBe(items);
  });

  test("a reply leaves the Inbox while the agent answers, then comes back with the answer streamed in", () => {
    const timers = heldTimers();
    const chats = new DemoChats(() => NOW, timers.schedule);
    let heard = 0;
    chats.subscribe(() => heard++);
    chats.reply("lisbon", "yes please");
    expect(chats.items().some((i) => i.id === "lisbon")).toBe(false);
    expect(chats.conversation("ira", "lisbon").status).toBe("thinking");
    timers.flush();
    const rows = chats.threadRows("ira", "lisbon") ?? [];
    expect(rows.at(-2)).toEqual({ role: "user", text: "yes please" });
    expect(rows.at(-1)?.text).toContain("on the canvas");
    expect(chats.conversation("ira", "lisbon").status).toBe("idle");
    expect(chats.items().find((i) => i.id === "lisbon")?.unread).toBe(true);
    expect(heard).toBeGreaterThan(3);
  });

  test("an approval runs the tool and answers; a question takes the answer into the reply", () => {
    const timers = heldTimers();
    const chats = new DemoChats(() => NOW, timers.schedule);
    chats.decide("checkout-test", true);
    expect(chats.conversation("wren", "checkout-test").pending).toBeNull();
    timers.flush();
    const rows = chats.threadRows("wren", "checkout-test") ?? [];
    expect(rows.at(-2)?.tool?.output).toContain("12 passed");
    chats.answer("groceries", { shop: "the supermarket" });
    timers.flush();
    expect(chats.threadRows("otto", "groceries")?.at(-1)?.text).toContain("for the supermarket");
    expect(chats.items().every((i) => i.status === "done")).toBe(true);
  });

  test("archive and its undo; start over brings every chat back and cancels an answer on its way", () => {
    const timers = heldTimers();
    const chats = new DemoChats(() => NOW, timers.schedule);
    chats.archive("release-notes");
    expect(chats.items().some((i) => i.id === "release-notes")).toBe(false);
    chats.unarchive("release-notes");
    expect(chats.items().some((i) => i.id === "release-notes")).toBe(true);
    chats.reply("sleep-paper", "how did they measure it?");
    chats.reset();
    timers.flush();
    expect(chats.items()).toHaveLength(5);
    expect(chats.threadRows("ira", "sleep-paper")).toHaveLength(2);
  });
});

describe("the demo's suggestions", () => {
  const FROM = { agent_id: "wren", conversation_id: "checkout-test" };

  test("send now puts the message in its chat and that chat's agent answers; the suggestion is settled", async () => {
    const timers = heldTimers();
    const chats = new DemoChats(() => NOW, timers.schedule);
    const out = await chats.decideSuggestion(FROM, "notes", "send");
    expect(out.done).toBe(true);
    expect(out.suggestion?.status).toBe("sent");
    timers.flush();
    const rows = chats.threadRows("wren", "release-notes") ?? [];
    expect(rows.at(-2)?.text).toContain("pinned clock");
    expect(rows.at(-1)?.role).toBe("assistant");
    expect((await chats.decideSuggestion(FROM, "notes", "send")).done).toBe(false);
  });

  test("save as draft waits in the chat's box; a suggestion for a new chat starts one in the folder", async () => {
    const timers = heldTimers();
    const chats = new DemoChats(() => NOW, timers.schedule);
    await chats.decideSuggestion(FROM, "notes", "draft");
    expect(chats.draftOf("release-notes")).toContain("Fixes");
    expect(chats.chats().find((c) => c.id === "release-notes")?.has_draft).toBe(true);
    await chats.decideSuggestion(FROM, "audit", "send");
    timers.flush();
    const made = chats.chats().find((c) => c.id.startsWith("new-"));
    expect(made?.cwd).toBe("~/code/shop");
    expect(chats.threadRows("wren", made?.id ?? "")?.at(-1)?.text).toContain("pin both");
  });

  test("change chat points a suggestion elsewhere before it is sent", async () => {
    const chats = new DemoChats(() => NOW, heldTimers().schedule);
    await chats.retargetSuggestion(FROM, "notes", { agent_id: "ira", conversation_id: "lisbon" });
    expect(chats.conversation("wren", "checkout-test").suggestions.find((s) => s.id === "notes")?.target).toEqual({
      agent_id: "ira",
      conversation_id: "lisbon",
    });
  });
});

describe("the demo's Learn", () => {
  test("four cards are due; an answer schedules a card out of the queue, a delete and its restore round-trip", () => {
    const start = startingLearn(NOW);
    expect(dueCount(start.cards, NOW)).toBe(4);
    const graded = gradeCard("midnight-test", 3)(start, NOW);
    expect(dueCount(graded.cards, NOW)).toBe(3);
    const removed = removeCard("tram-28")(graded, NOW);
    expect(removed.cards.some((c) => c.card.id === "tram-28")).toBe(false);
    expect(removed.rejected[0]?.card.id).toBe("tram-28");
    const back = restoreCard("tram-28")(removed, NOW);
    expect(back.rejected).toHaveLength(0);
    expect(dueCount(back.cards, NOW)).toBe(3);
  });

  test("a dismissed lead leaves the leads for the dismissed pile", () => {
    const next = dismissLead("sleep-stages")(startingLearn(NOW), NOW);
    expect(next.leads.map((l) => l.id)).toEqual(["clock-injection"]);
    expect(next.dismissed_leads[0]?.lead.id).toBe("sleep-stages");
  });
});

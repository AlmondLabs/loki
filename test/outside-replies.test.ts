// An unsent reply on a mail or Slack card is kept per card for the session (plan 085, KTD7): a lane switch that hides
// the card and brings it back leaves the words in its box, and a sent reply clears them.
import { describe, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { OutsideReply } from "../app/src/desk/outside-card.tsx";
import { createOutsideReplies, outsideReplies } from "../app/src/shared/outside-replies.ts";
import { idOf } from "../core/attention/queue.ts";
import { outsideItem } from "./fixtures/outside-item.ts";
import { must } from "./fixtures/must.ts";

describe("the kept replies", () => {
  test("each card keeps its own text; an empty one is forgotten; a reader hears only its own card", () => {
    const kept = createOutsideReplies();
    const heard: string[] = [];
    const off = kept.subscribe("a/t1", () => heard.push("a/t1"));
    kept.set("a/t1", "on my way");
    kept.set("a/t2", "thanks");
    expect(kept.get("a/t1")).toBe("on my way");
    expect(kept.get("a/t2")).toBe("thanks");
    expect(heard).toEqual(["a/t1"]);
    kept.set("a/t1", "");
    expect(kept.get("a/t1")).toBe("");
    expect(kept.size()).toBe(1);
    off();
    kept.set("a/t1", "again");
    expect(heard).toEqual(["a/t1", "a/t1"]);
  });
});

describe("an outside card's reply box across a lane switch", () => {
  test("text typed into the box is still there when the card comes back after a lane that hid it", () => {
    const item = outsideItem("Quarterly numbers", { outside: { ...must(outsideItem("x").outside, "facts"), provider: "slack" } });
    const facts = must(item.outside, "the card's facts");
    const id = idOf(item);
    // Typed, then the card leaves the screen (a lane that hides it), and the box is drawn again when it returns.
    outsideReplies.set(id, "looking at it now");
    const html = renderToStaticMarkup(createElement(OutsideReply, { facts, keep: id, onSend: () => Promise.resolve({ sent: true, error: null }) }));
    expect(html).toContain("looking at it now");
    // Another card's box starts empty.
    const other = renderToStaticMarkup(createElement(OutsideReply, { facts, keep: "other/t9", onSend: () => Promise.resolve({ sent: true, error: null }) }));
    expect(other).not.toContain("looking at it now");
    outsideReplies.set(id, "");
  });
});

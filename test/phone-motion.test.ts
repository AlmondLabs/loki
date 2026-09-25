import { describe, expect, test } from "bun:test";
import { motionFor } from "../app/src/phone/transitions.ts";
import { edgeCommits } from "../app/src/phone/edgeSwipe.ts";
import { dismisses, rubberBand } from "../app/src/components/sheetMotion.ts";
import { armed, flingVelocity } from "../app/src/phone/deck.ts";
import type { Route } from "../app/src/phone/router.ts";

const home: Route = { kind: "tab", tab: "home" };
const inbox: Route = { kind: "tab", tab: "inbox" };
const conv: Route = { kind: "conversation", agentId: "a", conversationId: "c", prefill: null };
const agent: Route = { kind: "agent", agentId: "a" };

describe("screen changes (transitions.ts)", () => {
  test("a page opened slides in; Back slides it away", () => {
    expect(motionFor(home, conv, "push", null)).toBe("push");
    expect(motionFor(conv, home, "pop", null)).toBe("pop");
    expect(motionFor(agent, conv, "push", null)).toBe("push");
  });

  test("tab to tab, the first load and a swap in place do not move", () => {
    expect(motionFor(home, inbox, "push", null)).toBeNull();
    expect(motionFor(inbox, home, "pop", null)).toBeNull();
    expect(motionFor(home, conv, "load", null)).toBeNull();
    expect(motionFor(conv, conv, "replace", null)).toBeNull();
    expect(motionFor(conv, { ...conv, prefill: "x" }, "replace", null)).toBeNull();
  });

  test("a cold page's Back to its parent (a replace that arrives as pop) slides like Back", () => {
    expect(motionFor(agent, { kind: "tab", tab: "agents" }, "pop", null)).toBe("pop");
  });

  test("Back from a conversation opened out of the Inbox card shrinks into the card; from anywhere else it slides", () => {
    expect(motionFor(conv, inbox, "pop", "#/c/a/c")).toBe("zoom");
    expect(motionFor(conv, home, "pop", "#/c/a/c")).toBe("pop");
    expect(motionFor(conv, inbox, "pop", null)).toBe("pop");
  });
});

describe("gestures", () => {
  test("a sheet goes when pulled past 30% of its height, or flicked down", () => {
    expect(dismisses(130, 400, 0)).toBe(true);
    expect(dismisses(100, 400, 0)).toBe(false);
    expect(dismisses(40, 400, 900)).toBe(true);
    expect(dismisses(4, 400, 2000)).toBe(false); // inside the slop: a tap
  });

  test("pulled up past its top, a sheet stretches less and less, never past the limit", () => {
    expect(rubberBand(0)).toBe(0);
    expect(rubberBand(-10)).toBe(0);
    expect(rubberBand(50)).toBeLessThan(50);
    expect(rubberBand(400)).toBeGreaterThan(rubberBand(200));
    expect(rubberBand(10_000)).toBeLessThan(120);
  });

  test("the edge swipe goes back past a third of the width, or on a flick", () => {
    expect(edgeCommits(140, 390, 0)).toBe(true);
    expect(edgeCommits(100, 390, 0)).toBe(false);
    expect(edgeCommits(60, 390, 800)).toBe(true);
    expect(edgeCommits(12, 390, 3000)).toBe(false);
  });

  test("the Inbox card is armed at the commit distance, either way", () => {
    expect(armed(150, 360)).toBe(true);
    expect(armed(-150, 360)).toBe(true);
    expect(armed(100, 360)).toBe(false);
    expect(armed(150, 0)).toBe(false);
  });

  test("a fling's velocity is the finger's speed over the distance left, per second", () => {
    expect(flingVelocity(100, 0, -0.5)).toBeCloseTo(5); // moving home at 500 px/s with 100 px to go
    expect(flingVelocity(100, 0, 0.5)).toBeCloseTo(-5); // still moving away
    expect(flingVelocity(0, 0, 1)).toBe(0);
  });
});

import { rehypeWords } from "../app/src/chat/Transcript.tsx";

describe("streaming words (Transcript's rehypeWords)", () => {
  type N = { type: string; tagName?: string; value?: string; properties?: Record<string, unknown>; children?: N[] };
  const text = (value: string): N => ({ type: "text", value });
  const el = (tagName: string, children: N[]): N => ({ type: "element", tagName, children });
  const run = (tree: N) => (rehypeWords()(tree), tree);
  const words = (n: N): string[] => (n.tagName === "span" ? [n.children![0].value!] : (n.children ?? []).flatMap(words));

  test("each word becomes its own span, its trailing space with it, so an added word is a new span", () => {
    const tree = run({ type: "root", children: [el("p", [text("Let me look")])] });
    expect(words(tree)).toEqual(["Let ", "me ", "look"]);
    const more = run({ type: "root", children: [el("p", [text("Let me look at")])] });
    expect(words(more).slice(0, 3)).toEqual(words(tree).slice(0, 2).concat(["look "]));
  });

  test("code keeps its text whole, inline and in blocks; words inside marks are still wrapped", () => {
    const tree = run({ type: "root", children: [el("p", [text("run "), el("code", [text("bun test")]), el("strong", [text("now please")])]), el("pre", [el("code", [text("const a = 1")])])] });
    expect(words(tree)).toEqual(["run ", "now ", "please"]);
  });

  test("space alone stays text", () => {
    const tree = run({ type: "root", children: [el("p", [text("  ")])] });
    expect(tree.children![0].children).toEqual([text("  ")]);
  });
});

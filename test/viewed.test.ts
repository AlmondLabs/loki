import { describe, expect, test } from "bun:test";
import { NO_LOOKS, nextLook, type Looks } from "../app/src/shared/useViewed.ts";

/**
 * Viewed, not done (shared/useViewed.ts): a conversation on screen is looked at once per new last message. While
 * its reply streams every chunk moves the last message, so the look waits for the turn to settle, or for you to
 * leave or look away first; either way the conversation ends up viewed at what you saw.
 */
const ids = { agentId: "a", conversationId: "c" };
const at = (t: string) => `a/c@2026-09-25T10:00:${t}Z`;

/** Feed a run of states through nextLook; the marks it sends, in order. */
function run(states: Array<Parameters<typeof nextLook>[1]>, from: Looks = NO_LOOKS): { marks: string[]; looks: Looks } {
  let looks = from;
  const marks: string[] = [];
  for (const s of states) {
    const r = nextLook(looks, s);
    looks = r.looks;
    for (const m of r.send) marks.push(`${m.agentId}/${m.conversationId}`);
  }
  return { marks, looks };
}

describe("viewed marks while a reply streams", () => {
  test("streamed chunks send no viewed_mark; the turn settling sends one", () => {
    const chunks = ["01", "02", "03", "04", "05", "06"].map((t) => ({ looking: true, running: true, stamp: at(t), ...ids }));
    expect(run(chunks).marks).toEqual([]);
    const settled = run([...chunks, { looking: true, running: false, stamp: at("06"), ...ids }]);
    expect(settled.marks).toEqual(["a/c"]);
    // the mark lands (the stamp goes null: nothing new since the look), and nothing more goes out
    expect(run([{ looking: true, running: false, stamp: null, ...ids }], settled.looks).marks).toEqual([]);
  });

  test("leaving mid-stream marks it viewed", () => {
    const streaming = run([{ looking: true, running: true, stamp: at("01"), ...ids }, { looking: true, running: true, stamp: at("02"), ...ids }]);
    // the pane shows something else (or the conversation closes): the look is not lost
    const left = run([{ looking: false, running: true, stamp: null, ...ids }], streaming.looks);
    expect(left.marks).toEqual(["a/c"]);
    // it streams on unseen: nothing more is marked until you look again
    expect(run([{ looking: false, running: true, stamp: null, ...ids }, { looking: false, running: false, stamp: null, ...ids }], left.looks).marks).toEqual([]);
  });

  test("looking away (the window blurred) mid-stream marks it viewed; coming back holds again until the turn ends", () => {
    const r = run([
      { looking: true, running: true, stamp: at("01"), ...ids },
      { looking: false, running: true, stamp: null, ...ids },
      { looking: true, running: true, stamp: at("05"), ...ids },
      { looking: true, running: true, stamp: at("06"), ...ids },
      { looking: true, running: false, stamp: at("06"), ...ids },
    ]);
    expect(r.marks).toEqual(["a/c", "a/c"]);
  });

  test("opening another conversation mid-stream marks the one left, then looks at the new one", () => {
    const r = run([
      { looking: true, running: true, stamp: at("01"), ...ids },
      { looking: true, running: false, stamp: "a/d@2026-09-25T09:00:00Z", agentId: "a", conversationId: "d" },
    ]);
    expect(r.marks).toEqual(["a/c", "a/d"]);
  });

  test("the unmount flush (nothing on screen) sends a held look, and nothing when none is held", () => {
    const held = run([{ looking: true, running: true, stamp: at("01"), ...ids }]).looks;
    expect(nextLook(held, { looking: false, running: false, stamp: null }).send).toEqual([ids]);
    expect(nextLook(NO_LOOKS, { looking: false, running: false, stamp: null }).send).toEqual([]);
  });
});

describe("viewed marks when nothing streams (as before)", () => {
  test("each new last message is looked at once; a repeat of the same stamp sends nothing", () => {
    const r = run([
      { looking: true, running: false, stamp: at("01"), ...ids },
      { looking: true, running: false, stamp: at("01"), ...ids },
      { looking: true, running: false, stamp: null, ...ids },
      { looking: true, running: false, stamp: at("09"), ...ids },
    ]);
    expect(r.marks).toEqual(["a/c", "a/c"]);
  });

  test("nothing is sent while not looking", () => {
    expect(run([{ looking: false, running: false, stamp: null, ...ids }]).marks).toEqual([]);
  });
});

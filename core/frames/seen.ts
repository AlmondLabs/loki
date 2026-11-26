import { Type } from "typebox";
import { parseLanes } from "../attention/lanes.ts";
import { isRest, isReturnTimes } from "../attention/rest.ts";
import { compiledCheck, mark, nothing, type Raw } from "./primitives.ts";
import { PHONE, push, send } from "./types.ts";

const FocusActionSchema = Type.Union([Type.Literal("answer"), Type.Literal("decide")]);
const checkFocusAction = compiledCheck(FocusActionSchema);

export const seenFrames = {
  seen_list: send("the done and viewed marks, the focus weights and the rests", nothing, { phone: PHONE, causes: ["seen"] }),
  seen_mark: send("mark a conversation done", mark, { phone: PHONE, causes: ["seen_chat"] }),
  seen_unmark: send("mark a conversation not done", mark, { phone: PHONE, causes: ["seen_chat"] }),
  viewed_mark: send("a look, not done (the sidebar's bold, the New line)", mark, { phone: PHONE, causes: ["seen_chat"] }),
  focus_add: send(
    "an engagement the mod cannot see (a decision, an answer)",
    (m: Raw) => {
      const c = mark(m);
      if (typeof c === "string") return c;
      return checkFocusAction(m.action) ? { ...c, action: m.action } : "action must be answer or decide";
    },
    { phone: PHONE, causes: ["seen_chat"] },
  ),
  card_rest: send(
    "an Inbox card rested by Next, or its rest undone (core/attention/rest.ts)",
    (m: Raw) => {
      const c = mark(m);
      if (typeof c === "string") return c;
      return isRest(m.rest) ? { ...c, rest: m.rest } : "rest must be { n, until, stamp, at }";
    },
    { phone: PHONE, causes: ["seen_chat"] },
  ),
  return_times_set: send(
    "how long ⌘] and ⌘[ rest each kind of card (core/attention/rest.ts ReturnTimes, plan 070)",
    (m: Raw) => (isReturnTimes(m.return_times) ? { return_times: m.return_times } : "return_times must be { read_first, later } of known choices"),
    { phone: PHONE, causes: ["seen"] },
  ),
  lanes_set: send(
    "the person's whole list of lanes, replacing the one kept (core/attention/lanes.ts, plan 087)",
    (m: Raw) => (Array.isArray(m.lanes) ? { lanes: parseLanes(m.lanes) } : "lanes must be a list of lanes"),
    { causes: ["seen"] },
  ),

  seen: push("every chat's done and viewed marks, focus weights and rests (on connect, and after marks from a paired Mac)"),
  seen_chat: push("one chat's done and viewed marks, focus weight and rest, after a change to that chat"),
} as const;

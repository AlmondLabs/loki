import { Type, type Static } from "typebox";
import { compiledCheck, isGesture, NonEmptyStr, nothing, str, isNum, type Raw } from "./primitives.ts";
import { BY_SCOPE, PHONE, push, send } from "./types.ts";

const MeasureSchema = Type.Object({
  id: Type.String(),
  size: Type.Object({ w: Type.Number(), h: Type.Number() }),
});
const TrashSchema = Type.Object({ id: Type.String() });
const CanvasGetSchema = Type.Object({ scope: NonEmptyStr });
const RecentModelSchema = Type.Object({ handle: NonEmptyStr });

const checkMeasure = compiledCheck(MeasureSchema);
const checkTrash = compiledCheck(TrashSchema);
const checkCanvasGet = compiledCheck(CanvasGetSchema);
const checkRecentModel = compiledCheck(RecentModelSchema);

export const canvasFrames = {
  gesture: send(
    "a gesture on a widget (move, resize, set …); its desk's state follows",
    (m: Raw) => (isGesture(m.gesture) ? { gesture: m.gesture } : "malformed gesture"),
    { causes: ["state"], peer: BY_SCOPE },
  ),
  measure: send(
    "a widget's rendered size, which drives placement",
    (m: Raw): Static<typeof MeasureSchema> | string => {
      if (!checkMeasure(m) || !isNum(m.size.w) || !isNum(m.size.h)) return "malformed measure";
      return { id: m.id, size: { w: m.size.w, h: m.size.h } };
    },
    { causes: ["state"], peer: BY_SCOPE },
  ),
  arrange: send("tidy this desk into a grid", nothing, { causes: ["camera"] }),
  trash: send("delete the widget's file: the agent's work is gone for good", (m: Raw) => (checkTrash(m) ? { id: m.id } : "malformed trash")),
  widget_status: send(
    "a runtime or reload error from the tab (null clears it)",
    (m: Raw) => (str(m.id) ? { id: m.id, error: str(m.error) && m.error.trim() ? m.error.trim() : null } : "malformed widget_status"),
    { causes: ["widgets"], peer: BY_SCOPE },
  ),
  canvas_get: send(
    "another desk's state and widgets, for widgets shown inline in a thread; no switch",
    (m: Raw) => (checkCanvasGet(m) ? { scope: m.scope } : "scope required"),
    { phone: PHONE, causes: ["canvas"], peer: BY_SCOPE },
  ),
  chats_list: send("every desk, for the sidebar and search", nothing, { phone: PHONE, causes: ["chats"] }),
  pin_set: send(
    "pin or unpin a conversation (state/pins.json)",
    (m: Raw) =>
      str(m.agent_id) && m.agent_id && str(m.conversation_id) && m.conversation_id
        ? { agent_id: m.agent_id, conversation_id: m.conversation_id, pinned: m.pinned === true }
        : "agent_id and conversation_id required",
    { phone: PHONE, causes: ["chats"] },
  ),
  models_recent_add: send("a model picked in loki, for the shared quick picks", (m: Raw) => (checkRecentModel(m) ? { handle: m.handle } : "handle required"), {
    phone: PHONE,
    causes: ["models_recent"],
  }),

  canvas: push("one desk in full (on connect, and for canvas_get)", { relay: "scope" }),
  chat_meta: push("a desk's conversation was renamed, archived or changed model or mode"),
  state: push("a desk's geometry and overlay changed", { relay: "scope" }),
  widgets: push("a desk's widget files changed", { relay: "scope" }),
  camera: push("frame these widgets"),
  widget_change: push("the agent added, changed or removed a widget on any desk (mod/widget-log.ts)", { relay: "scope" }),
  switch_chat: push("the active conversation changed; the tab follows"),
  chats: push("every desk, after chats_list or a pin", { lists: true }),
  models_recent: push("the models used lately (on connect, and after a pick)"),
  models_usual: push("each agent's usual models (on connect, and after a switch)"),
} as const;

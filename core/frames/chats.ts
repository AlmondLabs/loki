import { Type } from "typebox";
import { compiledCheck, NonEmptyStr, nothing, str, type Raw } from "./primitives.ts";
import { PHONE, push, send } from "./types.ts";

const RecentModelSchema = Type.Object({ handle: NonEmptyStr });
const checkRecentModel = compiledCheck(RecentModelSchema);

export const chatsFrames = {
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

  chat_meta: push("a desk's conversation was renamed, archived or changed model or mode"),
  switch_chat: push("the active conversation changed; the tab follows"),
  chats: push("every desk, after chats_list or a pin", { lists: true }),
  models_recent: push("the models used lately (on connect, and after a pick)"),
  models_usual: push("each agent's usual models (on connect, and after a switch)"),
} as const;

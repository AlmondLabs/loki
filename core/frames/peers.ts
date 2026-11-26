import { MOVE_TIMEOUT_MS } from "../frame-client.ts";
import { chatRef, compiledCheck, isAgentId, NonEmptyStr, nothing, str, strOr, strings, type Raw } from "./primitives.ts";
import { BETWEEN_MACS, BY_HOME, PHONE, push, request, send, stateFolders } from "./types.ts";

const checkNonEmpty = compiledCheck(NonEmptyStr);

export const peersFrames = {
  peers_get: send("this Mac and the Macs paired with it", nothing, { causes: ["peers"] }),
  peer_pair_begin: send("mint a code another Mac types to pair with this one", nothing, { causes: ["peer_pair_code"] }),
  peer_pair_join: request("peer_paired", "pair with the Mac at `host` using the code it shows", (m: Raw) =>
    str(m.host) && m.host.trim() && str(m.code) && m.code.trim() ? { host: m.host.trim(), code: m.code.trim() } : "expected {host, code}",
  ),
  chat_move: request(
    "chat_done",
    "move a chat to the paired Mac `to`; answered by the Mac the chat lives on (plan 023, addendum A1)",
    (m: Raw) => {
      const c = chatRef(m);
      if (typeof c === "string") return c;
      return checkNonEmpty(m.to) ? { ...c, to: m.to } : "to required";
    },
    false,
    { route: "chat", relists: true, timeout_ms: MOVE_TIMEOUT_MS },
  ),
  chat_move_keep: request(
    "chat_done",
    "keep here a chat whose move to another Mac cannot finish while that Mac is out of reach (plan 096): it takes messages here again, and that Mac lets go of its copy at the next contact; answered by the Mac the chat lives on",
    chatRef,
    PHONE,
    { route: "chat", relists: true },
  ),
  chat_requirements: request(
    "chat_requirements",
    "what the Mac a chat would live on (`home`, else this one) lacks to run the agent's chat",
    (m: Raw) => (isAgentId(m.agent_id) ? { agent_id: m.agent_id, home: strOr(m.home, null) } : "agent_id required"),
    false,
    BY_HOME,
  ),
  peer_ping: request("peer_pong", "who this Mac is and which peer protocol it speaks", nothing, false, BETWEEN_MACS),
  peer_agents_get: request("peer_agents", "this Mac's agents and the agents deleted here, for another Mac to take", nothing, false, BETWEEN_MACS),
  peer_memory_get: request(
    "peer_memory",
    "the commits of an agent's memory the asking Mac lacks, given the commits it has",
    (m: Raw) => (isAgentId(m.agent_id) ? { agent_id: m.agent_id, have: strings(m.have) } : "agent_id required"),
    false,
    BETWEEN_MACS,
  ),
  peer_state_get: request(
    "peer_state",
    "the person's marks, pins, label colours and MCP servers, with the folders of files named (all when none is), for another Mac",
    (m: Raw) => ({ folders: stateFolders(m.folders) }),
    false,
    BETWEEN_MACS,
  ),
  peer_moves_get: request("peer_moves", "the chats here whose agent lives on the asking Mac", nothing, false, BETWEEN_MACS),
  peer_chat_export: request("peer_chat", "a chat copied out for the Mac it moves to; marks it moving here", chatRef, false, BETWEEN_MACS),
  peer_chat_moved: request("chat_done", "the asking Mac holds the chat now: hide it here and stop its schedules", chatRef, false, BETWEEN_MACS),
  peer_chats_get: request("peer_chats", "this Mac's own chats, for another Mac's lists", nothing, false, BETWEEN_MACS),
  peer_group_get: request("peer_group", "the Macs this one is paired with, for the asking Mac to join (addendum D1)", nothing, false, BETWEEN_MACS),
  peer_introduce: request(
    "peer_invite",
    "introduce the asking Mac to `mac_id`, another Mac paired with this one: that Mac's invite for it (addendum D1)",
    (m: Raw) => (checkNonEmpty(m.mac_id) ? { mac_id: m.mac_id } : "mac_id required"),
    false,
    BETWEEN_MACS,
  ),
  peer_invite_get: request(
    "peer_invite",
    "an invite for `for`, a Mac the asking Mac is introducing: single use, two minutes (addendum D4)",
    (m: Raw) => (checkNonEmpty(m.for) ? { for: m.for } : "for required"),
    false,
    BETWEEN_MACS,
  ),
  peer_where: request(
    "peer_here",
    "whether this Mac holds a chat, and where it went if this Mac let it go (addendum B2)",
    (m: Raw) => (checkNonEmpty(m.conversation_id) ? { agent_id: strOr(m.agent_id, null), conversation_id: m.conversation_id } : "conversation_id required"),
    false,
    BETWEEN_MACS,
  ),
  peer_chat_take: request("peer_chat_taken", "take one chat over from the asking Mac, which it lives on (addendum A1)", chatRef, false, BETWEEN_MACS),
  peer_accounts_get: request(
    "accounts",
    "the accounts connected on this Mac, so another Mac refuses to connect one twice (plan 067, KTD14)",
    nothing,
    false,
    BETWEEN_MACS,
  ),
  peer_forget: send("forget a paired Mac, telling it when it can be reached", (m: Raw) => (str(m.mac_id) ? { mac_id: m.mac_id } : "expected {mac_id}"), {
    causes: ["peers"],
  }),

  peers: push("this Mac and the Macs paired with it"),
  peer_pair_code: push("a code another Mac types to pair with this one"),
  state_changed: push("the person's marks, pins, label colours or Learn changed on this Mac"),
  group_changed: push("the Macs this one is paired with changed; sent to paired Macs, which join any they lack (addendum D1)"),
  chat_left: push("this Mac let a chat go to another paired Mac; sent to paired Macs (plan 023, addendum B3)", { lists: true }),
} as const;

import { useCallback, useRef, useState } from "react";
import { CHAT_PLACEMENTS, type ChatPlacement, type ChatWidth } from "../chat/ChatWindow";
import type { Desk } from "./types";

const CHAT_WIDTH_KEY = "loki.chatWidth";
const CHAT_PLACEMENT_KEY = "loki.chatPlacement";

/**
 * Where the chat sits and whether it shows: open or closed, narrow or wide (kept in localStorage), and
 * left, centre or right. ⌘← / ⌘→ move it (⌥⌘ inside a text box). An empty desk is a conversation, so its
 * chat is centred until the first widget lands — unless you move it there; `effectivePlacement` is the
 * one to render, `chatPlacement` the preference Settings shows.
 */
export function useChatLayout(desk: Pick<Desk, "loaded" | "connection" | "ownCount" | "scope">) {
  const [chatOpen, setChatOpen] = useState(false);
  const [chatWidth, setChatWidthRaw] = useState<ChatWidth>(() => (localStorage.getItem(CHAT_WIDTH_KEY) === "wide" ? "wide" : "narrow"));
  const setChatWidth = (w: ChatWidth) => {
    setChatWidthRaw(w);
    localStorage.setItem(CHAT_WIDTH_KEY, w);
  };
  const [chatPlacement, setChatPlacementRaw] = useState<ChatPlacement>(() => {
    const p = localStorage.getItem(CHAT_PLACEMENT_KEY);
    return p === "center" || p === "right" ? p : "left";
  });
  const setChatPlacement = useCallback((p: ChatPlacement) => {
    setChatPlacementRaw(p);
    localStorage.setItem(CHAT_PLACEMENT_KEY, p);
  }, []);
  const movedOnEmpty = useRef(new Set<string>());
  const emptyDesk = desk.loaded && desk.connection === "open" && desk.ownCount === 0;
  const effectivePlacement: ChatPlacement = emptyDesk && !movedOnEmpty.current.has(desk.scope) ? "center" : chatPlacement;
  const moveChat = (dir: 1 | -1) => {
    const i = CHAT_PLACEMENTS.indexOf(effectivePlacement);
    const next = CHAT_PLACEMENTS[Math.min(CHAT_PLACEMENTS.length - 1, Math.max(0, i + dir))];
    if (emptyDesk) movedOnEmpty.current.add(desk.scope);
    setChatPlacement(next);
    setChatOpen(true);
  };
  return { chatOpen, setChatOpen, chatWidth, setChatWidth, chatPlacement, setChatPlacement, effectivePlacement, moveChat };
}

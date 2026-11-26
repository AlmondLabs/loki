import { useCallback, useState } from "react";
import { CHAT_PLACEMENTS, type ChatPlacement, type ChatWidth } from "../chat/chat-window";
import type { Workspace } from "./types";
import { useStorageKey } from "../shared/use-storage-key";

const CHAT_WIDTH_KEY = "loki.chatWidth";
const CHAT_PLACEMENT_KEY = "loki.chatPlacement";

export function useChatLayout(desk: Pick<Workspace, "loaded" | "connection" | "ownCount" | "scope">) {
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
  useStorageKey(CHAT_WIDTH_KEY, (v) => setChatWidthRaw(v === "wide" ? "wide" : "narrow"));
  useStorageKey(CHAT_PLACEMENT_KEY, (v) => setChatPlacementRaw(v === "center" || v === "right" ? v : "left"));
  const [movedOnEmpty, setMovedOnEmpty] = useState<ReadonlySet<string>>(() => new Set());
  const emptyCanvas = desk.loaded && desk.connection === "open" && desk.ownCount === 0;
  const effectivePlacement: ChatPlacement = emptyCanvas && !movedOnEmpty.has(desk.scope) ? "center" : chatPlacement;
  const moveChat = (dir: 1 | -1) => {
    const i = CHAT_PLACEMENTS.indexOf(effectivePlacement);
    const next = CHAT_PLACEMENTS[Math.min(CHAT_PLACEMENTS.length - 1, Math.max(0, i + dir))];
    if (emptyCanvas) setMovedOnEmpty((moved) => new Set(moved).add(desk.scope));
    setChatPlacement(next);
    setChatOpen(true);
  };
  return { chatOpen, setChatOpen, chatWidth, setChatWidth, chatPlacement, setChatPlacement, effectivePlacement, moveChat };
}

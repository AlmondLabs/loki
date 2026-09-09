import { useEffect, useRef, type RefObject } from "react";
import type { ReactZoomPanPinchRef } from "react-zoom-pan-pinch";
import { CHAT_WIDTHS, type ChatPlacement, type ChatWidth } from "../chat/ChatWindow";
import { glide } from "../kit/motion";

/**
 * The chat's rectangle as a viewport inset. Owns how much of the viewport's left and right edges the
 * chat covers right now (kept in a ref for the camera to read), slides the sheet by the difference when
 * the left chat opens, closes or widens, and starts each desk at 1:1 with the sheet's origin at the
 * chat's edge. Also places the reopen bubble and the minimised tray around the chat.
 */
export function useChatInset({
  chatOpen,
  chatPlacement,
  chatWidth,
  viewportRef,
  loaded,
  scope,
}: {
  chatOpen: boolean;
  chatPlacement: ChatPlacement;
  chatWidth: ChatWidth;
  viewportRef: RefObject<ReactZoomPanPinchRef | null>;
  loaded: boolean;
  scope: string;
}) {
  /** How much of the viewport's left and right edges the chat covers right now (a centred chat floats: no inset). */
  const sideWidth = chatOpen && chatPlacement !== "center" ? CHAT_WIDTHS[chatWidth] : 0;
  const inset = chatPlacement === "left" ? sideWidth : 0;
  const insetRight = chatPlacement === "right" ? sideWidth : 0;
  const insetRef = useRef({ left: inset, right: insetRight });
  useEffect(() => {
    insetRef.current = { left: inset, right: insetRight };
  });
  // Slide the sheet with the chat on the left: open → content moves right by the chat's width, close → back.
  const prevInset = useRef(inset);
  useEffect(() => {
    const delta = inset - prevInset.current;
    prevInset.current = inset;
    const api = viewportRef.current;
    if (!delta || !api) return;
    const { positionX, positionY, scale: s } = api.instance.state;
    api.setTransform(positionX + delta, positionY, s, glide(220), "easeOut");
  }, [inset, viewportRef]);

  // Each desk starts at 1:1 with the sheet's origin at the chat's edge, so a layout that
  // begins at x = 0 is never born under the panel.
  const cameraReset = useRef<string | null>(null);
  useEffect(() => {
    if (!loaded || cameraReset.current === scope) return;
    cameraReset.current = scope;
    viewportRef.current?.setTransform(insetRef.current.left, 0, 1, 0);
  }, [loaded, scope, viewportRef]);

  /** The reopen bubble sits on the chat's side; the minimised tray keeps clear of both. */
  const bubbleSide: "left" | "right" = chatPlacement === "right" ? "right" : "left";
  const trayLeft = inset + (chatOpen ? 16 : bubbleSide === "left" ? 80 : 16);

  return { insetRef, bubbleSide, trayLeft };
}

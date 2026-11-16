import { useEffect, useRef, type RefObject } from "react";
import type { ReactZoomPanPinchRef } from "react-zoom-pan-pinch";
import { CHAT_WIDTHS, type ChatPlacement, type ChatWidth } from "../chat/chat-window";
import { glide } from "../kit/motion";

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
  const sideWidth = chatOpen && chatPlacement !== "center" ? CHAT_WIDTHS[chatWidth] : 0;
  const inset = chatPlacement === "left" ? sideWidth : 0;
  const insetRight = chatPlacement === "right" ? sideWidth : 0;
  const insetRef = useRef({ left: inset, right: insetRight });
  useEffect(() => {
    insetRef.current = { left: inset, right: insetRight };
  });
  const prevInset = useRef(inset);
  useEffect(() => {
    const delta = inset - prevInset.current;
    prevInset.current = inset;
    const api = viewportRef.current;
    if (!delta || !api) return;
    const { positionX, positionY, scale: s } = api.instance.state;
    void api.setTransform(positionX + delta, positionY, s, glide(220), "easeOut");
  }, [inset, viewportRef]);

  const cameraReset = useRef<string | null>(null);
  useEffect(() => {
    if (!loaded || cameraReset.current === scope) return;
    cameraReset.current = scope;
    void viewportRef.current?.setTransform(insetRef.current.left, 0, 1, 0);
  }, [loaded, scope, viewportRef]);

  const bubbleSide: "left" | "right" = chatPlacement === "right" ? "right" : "left";
  const trayLeft = inset + (chatOpen ? 16 : bubbleSide === "left" ? 80 : 16);

  return { insetRef, bubbleSide, trayLeft };
}

import { useEffect, useEffectEvent, useRef, useState, type RefObject } from "react";
import type { ReactZoomPanPinchRef } from "react-zoom-pan-pinch";
import type { Gesture } from "../../../core/desk-core.ts";
import type { CameraTarget, VisibleWidget } from "./use-desk";
import { registerActions } from "../shell/keymap";
import { glide } from "../kit/motion";
import { glideTo, stopGlide } from "./camera-glide";

const widgetEls = (ids: string[]) => ids.map((id) => document.getElementById(`widget-${id.replace("/", "--")}`)).filter((e): e is HTMLElement => !!e);

function boundsOf(els: HTMLElement[]) {
  const left = Math.min(...els.map((e) => e.offsetLeft));
  const top = Math.min(...els.map((e) => e.offsetTop));
  const right = Math.max(...els.map((e) => e.offsetLeft + e.offsetWidth));
  const bottom = Math.max(...els.map((e) => e.offsetTop + e.offsetHeight));
  return { left, top, right, bottom, w: right - left, h: bottom - top, cx: (left + right) / 2, cy: (top + bottom) / 2 };
}

export function useCamera({
  viewportRef,
  insetRef,
  visible,
  gesture,
  cameraTarget,
  arrange,
  undo,
  active = true,
}: {
  viewportRef: RefObject<ReactZoomPanPinchRef | null>;
  insetRef: RefObject<{ left: number; right: number }>;
  visible: VisibleWidget[];
  gesture: (g: Gesture) => void;
  cameraTarget: CameraTarget | null;
  arrange: () => void;
  undo: () => boolean;
  active?: boolean;
}) {
  const stage = () => {
    const api = viewportRef.current;
    const wrapper = api?.instance.wrapperComponent;
    const vw = wrapper?.clientWidth ?? window.innerWidth;
    const vh = wrapper?.clientHeight ?? window.innerHeight;
    const { left, right } = insetRef.current;
    return { left, w: Math.max(200, vw - left - right), h: vh };
  };
  const frameAt = (els: HTMLElement[], s: number) => {
    const api = viewportRef.current;
    if (!api) return;
    const st = stage();
    const b = boundsOf(els);
    glideTo(api, st.left + st.w / 2 - b.cx * s, st.h / 2 - b.cy * s, s);
  };
  const [highlighted, setHighlighted] = useState<Set<string>>(new Set());

  const fitAll = () => {
    const els = widgetEls(visible.map((w) => w.entry.id));
    if (!els.length) return;
    const st = stage();
    const b = boundsOf(els);
    const pad = 80;
    frameAt(els, Math.min(1.5, Math.max(0.1, Math.min((st.w - pad * 2) / b.w, (st.h - pad * 2) / b.h))));
  };
  const zoomBy = (factor: number) => {
    const api = viewportRef.current;
    if (!api) return;
    const { positionX, positionY, scale: s } = api.instance.state;
    stopGlide();
    const next = Math.min(4, Math.max(0.1, s * factor));
    const k = next / s;
    const st = stage();
    const cx = st.left + st.w / 2;
    const cy = st.h / 2;
    void api.setTransform(cx - (cx - positionX) * k, cy - (cy - positionY) * k, next, glide(180), "easeOut");
  };
  const resetZoom = () => {
    const api = viewportRef.current;
    if (!api) return;
    stopGlide();
    const { positionX, positionY, scale: s } = api.instance.state;
    const st = stage();
    const cx = st.left + st.w / 2;
    const cy = st.h / 2;
    void api.setTransform(cx - (cx - positionX) / s, cy - (cy - positionY) / s, 1, glide(500), "easeOut");
  };
  const fitAllRef = useRef(fitAll);
  const resetZoomRef = useRef(resetZoom);
  const zoomByRef = useRef(zoomBy);
  useEffect(() => {
    fitAllRef.current = fitAll;
    resetZoomRef.current = resetZoom;
    zoomByRef.current = zoomBy;
  });

  const focusWidget = (id: string) => {
    gesture({ kind: "focus", id });
    const els = widgetEls([id]);
    if (!els.length) return;
    const st = stage();
    const el = els[0];
    frameAt(els, Math.min(2.5, Math.max(0.5, Math.min((st.w * 0.6) / el.offsetWidth, (st.h * 0.7) / el.offsetHeight))));
    setHighlighted(new Set([id]));
    setTimeout(() => setHighlighted((h) => (h.has(id) && h.size === 1 ? new Set() : h)), 2500);
  };

  const frameTarget = useEffectEvent((ids: string[]) => {
    const els = widgetEls(ids);
    if (els.length !== ids.length) return false;
    if (els.length === 1) {
      frameAt(els, 1.15);
    } else {
      const st = stage();
      const b = boundsOf(els);
      const pad = 80;
      frameAt(els, Math.min(1.15, Math.max(0.1, Math.min((st.w - pad * 2) / b.w, (st.h - pad * 2) / b.h))));
    }
    setHighlighted(new Set(ids));
    return true;
  });
  useEffect(() => {
    if (!cameraTarget) return;
    const ids = cameraTarget.widgetIds;
    let tries = 0;
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      if (!frameTarget(ids) && tries++ < 20) timer = setTimeout(tick, 100);
    };
    timer = setTimeout(tick, 60);
    const clear = setTimeout(() => setHighlighted(new Set()), 4000);
    return () => {
      clearTimeout(timer);
      clearTimeout(clear);
    };
  }, [cameraTarget]);

  const arrangeSheet = useEffectEvent(() => arrange());
  const undoSheet = useEffectEvent(() => {
    if (!undo()) console.info("loki: nothing to undo on the sheet");
  });
  useEffect(() => {
    if (!active) return;
    return registerActions({
      "view.fit": () => fitAllRef.current(),
      "view.reset": () => resetZoomRef.current(),
      "view.zoomIn": () => zoomByRef.current(1.25),
      "view.zoomOut": () => zoomByRef.current(1 / 1.25),
      "desk.arrange": () => arrangeSheet(),
      "desk.undo": () => undoSheet(),
    });
  }, [active]);

  return { highlighted, focusWidget };
}

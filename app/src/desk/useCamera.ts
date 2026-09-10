import { useEffect, useRef, useState, type RefObject } from "react";
import type { ReactZoomPanPinchRef } from "react-zoom-pan-pinch";
import type { Gesture } from "../../../core/desk-core.ts";
import type { CameraTarget, VisibleWidget } from "./useDesk";
import { registerActions } from "../shell/keymap";
import { glide } from "../kit/motion";

/** The mounted frames for these widget ids (a frame's element id is `widget-<desk>--<name>`). */
const widgetEls = (ids: string[]) => ids.map((id) => document.getElementById(`widget-${id.replace("/", "--")}`)).filter((e): e is HTMLElement => !!e);

/** Bounds of a set of widget elements in canvas units (offset* are untransformed content coordinates). */
function boundsOf(els: HTMLElement[]) {
  const left = Math.min(...els.map((e) => e.offsetLeft));
  const top = Math.min(...els.map((e) => e.offsetTop));
  const right = Math.max(...els.map((e) => e.offsetLeft + e.offsetWidth));
  const bottom = Math.max(...els.map((e) => e.offsetTop + e.offsetHeight));
  return { left, top, right, bottom, w: right - left, h: bottom - top, cx: (left + right) / 2, cy: (top + bottom) / 2 };
}

/**
 * The camera over the sheet: fit all (⌘0), zoom (⌘= / ⌘-), back to 1:1 (⌘⇧0), focus on one widget,
 * and the glide when a widget lands or loki_camera asks. Every framing move centres in the stage, the
 * part of the viewport the chat does not cover. Registers the sheet's keymap actions once, and keeps
 * the set of widgets the camera is pointing at, which glow for a few seconds so the eye finds them.
 */
export function useCamera({
  viewportRef,
  insetRef,
  visible,
  gesture,
  cameraTarget,
  arrange,
  undo,
}: {
  viewportRef: RefObject<ReactZoomPanPinchRef | null>;
  insetRef: RefObject<{ left: number; right: number }>;
  visible: VisibleWidget[];
  gesture: (g: Gesture) => void;
  cameraTarget: CameraTarget | null;
  arrange: () => void;
  /** The sheet's undo; false when there is nothing to undo. */
  undo: () => boolean;
}) {
  /** The visible part of the viewport: everything the chat does not cover. */
  const stage = () => {
    const api = viewportRef.current;
    const wrapper = api?.instance.wrapperComponent;
    const vw = wrapper?.clientWidth ?? window.innerWidth;
    const vh = wrapper?.clientHeight ?? window.innerHeight;
    const { left, right } = insetRef.current;
    return { left, w: Math.max(200, vw - left - right), h: vh };
  };
  /** Move the camera so `els` sit centred in the stage at scale `s`. */
  const frameAt = (els: HTMLElement[], s: number, ms = 600) => {
    const api = viewportRef.current;
    if (!api) return;
    const st = stage();
    const b = boundsOf(els);
    api.setTransform(st.left + st.w / 2 - b.cx * s, st.h / 2 - b.cy * s, s, glide(ms), "easeOut");
  };
  // Widgets the camera is pointing at glow for a few seconds, so the eye finds them.
  const [highlighted, setHighlighted] = useState<Set<string>>(new Set());

  /** Fit every visible widget into the stage (⌘0). */
  const fitAll = () => {
    const els = widgetEls(visible.map((w) => w.entry.id));
    if (!els.length) return;
    const st = stage();
    const b = boundsOf(els);
    const pad = 80;
    frameAt(els, Math.min(1.5, Math.max(0.1, Math.min((st.w - pad * 2) / b.w, (st.h - pad * 2) / b.h))));
  };
  /** Zoom about the stage centre by a factor (⌘= / ⌘-). */
  const zoomBy = (factor: number) => {
    const api = viewportRef.current;
    if (!api) return;
    const { positionX, positionY, scale: s } = api.instance.state;
    const next = Math.min(4, Math.max(0.1, s * factor));
    const k = next / s;
    const st = stage();
    const cx = st.left + st.w / 2;
    const cy = st.h / 2;
    api.setTransform(cx - (cx - positionX) * k, cy - (cy - positionY) * k, next, glide(180), "easeOut");
  };
  /** Back to 1:1 around the stage centre (⌘⇧0). */
  const resetZoom = () => {
    const api = viewportRef.current;
    if (!api) return;
    const { positionX, positionY, scale: s } = api.instance.state;
    const st = stage();
    const cx = st.left + st.w / 2;
    const cy = st.h / 2;
    // keep the canvas point under the centre where it is
    api.setTransform(cx - (cx - positionX) / s, cy - (cy - positionY) / s, 1, glide(500), "easeOut");
  };
  // The keymap actions above were registered once; they call through these to the latest closures.
  const fitAllRef = useRef(fitAll);
  const resetZoomRef = useRef(resetZoom);
  const zoomByRef = useRef(zoomBy);
  useEffect(() => {
    fitAllRef.current = fitAll;
    resetZoomRef.current = resetZoom;
    zoomByRef.current = zoomBy;
  });

  /** Focus: bring the widget to the front and zoom so it fills a good part of the stage. */
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

  // Camera glide when a widget lands or loki_camera asks. One id: zoom to it. Several: fit them all.
  // Elements may mount a beat after the frame arrives, so retry briefly.
  useEffect(() => {
    if (!cameraTarget) return;
    const ids = cameraTarget.widgetIds;
    let tries = 0;
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      const els = widgetEls(ids);
      if (els.length === ids.length) {
        if (els.length === 1) {
          frameAt(els, 1.15);
        } else {
          const st = stage();
          const b = boundsOf(els);
          const pad = 80;
          frameAt(els, Math.min(1.15, Math.max(0.1, Math.min((st.w - pad * 2) / b.w, (st.h - pad * 2) / b.h))));
        }
        setHighlighted(new Set(ids));
      } else if (tries++ < 20) {
        timer = setTimeout(tick, 100);
      }
    };
    timer = setTimeout(tick, 60);
    const clear = setTimeout(() => setHighlighted(new Set()), 4000);
    return () => {
      clearTimeout(timer);
      clearTimeout(clear);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cameraTarget]);

  // The sheet's actions, by keymap id: the shell's one key handler (and the menu bar) dispatch to these. Registered
  // once, after every closure they call through is declared (the refs above carry the latest ones).
  useEffect(
    () =>
      registerActions({
        "view.fit": () => fitAllRef.current(),
        "view.reset": () => resetZoomRef.current(),
        "view.zoomIn": () => zoomByRef.current(1.25),
        "view.zoomOut": () => zoomByRef.current(1 / 1.25),
        "desk.arrange": () => arrange(),
        "desk.undo": () => {
          if (!undo()) console.info("loki: nothing to undo on the sheet");
        },
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  return { highlighted, focusWidget };
}

import { forwardRef, type ReactNode } from "react";
import {
  TransformWrapper,
  TransformComponent,
  type ReactZoomPanPinchRef,
} from "react-zoom-pan-pinch";

/**
 * Pannable/zoomable surface. Widgets live inside the transformed content;
 * chrome (chat, badges) stays outside. Panning is excluded on `.loci-no-pan`
 * (the widget frames) so dragging a widget never pans the canvas.
 * The ref exposes zoomToElement / setTransform for camera glides (U7).
 */
export const Viewport = forwardRef<ReactZoomPanPinchRef, { children: ReactNode }>(
  function Viewport({ children }, ref) {
    return (
      <TransformWrapper
        ref={ref}
        initialScale={1}
        minScale={0.35}
        maxScale={2.5}
        limitToBounds={false}
        centerZoomedOut={false}
        doubleClick={{ disabled: true }}
        wheel={{ step: 0.08 }}
        panning={{ excluded: ["loci-no-pan"] }}
        pinch={{ step: 5 }}
      >
        <TransformComponent
          wrapperStyle={{ width: "100%", height: "100%" }}
          contentStyle={{ width: "100%", height: "100%" }}
        >
          {children}
        </TransformComponent>
      </TransformWrapper>
    );
  },
);

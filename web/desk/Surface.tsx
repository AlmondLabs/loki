import { useEffect, useRef, useState } from "react";
import type { ReactZoomPanPinchRef } from "react-zoom-pan-pinch";
import { WidgetFrame } from "./WidgetFrame";
import { Viewport } from "./Viewport";
import { useDesk } from "./useDesk";
import { ChatBubble, ChatWindow } from "../chat/ChatWindow";

import { KIT_COMPONENTS } from "../kit";
import { ModuleHost } from "./ModuleHost";
import type { Patch } from "./useDesk";

/** Renders a widget body from the kit registry, or an authored module. */
function WidgetBody({
  id,
  type,
  data,
  moduleRev,
  patch,
  reportError,
}: {
  id: string;
  type: string;
  data: unknown;
  moduleRev?: number;
  patch: (p: Patch) => void;
  reportError: (id: string, message: string | null) => void;
}) {
  const onSet = (path: string, value: unknown) => patch({ op: "set", id, path, value });
  if (type === "authored") {
    return (
      <ModuleHost
        id={id}
        moduleRev={moduleRev ?? 1}
        data={(data ?? {}) as Record<string, unknown>}
        onSet={onSet}
        onError={reportError}
      />
    );
  }
  const Component = KIT_COMPONENTS[type];
  if (!Component) {
    return <div style={{ fontSize: 12, color: "var(--loci-muted)" }}>unknown widget: {type}</div>;
  }
  return <Component data={(data ?? {}) as Record<string, unknown>} onSet={onSet} />;
}

export function Surface() {
  const { state, connection, patch, chat, reportWidgetError, cameraTarget } = useDesk();
  const [chatOpen, setChatOpen] = useState(false);
  const viewportRef = useRef<ReactZoomPanPinchRef | null>(null);
  const widgets = Object.values(state.widgets);

  // Camera glide: eased zoom-to-widget whenever a target lands (agent adds a
  // widget or calls loci_camera). The no-yank guard already ran in useDesk.
  useEffect(() => {
    if (!cameraTarget) return;
    // New widgets mount on this same render pass; glide after paint.
    const t = setTimeout(() => {
      viewportRef.current?.zoomToElement(`widget-${cameraTarget.widgetId}`, 1.15, 600, "easeOut");
    }, 60);
    return () => clearTimeout(t);
  }, [cameraTarget]);

  return (
    <div
      style={{
        position: "relative",
        height: "100%",
        overflow: "hidden",
        opacity: connection === "open" ? 1 : 0.55,
        transition: "opacity 200ms",
      }}
    >
      <Viewport ref={viewportRef}>
        {widgets.map((w) => (
          <WidgetFrame
            key={w.id}
            widget={w}
            patch={patch}
            getScale={() => viewportRef.current?.instance.state.scale ?? 1}
          >
            <WidgetBody
              id={w.id}
              type={w.type}
              data={w.data}
              moduleRev={w.moduleRev}
              patch={patch}
              reportError={reportWidgetError}
            />
          </WidgetFrame>
        ))}
      </Viewport>
      {connection !== "open" && (
        <div
          style={{
            position: "absolute",
            bottom: 16,
            left: 16,
            fontSize: 12,
            color: "var(--loci-muted)",
            letterSpacing: "0.06em",
          }}
        >
          {connection === "connecting" ? "connecting…" : "disconnected — retrying"}
        </div>
      )}
      {chatOpen && (
        <ChatWindow
          messages={chat.messages}
          status={chat.status}
          error={chat.error}
          onSend={chat.send}
          onClose={() => setChatOpen(false)}
        />
      )}
      <ChatBubble open={chatOpen} onToggle={() => setChatOpen((v) => !v)} />
      {widgets.length === 0 && connection === "open" && (
        <div
          style={{
            height: "100%",
            display: "grid",
            placeItems: "center",
            color: "var(--loci-muted)",
            fontSize: 13,
          }}
        >
          empty desk — ask Ira to put something here
        </div>
      )}
    </div>
  );
}

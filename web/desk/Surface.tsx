import { useState } from "react";
import { WidgetFrame } from "./WidgetFrame";
import { useDesk } from "./useDesk";
import { ChatBubble, ChatWindow } from "../chat/ChatWindow";

import { KIT_COMPONENTS } from "../kit";
import type { Patch } from "./useDesk";

/** Renders a widget body from the kit registry. */
function WidgetBody({
  id,
  type,
  data,
  patch,
}: {
  id: string;
  type: string;
  data: unknown;
  patch: (p: Patch) => void;
}) {
  const Component = KIT_COMPONENTS[type];
  if (!Component) {
    return <div style={{ fontSize: 12, color: "var(--loci-muted)" }}>unknown widget: {type}</div>;
  }
  return (
    <Component
      data={(data ?? {}) as Record<string, unknown>}
      onSet={(path, value) => patch({ op: "set", id, path, value })}
    />
  );
}

export function Surface() {
  const { state, connection, patch, chat } = useDesk();
  const [chatOpen, setChatOpen] = useState(false);
  const widgets = Object.values(state.widgets);

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
      {widgets.map((w) => (
        <WidgetFrame key={w.id} widget={w} patch={patch}>
          <WidgetBody id={w.id} type={w.type} data={w.data} patch={patch} />
        </WidgetFrame>
      ))}
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

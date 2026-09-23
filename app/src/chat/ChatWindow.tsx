import type { CSSProperties } from "react";
import { LAYER } from "../kit/layers";
import { IconButton } from "../components";
import type { ModelEntry } from "./ModelPicker";
import { Conversation, ConversationHeader, type ConversationActions, type ConversationView } from "./Conversation";
import { useAttentive } from "./useAttentive";

export type { ChatStatus } from "./Conversation";

/**
 * The panel sits on the sheet in one of three places (⌘← / ⌘→ move it): stacked on the left
 * edge, floating centred and wider, or stacked on the right edge. Side placements come in two
 * widths and are viewport insets for the sheet; the centre floats over it.
 */
export type ChatWidth = "narrow" | "wide";
export const CHAT_WIDTHS: Record<ChatWidth, number> = { narrow: 400, wide: 640 };
export type ChatPlacement = "left" | "center" | "right";
export const CHAT_PLACEMENTS: ChatPlacement[] = ["left", "center", "right"];
/** The centred chat has the inbox card's footprint (CatchUp.tsx): the same width and the same insets. */
export const CHAT_CENTER_WIDTH = 1100;

/** The desk's chat: the one Conversation, framed as a panel that fades to see-through when nothing is going on in it. */
export function ChatWindow({
  title,
  agentName,
  agentId,
  view,
  actions,
  models = null,
  width = "narrow",
  placement = "left",
  onToggleWidth,
  focusTick = 0,
  findTick = 0,
  prefill = null,
  modelPickerTick = 0,
  modeMenuTick = 0,
  onClose,
}: {
  /** The desk's name, over the agent's face in the header. */
  title: string | null;
  agentName?: string | null;
  agentId?: string | null;
  view: ConversationView;
  actions: ConversationActions;
  models?: ModelEntry[] | null;
  width?: ChatWidth;
  placement?: ChatPlacement;
  onToggleWidth?: () => void;
  /** Bumped by the host: ⌘L focus, ⌘F find, ⌘⇧M model, ⌘⇧P mode. */
  focusTick?: number;
  findTick?: number;
  prefill?: { text: string; tick: number } | null;
  modelPickerTick?: number;
  modeMenuTick?: number;
  onClose: () => void;
}) {
  const waiting = !!view.approval || !!view.question;
  const { attentive, setHover, setFocused } = useAttentive({ messageCount: view.rows?.length ?? 0, status: view.status, waiting });
  return (
    <div
      onPointerDown={(e) => e.stopPropagation()}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
      onFocusCapture={() => setFocused(true)}
      onBlurCapture={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false);
      }}
      data-attentive={attentive ? "true" : "false"}
      style={panelStyle(placement, width, attentive)}
    >
      <Conversation
        view={view}
        actions={actions}
        models={models}
        agentName={agentName}
        header={
          <ConversationHeader
            title={title ?? (agentName ? `${agentName}'s chat` : "chat")}
            agentName={agentName}
            agentId={agentId}
            right={
              <div style={{ display: "flex", alignItems: "center", gap: 2, flex: "0 0 auto" }}>
                {onToggleWidth && placement !== "center" && (
                  <IconButton size={24} onClick={onToggleWidth} label={width === "wide" ? "narrow chat" : "wide chat"}>
                    <WidthIcon wide={width === "wide"} />
                  </IconButton>
                )}
                <IconButton size={24} onClick={onClose} label="close chat" style={{ fontSize: 13.5 }}>
                  ×
                </IconButton>
              </div>
            }
          />
        }
        prefill={prefill}
        focusTick={focusTick}
        findTick={findTick}
        modelPickerTick={modelPickerTick}
        modeMenuTick={modeMenuTick}
      />
    </div>
  );
}

/** A panel outline with its divider on the side the toggle will move it to. */
function WidthIcon({ wide }: { wide: boolean }) {
  return wide ? (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5" /><path d="M6.5 2.5v11" /></svg>
  ) : (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5" /><path d="M10.5 2.5v11" /></svg>
  );
}

/**
 * Where the panel sits and how it reads: the three placements differ in edges and border, and the
 * whole thing fades to see-through when nothing is going on in it.
 */
function panelStyle(placement: ChatPlacement, width: ChatWidth, attentive: boolean): CSSProperties {
  return {
    position: "absolute",
    ...(placement === "center"
      ? { top: 20, bottom: 16, left: "50%", transform: "translateX(-50%)", width: CHAT_CENTER_WIDTH, maxWidth: "calc(100% - 48px)", border: "1px solid var(--loki-border)", borderRadius: "var(--loki-radius-lg)" }
      : placement === "right"
        ? { top: 0, right: 0, bottom: 0, width: CHAT_WIDTHS[width], maxWidth: "100%", borderLeft: "1px solid var(--loki-border)" }
        : { top: 0, left: 0, bottom: 0, width: CHAT_WIDTHS[width], maxWidth: "100%", borderRight: "1px solid var(--loki-border)" }),
    boxSizing: "border-box",
    display: "flex",
    flexDirection: "column",
    background: "var(--loki-panel)",
    boxShadow: attentive ? (placement === "center" ? "var(--loki-shadow-sheet)" : "var(--loki-shadow-panel)") : "none",
    overflow: "hidden",
    zIndex: LAYER.panel,
    opacity: attentive ? 1 : 0.6,
    transition: "opacity 220ms ease-out, box-shadow 220ms ease-out, width 200ms ease-out",
  };
}

export function ChatBubble({ open, onToggle, alert = false, side = "left" }: { open: boolean; onToggle: () => void; alert?: boolean; side?: "left" | "right" }) {
  return (
    <button
      data-alert={alert || undefined}
      onClick={onToggle}
      onPointerDown={(e) => e.stopPropagation()}
      aria-label="toggle chat"
      style={{
        position: "absolute",
        ...(side === "right" ? { right: 20 } : { left: 20 }),
        bottom: 20,
        width: 48,
        height: 48,
        borderRadius: 24,
        border: "1px solid var(--loki-border)",
        background: open ? "var(--loki-accent)" : "var(--loki-panel)",
        color: "var(--loki-fg)",
        fontSize: 17,
        cursor: "pointer",
        boxShadow: "var(--loki-shadow-panel)",
        zIndex: LAYER.bubble,
      }}
    >
      {open ? "×" : "✳"}
      {alert && !open && (
        <span
          aria-label="permission waiting"
          style={{ position: "absolute", top: -2, right: -2, width: 12, height: 12, borderRadius: "var(--loki-radius-sm)", background: "var(--loki-attention)", border: "2px solid var(--loki-bg)" }}
        />
      )}
    </button>
  );
}

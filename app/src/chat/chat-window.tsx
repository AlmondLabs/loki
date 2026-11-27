import type { CSSProperties } from "react";
import { LAYER } from "../kit/layers";
import { IconButton } from "../components";
import type { ModelEntry } from "./model-picker";
import { Conversation, ConversationHeader, type ConversationActions, type ConversationView } from "./conversation";
import type { SuggestionsProps } from "./suggestion-card";
import type { ControlledDraft } from "./use-draft";
import { useAttentive } from "./use-attentive";
import { LinkHeader } from "./link-header";
import { WorkersHeader } from "./workers-header";
import { PanelLeftIcon, PanelRightIcon, XIcon, MessageSquareIcon } from "lucide-react";
import { Glyph } from "../shared/icons";

export type ChatWidth = "narrow" | "wide";
export const CHAT_WIDTHS: Record<ChatWidth, number> = { narrow: 400, wide: 640 };
export type ChatPlacement = "left" | "center" | "right";
export const CHAT_PLACEMENTS: ChatPlacement[] = ["left", "center", "right"];
export const CHAT_CENTER_WIDTH = 1100;

export function ChatWindow({
  title,
  purpose = null,
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
  suggestionsTick = 0,
  draft,
  suggestions = null,
  onClose,
}: {
  title: string | null;
  purpose?: string | null;
  agentName?: string | null;
  agentId?: string | null;
  view: ConversationView;
  actions: ConversationActions;
  models?: ModelEntry[] | null;
  width?: ChatWidth;
  placement?: ChatPlacement;
  onToggleWidth?: () => void;
  focusTick?: number;
  findTick?: number;
  prefill?: { text: string; tick: number } | null;
  modelPickerTick?: number;
  modeMenuTick?: number;
  suggestionsTick?: number;
  draft?: ControlledDraft;
  suggestions?: SuggestionsProps | null;
  onClose: () => void;
}) {
  const waiting = !!view.approval || !!view.question;
  const { attentive, setHover, setFocused } = useAttentive({ messageCount: view.rows?.length ?? 0, status: view.status, waiting });
  return (
    <>
      <div aria-hidden style={shadowStyle(placement, width, attentive)} />
      <div
        onPointerDown={(e) => e.stopPropagation()}
        onPointerEnter={() => setHover(true)}
        onPointerLeave={() => setHover(false)}
        onFocusCapture={() => setFocused(true)}
        onBlurCapture={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget)) setFocused(false);
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
              purpose={purpose}
              agentName={agentName}
              agentId={agentId}
              below={
                view.links?.length || view.subagents?.length ? (
                  <div className="loki-chat-strips">
                    <WorkersHeader subagents={view.subagents} />
                    {view.links?.length ? (
                      <LinkHeader links={view.links} onClose={actions.onCloseLink ? (id) => void actions.onCloseLink?.(id) : undefined} />
                    ) : null}
                  </div>
                ) : null
              }
              right={
                <div className="flex flex-none items-center gap-0.5">
                  {onToggleWidth && placement !== "center" && (
                    <IconButton size={24} onClick={onToggleWidth} label={width === "wide" ? "Narrow chat" : "Wide chat"}>
                      <Glyph icon={width === "wide" ? PanelLeftIcon : PanelRightIcon} />
                    </IconButton>
                  )}
                  <IconButton size={24} onClick={onClose} label="Close chat" style={{ fontSize: "var(--text-sm)" }}>
                    <Glyph icon={XIcon} />
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
          suggestionsTick={suggestionsTick}
          draft={draft}
          suggestions={suggestions}
        />
      </div>
    </>
  );
}

function placementStyle(placement: ChatPlacement, width: ChatWidth): CSSProperties {
  return {
    position: "absolute",
    ...(placement === "center"
      ? {
          top: 20,
          bottom: 16,
          left: "50%",
          transform: "translateX(-50%)",
          width: CHAT_CENTER_WIDTH,
          maxWidth: "calc(100% - 48px)",
          border: "1px solid var(--loki-border)",
          borderRadius: "var(--radius-xl)",
        }
      : placement === "right"
        ? { top: 0, right: 0, bottom: 0, width: CHAT_WIDTHS[width], maxWidth: "100%", borderLeft: "1px solid var(--loki-border)" }
        : { top: 0, left: 0, bottom: 0, width: CHAT_WIDTHS[width], maxWidth: "100%", borderRight: "1px solid var(--loki-border)" }),
    boxSizing: "border-box",
    zIndex: LAYER.panel,
  };
}

/**
 * The panel's shadow, on a layer of its own under it that fades in and out: transitioning box-shadow itself
 * would repaint the panel on every frame while its thread streams.
 */
function shadowStyle(placement: ChatPlacement, width: ChatWidth, attentive: boolean): CSSProperties {
  return {
    ...placementStyle(placement, width),
    borderColor: "transparent",
    pointerEvents: "none",
    boxShadow: placement === "center" ? "var(--loki-shadow-sheet)" : "var(--loki-shadow-panel)",
    opacity: attentive ? 1 : 0,
    transition: "opacity 220ms ease-out",
  };
}

function panelStyle(placement: ChatPlacement, width: ChatWidth, attentive: boolean): CSSProperties {
  return {
    ...placementStyle(placement, width),
    display: "flex",
    flexDirection: "column",
    background: "var(--loki-panel)",
    overflow: "hidden",
    opacity: attentive ? 1 : 0.6,
    transition: "opacity 220ms ease-out",
  };
}

export function ChatBubble({
  open,
  onToggle,
  alert = false,
  side = "left",
}: {
  open: boolean;
  onToggle: () => void;
  alert?: boolean;
  side?: "left" | "right";
}) {
  return (
    <button
      type="button"
      data-alert={alert || undefined}
      onClick={onToggle}
      onPointerDown={(e) => e.stopPropagation()}
      aria-label={alert && !open ? "Chat, waiting on you" : "Chat"}
      aria-expanded={open}
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
        fontSize: "var(--text-base)",
        cursor: "pointer",
        boxShadow: "var(--loki-shadow-panel)",
        zIndex: LAYER.bubble,
      }}
    >
      {open ? <Glyph icon={XIcon} size={18} /> : <Glyph icon={MessageSquareIcon} size={18} />}
      {alert && !open && (
        <span
          aria-hidden
          style={{
            position: "absolute",
            top: -2,
            right: -2,
            width: 12,
            height: 12,
            borderRadius: "var(--radius-md)",
            background: "var(--loki-attention)",
            border: "2px solid var(--loki-bg)",
          }}
        />
      )}
    </button>
  );
}

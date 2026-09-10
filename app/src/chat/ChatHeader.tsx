import { IconButton } from "../components";
import type { ChatPlacement, ChatWidth } from "./ChatWindow";

/**
 * The panel's top row: the width toggle and close on the right. The desk's name is in the title
 * bar, and the conversation's switchers (model, permission mode) sit under the message box, so the
 * top of the chat stays quiet.
 */
export function ChatHeader({ width, placement, onToggleWidth, onClose }: { width: ChatWidth; placement: ChatPlacement; onToggleWidth?: () => void; onClose: () => void }) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "flex-end",
        alignItems: "center",
        gap: 2,
        padding: "2px 8px",
        minHeight: 28,
        borderBottom: "1px solid var(--loki-border)",
        position: "relative",
        zIndex: 2,
      }}
    >
      {onToggleWidth && placement !== "center" && (
        <IconButton size={24} onClick={onToggleWidth} label={width === "wide" ? "narrow chat" : "wide chat"}>
          <WidthIcon wide={width === "wide"} />
        </IconButton>
      )}
      <IconButton size={24} onClick={onClose} label="close chat" style={{ fontSize: 13.5 }}>
        ×
      </IconButton>
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

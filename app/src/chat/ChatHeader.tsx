import { IconButton } from "../ui";
import { ModelChip, ModelPicker, type ModelEntry } from "./ModelPicker";
import { ModeChip, ModeMenu, isPermissionMode } from "./PermissionMode";
import type { ModelAndMode } from "./useModelAndMode";
import type { ChatPlacement, ChatStatus, ChatWidth } from "./ChatWindow";

/**
 * The panel's top row: the model and mode chips on the left (the desk's name is in the title
 * bar) with their popovers, the width toggle and close on the right. The chips only appear when
 * the host can act on them.
 */
export function ChatHeader({
  status,
  model,
  models,
  mode,
  hasModelPicker,
  hasModeMenu,
  controls,
  width,
  placement,
  onToggleWidth,
  onClose,
}: {
  status: ChatStatus;
  model: string | null;
  models: ModelEntry[] | null;
  mode: string | null;
  hasModelPicker: boolean;
  hasModeMenu: boolean;
  controls: ModelAndMode;
  width: ChatWidth;
  placement: ChatPlacement;
  onToggleWidth?: () => void;
  onClose: () => void;
}) {
  const current = isPermissionMode(mode) ? mode : null;
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        gap: 10,
        padding: "2px 8px 2px 12px",
        minHeight: 28,
        borderBottom: "1px solid var(--loki-border)",
        position: "relative",
        zIndex: 2,
      }}
    >
      {/* The model chip on the left (the desk's name is in the title bar), the two controls on the right. */}
      <span style={{ display: "inline-flex", alignItems: "center", gap: 8, minWidth: 0, position: "relative" }}>
        {hasModelPicker && <ModelChip model={model} busy={controls.switching} onClick={controls.togglePicker} />}
        {hasModeMenu && <ModeChip mode={current} busy={controls.changingMode} onClick={controls.toggleMode} />}
        <span className="loki-label" style={{ fontSize: 9.5, color: "var(--loki-muted)", opacity: 0.7 }}>{statusWord(status)}</span>
      </span>
      <ModeMenu open={controls.modeOpen} current={current} onPick={(m) => void controls.pickMode(m)} onClose={controls.closeMode} />
      <ModelPicker open={controls.pickerOpen} current={model} entries={models} loading={!models} onPick={(h) => void controls.pickModel(h)} onClose={controls.closePicker} />
      <span style={{ display: "flex", gap: 2, alignItems: "center" }}>
        {onToggleWidth && placement !== "center" && (
          <IconButton size={24} onClick={onToggleWidth} label={width === "wide" ? "narrow chat" : "wide chat"}>
            <WidthIcon wide={width === "wide"} />
          </IconButton>
        )}
        <IconButton size={24} onClick={onClose} label="close chat" style={{ fontSize: 13.5 }}>
          ×
        </IconButton>
      </span>
    </div>
  );
}

function statusWord(status: ChatStatus): string {
  if (status === "thinking") return "thinking…";
  if (status === "streaming") return "replying…";
  return "";
}

/** A panel outline with its divider on the side the toggle will move it to. */
function WidthIcon({ wide }: { wide: boolean }) {
  return wide ? (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5" /><path d="M6.5 2.5v11" /></svg>
  ) : (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5" /><path d="M10.5 2.5v11" /></svg>
  );
}

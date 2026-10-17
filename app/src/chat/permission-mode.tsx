import { useEffect, useRef } from "react";
import { Chip, Meta, Popover, Row } from "../components";
import type { ChatEngineView } from "../../../core/models.ts";
import type { ModelAndMode } from "./use-model-and-mode";

/**
 * The four permission modes loki's daemon knows, per conversation (daemon/approvals.ts). Set with chat_open { mode }
 * and kept on the chat by the daemon; read back from the chat's device event (live) or its desk info (the mod).
 */
export type PermissionMode = "strict" | "standard" | "acceptEdits" | "unrestricted";

/** One mode the chip and menu offer: loki's own, or an ACP agent's (plan 020, KD10). `fill` is how full its shield is. */
export interface ModeChoice {
  id: string;
  label: string;
  short: string;
  description: string;
  fill: number;
}

/** The permission modes, from most asking to none, with the labels the mode menu and chip show. */
export const MODES: Array<ModeChoice & { id: PermissionMode }> = [
  { id: "strict", label: "Strict", short: "strict", description: "asks before every tool, reads included", fill: 1 },
  { id: "standard", label: "Standard", short: "standard", description: "asks before edits and commands; reads run freely", fill: 0.6 },
  { id: "acceptEdits", label: "Accept edits", short: "edits ok", description: "file edits run without asking; commands still ask", fill: 0.3 },
  { id: "unrestricted", label: "Unrestricted", short: "no asking", description: "nothing asks — every tool runs", fill: 0 },
];

/** A mode that lets everything run, which the chip shows in red so an open door is never quiet. */
const isOpenDoor = (id: string) => id === "unrestricted" || /bypass/i.test(id);

/**
 * An ACP agent's own modes as the chip and menu show them, in the agent's order and words (Claude Code's default,
 * acceptEdits, plan, bypassPermissions); a mode that lets everything run has an empty shield.
 */
export function agentModes(engine: ChatEngineView): ModeChoice[] {
  return engine.modes.map((m) => ({
    id: m.id,
    label: m.name,
    short: m.name.toLowerCase(),
    description: m.description ?? `${engine.name}'s ${m.name.toLowerCase()} mode`,
    fill: isOpenDoor(m.id) ? 0 : 0.5,
  }));
}

/** Whether a value names a permission mode. */
export function isPermissionMode(v: unknown): v is PermissionMode {
  return v === "strict" || v === "standard" || v === "acceptEdits" || v === "unrestricted";
}

/** The mode's labels; an unknown or unset mode reads as unrestricted, the daemon's default (daemon/approvals.ts). */
export const modeInfo = (m: PermissionMode | null | undefined) => MODES.find((x) => x.id === m) ?? MODES[3];

/** The mode's labels among `modes` (an agent's); among loki's own when there are none. */
function choiceOf(mode: string | null, modes: ModeChoice[] | undefined): ModeChoice {
  if (!modes) return modeInfo(isPermissionMode(mode) ? mode : null);
  return modes.find((m) => m.id === mode) ?? { id: mode ?? "", label: mode ?? "mode", short: mode ?? "mode", description: "", fill: 0.5 };
}

/** The chip: the mode's short name; red ink when nothing will ask, so an open door is never quiet. */
export function ModeChip({
  mode,
  modes,
  onClick,
  busy,
  className,
}: {
  mode: string | null;
  /** An ACP agent's modes (agentModes); absent, loki's own four. */
  modes?: ModeChoice[];
  onClick: () => void;
  busy?: boolean;
  className?: string;
}) {
  const info = choiceOf(mode, modes);
  const loud = isOpenDoor(info.id);
  return (
    <Chip
      className={className}
      style={loud ? { color: "var(--loki-negative)", borderColor: "var(--loki-negative)" } : undefined}
      onClick={onClick}
      title={`permissions: ${info.label} — ${info.description}. Click to change for this conversation`}
      aria-label="permission mode"
      aria-busy={busy || undefined}
    >
      <Shield fill={info.fill} />
      {busy ? "changing…" : info.short}
      <span aria-hidden style={{ fontSize: 9.5 }}>
        ▾
      </span>
    </Chip>
  );
}

/** The same shield, filled more the more the mode asks. */
function Shield({ fill }: { fill: number }) {
  return (
    <svg width="10" height="11" viewBox="0 0 10 11" aria-hidden>
      <path d="M5 .8 9 2.3v3.2c0 2.3-1.7 4-4 4.9C2.7 9.5 1 7.8 1 5.5V2.3z" fill="currentColor" fillOpacity={fill} stroke="currentColor" strokeWidth="1" />
    </svg>
  );
}

/** The menu: a row with a line for each mode (loki's four, or the agent's own); ↑↓ / Enter / Esc, or click. */
export function ModeMenu({
  open,
  current,
  modes = MODES,
  onPick,
  onClose,
  anchor = "left",
  side,
}: {
  open: boolean;
  current: string | null;
  modes?: ModeChoice[];
  onPick: (m: string) => void;
  onClose: () => void;
  anchor?: "left" | "right";
  side?: "below" | "above";
}) {
  const ref = useRef<HTMLDivElement>(null);
  // loki's chats default to unrestricted (daemon/approvals.ts); an agent's to its first mode.
  const selected = current ?? (modes === MODES ? "unrestricted" : modes.length ? modes[0].id : null);
  useEffect(() => {
    if (!open) return;
    const el = ref.current;
    const idx = Math.max(
      0,
      modes.findIndex((m) => m.id === selected),
    );
    el?.querySelectorAll<HTMLElement>('[role="menuitemradio"]')[idx]?.focus();
  }, [open, selected, modes]);
  if (!open) return null;
  return (
    <Popover
      ref={ref}
      role="menu"
      aria-label="permission mode"
      anchor={anchor}
      side={side}
      width={300}
      style={{ padding: 4 }}
      onKeyDown={(e) => {
        const items = [...(ref.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? [])];
        const i = items.indexOf(document.activeElement as HTMLElement);
        if (e.key === "ArrowDown") items[Math.min(items.length - 1, i + 1)]?.focus();
        else if (e.key === "ArrowUp") items[Math.max(0, i - 1)]?.focus();
        else if (e.key === "Escape") onClose();
        else return;
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      {modes.map((m) => (
        <Row
          key={m.id}
          dense
          role="menuitemradio"
          aria-checked={m.id === selected}
          onClick={() => onPick(m.id)}
          style={{ display: "grid", gridTemplateColumns: "16px 1fr auto", gap: 8 }}
        >
          <span style={{ color: isOpenDoor(m.id) ? "var(--loki-negative)" : "var(--loki-muted)", display: "grid", placeItems: "center" }}>
            <Shield fill={m.fill} />
          </span>
          <span style={{ display: "grid" }}>
            <span style={{ fontSize: 13.5 }}>{m.label}</span>
            <span className="loki-meta loki-meta--wrap" style={{ lineHeight: 1.4 }}>
              {m.description}
            </span>
          </span>
          <span style={{ fontSize: 10.5, color: "var(--loki-accent)" }}>{m.id === selected ? "current" : ""}</span>
        </Row>
      ))}
      <div style={{ padding: "5px 8px 3px" }}>
        <Meta>applies to this conversation · esc</Meta>
      </div>
    </Popover>
  );
}

/** The chip under the message box with its menu above it: the conversation's mode, loki's or its agent's. */
export function ModeSwitch({ mode, modes, controls }: { mode: string | null; modes?: ModeChoice[]; controls: ModelAndMode }) {
  return (
    <span className="loki-mode-anchor">
      <ModeChip className="loki-model-pill loki-mode-pill" mode={mode} modes={modes} busy={controls.changingMode} onClick={controls.toggleMode} />
      <ModeMenu open={controls.modeOpen} side="above" current={mode} modes={modes} onPick={(m) => void controls.pickMode(m)} onClose={controls.closeMode} />
    </span>
  );
}

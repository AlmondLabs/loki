import { useEffect, useRef, type ButtonHTMLAttributes, type ReactElement } from "react";
import { Chip, Meta, Popover, Row } from "../components";
import type { ChatEngineView } from "../../../core/models.ts";
import { DEFAULT_MODE, isPermissionMode, type PermissionMode } from "../../../core/chat-links.ts";
import type { ModelAndMode } from "./use-model-and-mode";
import { popUpMenu, under, NATIVE_MENUS, type MenuEntry } from "../shell/native-menu";

export interface ModeChoice {
  id: string;
  label: string;
  short: string;
  description: string;
  fill: number;
}

export const MODES: Array<ModeChoice & { id: PermissionMode }> = [
  { id: "strict", label: "Strict", short: "strict", description: "asks before every tool, reads included", fill: 1 },
  { id: "standard", label: "Standard", short: "standard", description: "asks before edits and commands; reads run freely", fill: 0.6 },
  { id: "acceptEdits", label: "Accept Edits", short: "edits ok", description: "file edits run without asking; commands still ask", fill: 0.3 },
  { id: "unrestricted", label: "Unrestricted", short: "no asking", description: "nothing asks — every tool runs", fill: 0 },
];

const isOpenDoor = (id: string) => id === "unrestricted" || /bypass/i.test(id);

export function agentModes(engine: ChatEngineView): ModeChoice[] {
  return engine.modes.map((m) => ({
    id: m.id,
    label: m.name,
    short: m.name.toLowerCase(),
    description: m.description ?? `${engine.name}'s ${m.name.toLowerCase()} mode`,
    fill: isOpenDoor(m.id) ? 0 : 0.5,
  }));
}

export const modeInfo = (m: PermissionMode | null | undefined) => MODES.find((x) => x.id === m) ?? MODES[3];

function choiceOf(mode: string | null, modes: ModeChoice[] | undefined): ModeChoice {
  if (!modes) return modeInfo(isPermissionMode(mode) ? mode : null);
  return modes.find((m) => m.id === mode) ?? { id: mode ?? "", label: mode ?? "mode", short: mode ?? "mode", description: "", fill: 0.5 };
}

export function ModeChip({
  mode,
  modes,
  busy,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  mode: string | null;
  modes?: ModeChoice[];
  busy?: boolean;
}) {
  const info = choiceOf(mode, modes);
  const loud = isOpenDoor(info.id);
  return (
    <Chip
      {...rest}
      style={loud ? { color: "var(--loki-negative)", borderColor: "var(--loki-negative)" } : undefined}
      title={`Permissions: ${info.label} — ${info.description}. Click to change for this conversation`}
      aria-label={`${busy ? "changing…" : info.short}, permission mode${loud ? ", nothing asks" : ""}`}
      aria-busy={busy || undefined}
    >
      <Shield fill={info.fill} />
      {busy ? "changing…" : info.short}
      <span aria-hidden style={{ fontSize: "var(--text-xs)" }}>
        ▾
      </span>
    </Chip>
  );
}

function Shield({ fill }: { fill: number }) {
  return (
    <svg width="10" height="11" viewBox="0 0 10 11" aria-hidden>
      <path d="M5 .8 9 2.3v3.2c0 2.3-1.7 4-4 4.9C2.7 9.5 1 7.8 1 5.5V2.3z" fill="currentColor" fillOpacity={fill} stroke="currentColor" strokeWidth="1" />
    </svg>
  );
}

export function ModeMenu({
  trigger,
  open,
  onOpenChange,
  current,
  modes = MODES,
  onPick,
  anchor = "left",
  side,
}: {
  trigger: ReactElement<ButtonHTMLAttributes<HTMLButtonElement>>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  current: string | null;
  modes?: ModeChoice[];
  onPick: (m: string) => void;
  anchor?: "left" | "right";
  side?: "below" | "above";
}) {
  const ref = useRef<HTMLDivElement>(null);
  const selected = current ?? (modes === MODES ? DEFAULT_MODE : modes.length ? modes[0].id : null);
  const at = Math.max(
    0,
    modes.findIndex((m) => m.id === selected),
  );
  return (
    <Popover
      ref={ref}
      trigger={trigger}
      open={open}
      onOpenChange={onOpenChange}
      touch
      role="menu"
      aria-label="Permission mode"
      anchor={anchor}
      side={side}
      width={300}
      initialFocus={() => ref.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]')[at]}
      style={{ padding: 4 }}
      onKeyDown={(e) => {
        const items = [...(ref.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? [])];
        const i = items.indexOf(document.activeElement as HTMLElement);
        if (e.key === "ArrowDown") items[Math.min(items.length - 1, i + 1)]?.focus();
        else if (e.key === "ArrowUp") items[Math.max(0, i - 1)]?.focus();
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
          <span className="grid place-items-center" style={{ color: isOpenDoor(m.id) ? "var(--loki-negative)" : "var(--loki-muted)" }}>
            <Shield fill={m.fill} />
          </span>
          <span className="grid">
            <span style={{ fontSize: "var(--text-sm)" }}>{m.label}</span>
            <span className="loki-meta loki-meta--wrap" style={{ lineHeight: 1.4 }}>
              {m.description}
            </span>
          </span>
          <span style={{ fontSize: "var(--text-xs)", color: "var(--loki-accent)" }}>{m.id === selected ? "✓" : ""}</span>
        </Row>
      ))}
      <div style={{ padding: "4px 8px" }}>
        <Meta>Applies to this conversation · esc</Meta>
      </div>
    </Popover>
  );
}

export const titleCase = (label: string) => label.replace(/(^|\s)([a-z])/g, (_, lead: string, c: string) => lead + c.toUpperCase());

export function selectedMode(current: string | null, modes: ModeChoice[]): string | null {
  return current ?? (modes === MODES ? DEFAULT_MODE : modes.length ? modes[0].id : null);
}

export function modeMenuEntries(current: string | null, modes: ModeChoice[], onPick: (m: string) => void): MenuEntry[] {
  const selected = selectedMode(current, modes);
  return modes.map((m): MenuEntry => ({ type: "item", id: `mode-${m.id}`, label: titleCase(m.label), checked: m.id === selected, run: () => onPick(m.id) }));
}

export function ModeSwitch({ mode, modes, controls }: { mode: string | null; modes?: ModeChoice[]; controls: ModelAndMode }) {
  const native = NATIVE_MENUS;
  const chip = useRef<HTMLSpanElement>(null);
  const latest = useRef({ mode, modes, controls });
  useEffect(() => {
    latest.current = { mode, modes, controls };
  });
  const open = native && controls.modeOpen;
  useEffect(() => {
    const el = chip.current;
    if (!open || !el) return;
    const { mode: m, modes: list, controls: c } = latest.current;
    void popUpMenu(
      modeMenuEntries(m, list ?? MODES, (id) => void c.pickMode(id)),
      under(el),
    )
      .catch((e: unknown) => console.warn("loki: mode menu", e))
      .finally(() => latest.current.controls.closeMode());
  }, [open]);
  return (
    <span ref={chip} className="loki-mode-anchor">
      {native ? (
        <ModeChip className="loki-model-pill loki-mode-pill" mode={mode} modes={modes} busy={controls.changingMode} onClick={controls.toggleMode} />
      ) : (
        <ModeMenu
          trigger={<ModeChip className="loki-model-pill loki-mode-pill" mode={mode} modes={modes} busy={controls.changingMode} />}
          open={controls.modeOpen}
          onOpenChange={(next) => (next ? !controls.modeOpen && controls.toggleMode() : controls.closeMode())}
          side="above"
          current={mode}
          modes={modes}
          onPick={(m) => void controls.pickMode(m)}
        />
      )}
    </span>
  );
}

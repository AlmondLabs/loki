import { useEffect, useState, type ReactNode } from "react";
import { SEGMENTS } from "./shortcuts";
import { LAYER } from "../kit/layers";
import { countText } from "../components";
import { inDesktop, platform, type Platform } from "../workspace/env";
import { currentWindow, invoke } from "./desktop";
import { ariaShortcut, keyFor, type Segment } from "./keymap";
import { TitleMenu } from "./title-menu";
import { PanelLeftIcon } from "lucide-react";
import { Glyph, Icon, type IconName } from "../shared/icons";
import { columnsStore } from "./columns";
import { loadSidebar, saveSidebar, toggleFold, type SidebarPref } from "./sidebar-model";

export function titlebarHeight(shell: boolean = inDesktop, os: Platform = platform): number {
  return !shell ? 0 : os === "macos" ? 28 : 32;
}
export const TITLEBAR_HEIGHT = titlebarHeight();

export const GLASS_INSET = 8;
export const GLASS_HEAD = 44;
/**
 * The Mac window's traffic lights, in px from its top-left corner: the close button's left edge, the zoom button's
 * right edge and the buttons' centre line. AppKit lays them out itself in the window's title bar, the shell's
 * `traffic_lights` command says where, and the page puts its toolbar row on them, read at boot (`adoptTrafficLights`);
 * until then these are where a 52 pt unified title bar has them.
 */
export const GLASS_LIGHTS = { left: 20, right: 74, middle: 26 };
export async function adoptTrafficLights(ask: () => Promise<unknown> = () => invoke("traffic_lights")): Promise<void> {
  const said = await ask().catch(() => null);
  if (typeof said !== "object" || said === null) return;
  const { left, right, middle } = said as Record<string, unknown>;
  if (typeof left === "number" && typeof right === "number" && typeof middle === "number" && right > left && middle > 0) {
    Object.assign(GLASS_LIGHTS, { left: Math.round(left), right: Math.round(right), middle: Math.round(middle) });
  }
}
const LIGHTS_GAP = 18;
export function sidebarToggleLeft(shell: boolean = inDesktop, os: Platform = platform): number {
  return shell && os === "macos" ? GLASS_LIGHTS.right + LIGHTS_GAP : 16;
}
export const PLACES_INSET = 12;
export const PLACE_PADDING = 8;
const TOGGLE = { box: 28, symbolInset: 5 };
export function sidebarToggleLeftShown(sidebarWidth: number, shell: boolean = inDesktop, os: Platform = platform): number {
  if (!(shell && os === "macos")) return sidebarToggleLeft(shell, os);
  return GLASS_INSET + sidebarWidth - (PLACES_INSET + PLACE_PADDING - TOGGLE.symbolInset) - TOGGLE.box;
}
export function sidebarClearance(shell: boolean = inDesktop, os: Platform = platform): number {
  if (shell && os === "macos") return GLASS_INSET - LIST_BOX_INSET;
  return sidebarToggleLeft(shell, os) + 36 + (shell ? 0 : 32);
}
const LIST_BOX_INSET = 4;
export const LIST_BAR = { padding: 16, gap: 8 };
export function sidebarLeadRoom(shell: boolean = inDesktop, os: Platform = platform): number {
  if (!(shell && os === "macos")) return 0;
  return sidebarToggleLeft(shell, os) + TOGGLE.box + 8 - sidebarClearance(shell, os) - LIST_BAR.padding - LIST_BAR.gap;
}
export function paneTop(shell: boolean = inDesktop, os: Platform = platform): number {
  return shell && os === "macos" ? Math.max(0, GLASS_LIGHTS.middle - 26) : titlebarHeight(shell, os);
}
export function sidebarToggleTop(shell: boolean = inDesktop, os: Platform = platform): number {
  return shell && os === "macos" ? GLASS_LIGHTS.middle - 14 : GLASS_INSET + 8;
}

export function TitleStrip({ os = platform, shell = inDesktop, menuLabels = {} }: { os?: Platform; shell?: boolean; menuLabels?: Record<string, string> }) {
  const height = titlebarHeight(shell, os);
  if (!height) return null;
  if (os === "macos") return <div data-drag-region="" aria-hidden className="loki-title-strip" style={{ height, zIndex: LAYER.rail }} />;
  return <OwnTitleStrip os={os} height={height} menuLabels={menuLabels} />;
}

function OwnTitleStrip({ os, height, menuLabels }: { os: Platform; height: number; menuLabels: Record<string, string> }) {
  const maximized = useMaximized();
  return (
    <div data-drag-region="" className="loki-title-strip loki-title-strip--own" style={{ height, zIndex: LAYER.strip }}>
      <TitleMenu os={os} labels={menuLabels} />
      <WindowControls maximized={maximized} onAction={windowAction} />
    </div>
  );
}

export type WindowAction = "minimize" | "toggleMaximize" | "close";

function windowAction(action: WindowAction) {
  const win = currentWindow();
  void win[action]().catch((e: unknown) => console.warn(`loki: window ${action}`, e));
}

function useMaximized(): boolean {
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    let live = true;
    let off: (() => void) | null = null;
    const win = currentWindow();
    void win
      .isMaximized()
      .then((m) => live && setMaximized(m))
      .then(() => win.onResized((m) => live && setMaximized(m)))
      .then((unlisten) => {
        if (live) off = unlisten;
        else unlisten();
      })
      .catch((e: unknown) => console.warn("loki: window maximised", e));
    return () => {
      live = false;
      off?.();
    };
  }, []);
  return maximized;
}

const glyph = { width: 10, height: 10, viewBox: "0 0 10 10", fill: "none", stroke: "currentColor", strokeWidth: 1 } as const;

export function WindowControls({ maximized, onAction }: { maximized: boolean; onAction: (action: WindowAction) => void }) {
  const max = maximized ? "Restore" : "Maximise";
  return (
    <div className="loki-window-controls">
      <button type="button" className="loki-title-btn" aria-label="Minimise" title="Minimise" onClick={() => onAction("minimize")}>
        <svg {...glyph} aria-hidden>
          <path d="M0 5.5h10" />
        </svg>
      </button>
      <button type="button" className="loki-title-btn" aria-label={max} title={max} onClick={() => onAction("toggleMaximize")}>
        <svg {...glyph} aria-hidden>
          {maximized ? <path d="M2.5 2.5V.5h7v7h-2M.5 2.5h7v7h-7z" /> : <rect x="0.5" y="0.5" width="9" height="9" />}
        </svg>
      </button>
      <button type="button" className="loki-title-btn loki-title-btn--close" aria-label="Close" title="Close" onClick={() => onAction("close")}>
        <svg {...glyph} aria-hidden>
          <path d="M.5.5l9 9M9.5.5l-9 9" />
        </svg>
      </button>
    </div>
  );
}

const PLACE_ICON: Record<Segment, IconName> = { chats: "desk", flow: "inbox", goals: "target", agents: "agents", learn: "learn", settings: "settings" };

export interface PlaceSource {
  id: string;
  title: string;
  icon?: IconName;
  face?: ReactNode;
  count: number;
  live?: boolean;
}

export interface PlaceSources {
  items: readonly PlaceSource[];
  selected: string;
  onSelect: (id: string) => void;
  action?: { label: string; icon?: IconName; onRun: () => void };
}

function savedFolds(): SidebarPref {
  const store = columnsStore();
  return store ? loadSidebar(store) : { collapsed: [] };
}

export function Places({
  segment,
  onSelect,
  waiting,
  dueCards = 0,
  goalsAttention = 0,
  sources = {},
}: {
  segment: Segment;
  onSelect: (s: Segment) => void;
  waiting: number;
  dueCards?: number;
  goalsAttention?: number;
  sources?: Partial<Record<Segment, PlaceSources>>;
}) {
  const [folds, setFolds] = useState(savedFolds);
  const fold = (id: string) => {
    const next = toggleFold(folds, id);
    setFolds(next);
    const store = columnsStore();
    if (store) saveSidebar(store, next);
  };
  return (
    <div className="loki-places">
      {SEGMENTS.filter((s) => s.id !== "settings").map((s) => {
        const count = s.id === "flow" ? waiting : s.id === "learn" ? dueCards : s.id === "goals" ? goalsAttention : 0;
        const said = s.id === "flow" ? `${count} waiting` : s.id === "goals" ? `${count} needing focus` : `${count} due`;
        const own = sources[s.id];
        const here = segment === s.id;
        if (!own)
          return (
            <button
              key={s.id}
              type="button"
              className="loki-place"
              aria-current={here ? "page" : undefined}
              aria-label={count > 0 ? `${s.label}, ${said}` : s.label}
              title={`${s.label} (${s.key})`}
              aria-keyshortcuts={ariaShortcut(s.key)}
              onClick={() => onSelect(s.id)}
            >
              <span className="loki-place-icon">
                <Icon name={PLACE_ICON[s.id]} size={18} />
              </span>
              <span className="loki-place-label">{s.label}</span>
              {count > 0 && (
                <span aria-hidden className="loki-place-count">
                  {countText(count)}
                </span>
              )}
            </button>
          );
        const folded = folds.collapsed.includes(s.id);
        const headingId = `loki-place-heading-${s.id}`;
        return (
          <div key={s.id} className="loki-place-group">
            <div className="loki-place-head">
              <span id={headingId} className="loki-place-heading">
                {s.label}
              </span>
              {own.action && (
                <button type="button" className="loki-place-action" aria-label={own.action.label} title={own.action.label} onClick={own.action.onRun}>
                  <Icon name={own.action.icon ?? "plus"} size={12} />
                </button>
              )}
              <button
                type="button"
                className="loki-place-fold"
                aria-expanded={!folded}
                aria-label={`${s.label} sources`}
                title={folded ? "Show" : "Hide"}
                onClick={() => fold(s.id)}
              >
                <Icon name="chevron-down" size={12} className={folded ? "loki-list-section-chev loki-list-section-chev--folded" : "loki-list-section-chev"} />
              </button>
            </div>
            {!folded && (
              <ul className="loki-place-sources" aria-labelledby={headingId}>
                {own.items.map((it, i) => (
                  <li key={it.id}>
                    <button
                      type="button"
                      className="loki-place"
                      aria-current={here && own.selected === it.id ? "page" : undefined}
                      aria-label={[it.title, it.live && "working", it.count > 0 && `${it.count} waiting`].filter(Boolean).join(", ")}
                      title={i === 0 ? `${s.label} (${s.key})` : undefined}
                      onClick={() => own.onSelect(it.id)}
                    >
                      <span className="loki-place-icon">
                        {it.face ?? (it.icon && <Icon name={it.icon} size={16} />)}
                        {it.live && <span aria-hidden className="loki-list-row-live" />}
                      </span>
                      <span className="loki-place-label">{it.title}</span>
                      {it.count > 0 && (
                        <span aria-hidden className="loki-place-count">
                          {countText(it.count)}
                        </span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function ColumnToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <button
      onClick={onToggle}
      aria-label={open ? "Hide sidebar" : "Show sidebar"}
      aria-pressed={open}
      title={`${open ? "Hide" : "Show"} sidebar (${keyFor("column.toggle")})`}
      aria-keyshortcuts={ariaShortcut(keyFor("column.toggle"))}
      className="loki-rail loki-sidebar-toggle grid place-items-center"
      style={{
        marginTop: 0,
        width: 28,
        height: 28,
        border: "1px solid transparent",
        borderRadius: "var(--radius-lg)",
        background: "transparent",
        color: "var(--loki-muted)",
        cursor: "pointer",
        padding: 0,
      }}
    >
      <Glyph icon={PanelLeftIcon} size={18} />
    </button>
  );
}

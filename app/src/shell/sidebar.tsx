import { useEffect, useState, type ReactNode } from "react";
import { SEGMENTS } from "./shortcuts";
import { LAYER } from "../kit/layers";
import { countText } from "../components";
import { inTauri, platform, type Platform } from "../desk/env";
import { ariaShortcut, keyFor, type Segment } from "./keymap";
import { TitleMenu } from "./title-menu";
import { PanelLeftIcon } from "lucide-react";
import { Glyph, Icon, type IconName } from "../shared/icons";
import { columnsStore } from "./columns";
import { loadSidebar, saveSidebar, toggleFold, type SidebarPref } from "./sidebar-model";

/**
 * The native title bar is hidden (src-tauri/src/lib.rs: overlay style on the Mac, undecorated on Windows and Linux),
 * so loki draws the top edge: a strip across the window, the sidebar and the views under it. On the Mac it is the
 * traffic lights' standard height; elsewhere it carries loki's own window buttons, at the height Windows gives its
 * caption buttons. A browser tab has its own chrome, so there it is nothing.
 */
export function titlebarHeight(shell: boolean = inTauri, os: Platform = platform): number {
  return !shell ? 0 : os === "macos" ? 28 : 32;
}
/** The top strip's height in px on this system (see `titlebarHeight`); 0 in a browser tab. */
export const TITLEBAR_HEIGHT = titlebarHeight();

/** Liquid Glass's sidebar (U12): its gap from the window's edges, in px. */
export const GLASS_INSET = 8;
/** Liquid Glass's sidebar: the height of its top row, where the traffic lights and the sidebar toggle sit, in px. */
export const GLASS_HEAD = 44;
/**
 * The Mac window's traffic lights, in px from its top-left corner: the close button's left edge, the zoom button's
 * right edge and the buttons' centre line. AppKit lays them out itself in the window's toolbar (src-tauri native.rs
 * add_unified_toolbar), and the page puts its toolbar row on them, read at boot (`adoptTrafficLights`); until then
 * these are where a 52 pt unified title bar has them.
 */
export const GLASS_LIGHTS = { left: 20, right: 74, middle: 26 };
/**
 * Read where AppKit put the Mac window's lights into `GLASS_LIGHTS`, before the page first draws (boot.tsx), so the
 * toggle and the title bars line up with them on any macOS. A shell that cannot say keeps the defaults.
 */
export async function adoptTrafficLights(): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  const said: unknown = await invoke("traffic_lights").catch(() => null);
  if (typeof said !== "object" || said === null) return;
  const { left, right, middle } = said as Record<string, unknown>;
  if (typeof left === "number" && typeof right === "number" && typeof middle === "number" && right > left && middle > 0) {
    Object.assign(GLASS_LIGHTS, { left: Math.round(left), right: Math.round(right), middle: Math.round(middle) });
  }
}
/** The gap between the zoom button and the sidebar toggle's box on the Mac, in px. */
const LIGHTS_GAP = 18;
/** Where Liquid Glass's sidebar toggle sits from the window's left edge: past the traffic lights on the Mac's window, else near the edge. */
export function sidebarToggleLeft(shell: boolean = inTauri, os: Platform = platform): number {
  return shell && os === "macos" ? GLASS_LIGHTS.right + LIGHTS_GAP : 16;
}
/** The sidebar's places list's side padding (`.loki-places`, components.css), in px. */
export const PLACES_INSET = 12;
/** A place row's side padding (`.loki-place`, components.css), in px: where its count ends. */
export const PLACE_PADDING = 8;
/** The sidebar toggle's box, in px, and the gap between its edge and its 18 px symbol's. */
const TOGGLE = { box: 28, symbolInset: 5 };
/**
 * Where the toggle sits while the sidebar shows, from the window's left edge, in px. On the Mac's window it goes to the
 * sidebar's trailing end, its symbol's edge in line with the rows' counts (`PLACES_INSET` and `PLACE_PADDING` in from
 * the panel's edge), as Mail's and Finder's do; folded, it returns beside the lights (`sidebarToggleLeft`). Elsewhere
 * it stays at the leading edge, where ☰ sits beside it in a browser tab.
 */
export function sidebarToggleLeftShown(sidebarWidth: number, shell: boolean = inTauri, os: Platform = platform): number {
  if (!(shell && os === "macos")) return sidebarToggleLeft(shell, os);
  return GLASS_INSET + sidebarWidth - (PLACES_INSET + PLACE_PADDING - TOGGLE.symbolInset) - TOGGLE.box;
}
/**
 * Where the list starts while the sidebar is folded, in px (columns.ts). On the Mac it is 4 from the window's edge, as
 * Mail's is near it: the list's boxes then sit 8 in, the glass sidebar's own inset, and its text 20 in. The lights and the toggle share the title bars' row, so only the leading title bar makes room for them
 * (`sidebarLeadRoom`). Elsewhere the column starts past the toggle (28 px and a gap), 52 on Windows and Linux, and in a
 * browser tab past ☰ beside it too (32 more), so 84.
 */
export function sidebarClearance(shell: boolean = inTauri, os: Platform = platform): number {
  if (shell && os === "macos") return GLASS_INSET - LIST_BOX_INSET;
  return sidebarToggleLeft(shell, os) + 36 + (shell ? 0 : 32);
}
/** The list column's boxes' inset from its edge (rows and search, docs/design.md), in px. */
const LIST_BOX_INSET = 4;
/** The list bar's start padding and its gap (`.loki-content-list-bar`, components.css), in px. */
export const LIST_BAR = { padding: 16, gap: 8 };
/**
 * The width of a leading title bar's room for the lights and the toggle while the sidebar is folded (`LeadRoom`), in
 * px: enough that the list bar's title, after its padding and gap, starts past the toggle and a gap of 8; the detail's
 * bars pad 4 more, so theirs starts a little further. Elsewhere the column
 * itself clears the toggle, so 0.
 */
export function sidebarLeadRoom(shell: boolean = inTauri, os: Platform = platform): number {
  if (!(shell && os === "macos")) return 0;
  return sidebarToggleLeft(shell, os) + TOGGLE.box + 8 - sidebarClearance(shell, os) - LIST_BAR.padding - LIST_BAR.gap;
}
/**
 * Where the list and the detail start from the window's top, in px. On the Mac their 52 px title bars sit on the
 * lights' row, centred on it as Mail's toolbar is; elsewhere they start under the top strip (`titlebarHeight`).
 */
export function paneTop(shell: boolean = inTauri, os: Platform = platform): number {
  return shell && os === "macos" ? Math.max(0, GLASS_LIGHTS.middle - 26) : titlebarHeight(shell, os);
}
/** The toggle's top, in px: its 28 px box centred on the lights' row, or near the panel's top elsewhere. */
export function sidebarToggleTop(shell: boolean = inTauri, os: Platform = platform): number {
  return shell && os === "macos" ? GLASS_LIGHTS.middle - 14 : GLASS_INSET + 8;
}

/**
 * The window's top edge, Slack style, and it drags the window (a double click zooms, or maximises). On the Mac the
 * lights float at its left and nothing interactive goes in it. On Windows and Linux (plan 014 KTD4) it is Slack's
 * there: ☰ at the left with the menus the Mac's menu bar shows, minimise, maximise and close at the right. The
 * attribute is bare so only the strip itself drags, never its buttons.
 */
export function TitleStrip({ os = platform, shell = inTauri, menuLabels = {} }: { os?: Platform; shell?: boolean; menuLabels?: Record<string, string> }) {
  const height = titlebarHeight(shell, os);
  if (!height) return null;
  if (os === "macos") return <div data-tauri-drag-region aria-hidden className="loki-title-strip" style={{ height, zIndex: LAYER.rail }} />;
  return <OwnTitleStrip os={os} height={height} menuLabels={menuLabels} />;
}

function OwnTitleStrip({ os, height, menuLabels }: { os: Platform; height: number; menuLabels: Record<string, string> }) {
  const maximized = useMaximized();
  return (
    <div data-tauri-drag-region className="loki-title-strip loki-title-strip--own" style={{ height, zIndex: LAYER.strip }}>
      <TitleMenu os={os} labels={menuLabels} />
      <WindowControls maximized={maximized} onAction={windowAction} />
    </div>
  );
}

/** What loki's own window buttons do on Windows and Linux. */
export type WindowAction = "minimize" | "toggleMaximize" | "close";

/** The shell's window, its module loaded on first use; out here because an import() inside a hook keeps the React Compiler off it. */
const currentWindow = () => import("@tauri-apps/api/window").then(({ getCurrentWindow }) => getCurrentWindow());

function windowAction(action: WindowAction) {
  void currentWindow()
    .then((win) => win[action]())
    .catch((e: unknown) => console.warn(`loki: window ${action}`, e));
}

/** Whether the window is maximised, read at mount and again on every resize (maximising, restoring, a snap). */
function useMaximized(): boolean {
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    let live = true;
    let off: (() => void) | null = null;
    void currentWindow()
      .then(async (win) => {
        const read = () => win.isMaximized().then((m) => live && setMaximized(m));
        await read();
        const unlisten = await win.onResized(() => void read());
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

/** Minimise, maximise (Restore while maximised) and close, the Windows way: flat, full strip height, close turns red. */
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

/** Each place's icon, by loki's icon names: the same as ⌘K and the menus use. */
const PLACE_ICON: Record<Segment, IconName> = { desk: "desk", inbox: "inbox", agents: "agents", learn: "learn", settings: "settings" };

/** One source under a place in the sidebar: its id, its name, its symbol or face, and the grey count of what waits in it. */
export interface PlaceSource {
  id: string;
  title: string;
  icon?: IconName;
  /** A face in place of the symbol: an agent's. */
  face?: ReactNode;
  count: number;
  /** An agent at work: Slack's green dot at the face's corner. */
  live?: boolean;
}

/** A place's sources under its heading (plan 2026-11-15-1035, R6): Chats' All Chats, Pinned and Archived; Flow's Everything and lanes; the agents; Learn's views. */
export interface PlaceSources {
  items: readonly PlaceSource[];
  /** The source showing in the list. */
  selected: string;
  onSelect: (id: string) => void;
}

/** The sidebar's folds as saved; fresh when the page may not keep them. */
function savedFolds(): SidebarPref {
  const store = columnsStore();
  return store ? loadSidebar(store) : { collapsed: [] };
}

/**
 * The sidebar's head (plan 2026-11-12-1505, U12; plan 2026-11-15-1035, U4): the window's places as Mail lists its
 * mailboxes. A place with sources is a small grey heading that is not a row, as Mail's Favourites is, with its sources
 * under it as the rows you choose: Chats' All Chats, Pinned and Archived; Flow's Everything and the person's lanes; the
 * agents; Learn's views. A row is the name in the label colour with a symbol or face before it and a grey count after;
 * the row showing is filled and takes the accent. A disclosure chevron on the heading's hover folds its sources, and
 * the folds outlive restarts. A place without sources is a row of its own. Preferences is not a row: it is ⌘, and the
 * menu bar's, as on every Mac app.
 */
export function Places({
  segment,
  onSelect,
  waiting,
  dueCards = 0,
  sources = {},
}: {
  segment: Segment;
  onSelect: (s: Segment) => void;
  waiting: number;
  dueCards?: number;
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
    // Inside the sidebar's own navigation landmark (list-column.tsx), so not a second one.
    <div className="loki-places">
      {SEGMENTS.filter((s) => s.id !== "settings").map((s) => {
        const count = s.id === "inbox" ? waiting : s.id === "learn" ? dueCards : 0;
        const said = s.id === "inbox" ? `${count} waiting` : `${count} due`;
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
                      // The place's key (⌘1 to ⌘4) shows the place; its first source names it in the tooltip.
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

/**
 * Show / hide the sidebar (⌃⌘S). On the Mac it floats at the sidebar's trailing end, level with the traffic lights,
 * and beside them while the sidebar is hidden, as Mail's does (`sidebarToggleLeftShown`).
 */
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

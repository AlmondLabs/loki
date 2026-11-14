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
 * The Mac window's traffic lights (src-tauri lib.rs traffic_light_position): the close button's top-left, in points.
 * They sit inside Liquid Glass's inset sidebar, and its toggle is centred on them.
 */
export const GLASS_LIGHTS = { x: 20, y: 22 };
/** Where Liquid Glass's sidebar toggle sits from the window's left edge: past the traffic lights on the Mac's window, else near the edge. */
export function sidebarToggleLeft(shell: boolean = inTauri, os: Platform = platform): number {
  return shell && os === "macos" ? 92 : 16;
}
/** Where the list starts while the sidebar is folded, in px: past the toggle (28 px and a gap), so 128 on the Mac and 52 elsewhere (columns.ts). */
export function sidebarClearance(shell: boolean = inTauri, os: Platform = platform): number {
  return sidebarToggleLeft(shell, os) + 36;
}
/** The toggle's top, in px: its 28 px box centred on the lights' row (14 pt buttons), or near the panel's top elsewhere. */
export function sidebarToggleTop(shell: boolean = inTauri, os: Platform = platform): number {
  return shell && os === "macos" ? GLASS_LIGHTS.y + 7 - 14 : GLASS_INSET + 8;
}

/**
 * The window's top edge, Slack style, and it drags the window (a double click zooms, or maximises). On the Mac the
 * lights float at its left and nothing interactive goes in it. On Windows and Linux (plan 014 KTD4) it is Slack's
 * there: ☰ at the left with the menus the Mac's menu bar shows, minimise, maximise and close at the right. The
 * attribute is bare so only the strip itself drags, never its buttons.
 */
export function TitleStrip({ os = platform, shell = inTauri }: { os?: Platform; shell?: boolean }) {
  const height = titlebarHeight(shell, os);
  if (!height) return null;
  if (os === "macos") return <div data-tauri-drag-region aria-hidden className="loki-title-strip" style={{ height, zIndex: LAYER.rail }} />;
  return <OwnTitleStrip os={os} height={height} />;
}

function OwnTitleStrip({ os, height }: { os: Platform; height: number }) {
  const maximized = useMaximized();
  return (
    <div data-tauri-drag-region className="loki-title-strip loki-title-strip--own" style={{ height, zIndex: LAYER.strip }}>
      <TitleMenu os={os} />
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

/** A place's sources under its row (plan 2026-11-14-1330, R1): Chats' Pinned, one per agent, and Archived; Flow's lanes; the agents. */
export interface PlaceSources {
  items: readonly PlaceSource[];
  /** The source showing in the list. */
  selected: string;
  /** The source the place's own row stands for: every chat, for Chats (R4). */
  all: string;
  onSelect: (id: string) => void;
}

/** The sidebar's folds as saved; fresh when the page may not keep them. */
function savedFolds(): SidebarPref {
  const store = columnsStore();
  return store ? loadSidebar(store) : { collapsed: [] };
}

/**
 * The sidebar's head (plan 2026-11-12-1505, U12): the window's places as the source list's first rows, as Mail lists
 * its mailboxes. Each row is a symbol in the accent, the place's name and a grey count
 * (what waits in Flow, the cards due in Learn); the place showing is filled, never bold. Preferences is not a row: it is
 * ⌘, and the menu bar's, as on every Mac app. A place with sources lists them under its row, one level down, with a
 * disclosure chevron at the row's trailing edge that folds them; the rows are the same in every place, and choosing a
 * source moves only the selection (plan 2026-11-14-1330, R1). The folds outlive restarts.
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
        const row = (
          <button
            key={s.id}
            type="button"
            className="loki-place"
            // With sources, the place's row is current only while it stands for the source showing (every chat).
            aria-current={here && (!own || own.selected === own.all) ? "page" : undefined}
            aria-label={count > 0 ? `${s.label}, ${said}` : s.label}
            title={`${s.label} (${s.key})`}
            aria-keyshortcuts={ariaShortcut(s.key)}
            onClick={() => (own ? own.onSelect(own.all) : onSelect(s.id))}
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
        if (!own) return row;
        const folded = folds.collapsed.includes(s.id);
        return (
          <div key={s.id} className="loki-place-group">
            <div className="loki-place-head">
              {row}
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
              <ul className="loki-place-sources" aria-label={`${s.label} sources`}>
                {own.items.map((it) => (
                  <li key={it.id}>
                    <button
                      type="button"
                      className="loki-place loki-place--source"
                      aria-current={here && own.selected === it.id ? "page" : undefined}
                      aria-label={[it.title, it.live && "working", it.count > 0 && `${it.count} waiting`].filter(Boolean).join(", ")}
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

/** Show / hide the sidebar (⌃⌘S), floating beside the traffic lights, where it stays while the sidebar is hidden, as Mail's does. */
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
        borderRadius: "var(--loki-radius-md)",
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

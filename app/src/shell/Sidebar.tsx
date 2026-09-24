import { useEffect, useState } from "react";
import { SEGMENTS, type Segment } from "./shortcuts";
import { LAYER } from "../kit/layers";
import { Dot } from "../components";
import { inTauri, platform, type Platform } from "../desk/env";
import { keyFor } from "./keymap";
import { TitleMenu } from "./TitleMenu";

export const SIDEBAR_WIDTH = 48;
/**
 * The native title bar is hidden (src-tauri/src/lib.rs: overlay style on the Mac, undecorated on Windows and Linux),
 * so loki draws the top edge: a strip across the window, the rail and the views under it. On the Mac it is the
 * traffic lights' standard height; elsewhere it carries loki's own window buttons, at the height Windows gives its
 * caption buttons. A browser tab has its own chrome, so there it is nothing.
 */
export function titlebarHeight(shell: boolean = inTauri, os: Platform = platform): number {
  return !shell ? 0 : os === "macos" ? 28 : 32;
}
export const TITLEBAR_HEIGHT = titlebarHeight();

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

export type WindowAction = "minimize" | "toggleMaximize" | "close";

function windowAction(action: WindowAction) {
  void import("@tauri-apps/api/window").then(({ getCurrentWindow }) => getCurrentWindow()[action]()).catch((e) => console.warn(`loki: window ${action}`, e));
}

/** Whether the window is maximised, read at mount and again on every resize (maximising, restoring, a snap). */
function useMaximized(): boolean {
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    let live = true;
    let off: (() => void) | null = null;
    void import("@tauri-apps/api/window")
      .then(async ({ getCurrentWindow }) => {
        const win = getCurrentWindow();
        const read = () => win.isMaximized().then((m) => live && setMaximized(m));
        await read();
        const unlisten = await win.onResized(() => void read());
        if (live) off = unlisten;
        else unlisten();
      })
      .catch((e) => console.warn("loki: window maximised", e));
    return () => {
      live = false;
      off?.();
    };
  }, []);
  return maximized;
}

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

const glyph = { width: 10, height: 10, viewBox: "0 0 10 10", fill: "none", stroke: "currentColor", strokeWidth: 1 } as const;

/**
 * The rail under the top strip: six segments and nothing else. The inbox icon carries
 * the waiting count — the same number the tray title and the dock badge show — and ticks
 * when it grows.
 */
export function Sidebar({
  segment,
  onSelect,
  waiting,
  tick,
  openTasks = 0,
  dueCards = 0,
  lanOn = false,
  updateReady = false,
  column = null,
}: {
  segment: Segment;
  onSelect: (s: Segment) => void;
  waiting: number;
  tick: boolean;
  /** Open tasks on the board, shown quietly under its icon. */
  openTasks?: number;
  /** Cards due in Learn, the same quiet way. */
  dueCards?: number;
  /** The mod is reachable on the Wi‑Fi (Settings › phone): a green dot on the settings icon while it is. */
  lanOn?: boolean;
  /** A newer loki release exists (Settings › letta says which): the same dot. */
  updateReady?: boolean;
  /** The showing section's list column (ListColumn), when it has one: a toggle above Settings, pressed while the column shows. */
  column?: { open: boolean; onToggle: () => void } | null;
}) {
  return (
    <nav
      aria-label="sections"
      onPointerDown={(e) => e.stopPropagation()}
      style={{
        position: "absolute",
        top: TITLEBAR_HEIGHT,
        left: 0,
        bottom: 0,
        width: SIDEBAR_WIDTH,
        boxSizing: "border-box",
        borderRight: "1px solid var(--loki-border)",
        background: "var(--loki-panel)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        padding: "10px 0",
        gap: 6,
        zIndex: LAYER.rail,
      }}
    >
      {SEGMENTS.map((s) => {
        const active = segment === s.id;
        const isInbox = s.id === "inbox";
        return (
          <span key={s.id} style={{ display: "contents" }}>
            {s.id === "settings" && column && <ColumnToggle {...column} />}
            <span style={{ display: "grid", placeItems: "center", marginTop: s.id === "settings" && !column ? "auto" : 0 }}>
              <button
                onClick={() => onSelect(s.id)}
                aria-label={isInbox && waiting > 0 ? `${s.label}, ${waiting} waiting` : s.id === "board" && openTasks > 0 ? `${s.label}, ${openTasks} open` : s.id === "learn" && dueCards > 0 ? `${s.label}, ${dueCards} due` : s.id === "settings" && updateReady ? `${s.label}, a newer loki is out` : s.id === "settings" && lanOn ? `${s.label}, phones can reach this Mac` : s.label}
                aria-pressed={active}
                title={`${s.label} (${s.key})`}
                className={`loki-rail${isInbox && tick ? " loki-tick" : ""}`}
                style={{
                  position: "relative",
                  width: 36,
                  height: 36,
                  display: "grid",
                  placeItems: "center",
                  border: "1px solid transparent",
                  borderRadius: "var(--loki-radius-md)",
                  background: active ? "var(--loki-selection)" : "transparent",
                  color: active ? "var(--loki-fg)" : "var(--loki-muted)",
                  cursor: "pointer",
                  padding: 0,
                }}
              >
                <Icon id={s.id} />
                {/* Badges like the Dock's: the red attention badge when something needs you (inbox), quiet for a count you chose to keep (board). */}
                {isInbox && waiting > 0 && <Badge n={waiting} tone="attention" />}
                {s.id === "board" && openTasks > 0 && <Badge n={openTasks} tone="quiet" />}
                {s.id === "learn" && dueCards > 0 && <Badge n={dueCards} tone="quiet" />}
                {/* A newer loki is out (the accent), or the listener is on and the page is reachable from the Wi‑Fi (a green dot, D11). */}
                {s.id === "settings" && (lanOn || updateReady) && <Dot aria-hidden halo color={updateReady ? "var(--loki-accent)" : "var(--loki-positive)"} style={{ position: "absolute", top: 3, right: 3 }} />}
              </button>
              <span className="loki-label" style={{ fontSize: 9.5, marginTop: 2, color: active ? "var(--loki-fg)" : "var(--loki-muted)" }}>
                {s.label}
              </span>
            </span>
          </span>
        );
      })}
    </nav>
  );
}

/** Show / hide the list column (⌘⇧D, Slack's sidebar key): a panel with its left pane, above Settings. */
function ColumnToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <button
      onClick={onToggle}
      aria-label={open ? "Hide sidebar" : "Show sidebar"}
      aria-pressed={open}
      title={`${open ? "Hide" : "Show"} sidebar (${keyFor("column.toggle")})`}
      className="loki-rail"
      style={{ marginTop: "auto", width: 36, height: 28, display: "grid", placeItems: "center", border: "1px solid transparent", borderRadius: "var(--loki-radius-md)", background: "transparent", color: "var(--loki-muted)", cursor: "pointer", padding: 0 }}
    >
      <svg {...common} aria-hidden>
        <rect x="2.5" y="3.5" width="15" height="13" rx="1.5" />
        <path d="M7.5 3.5v13" />
        {open && <path d="M4.5 7h1M4.5 9.5h1" />}
      </svg>
    </button>
  );
}

function Badge({ n, tone }: { n: number; tone: "attention" | "quiet" }) {
  return (
    <span
      aria-hidden
      style={{
        position: "absolute",
        top: -5,
        right: -5,
        minWidth: 17,
        height: 17,
        padding: "0 5px",
        boxSizing: "border-box",
        borderRadius: 9,
        background: tone === "attention" ? "var(--loki-attention)" : "var(--loki-muted)",
        color: tone === "attention" ? "var(--loki-on-attention)" : "var(--loki-bg)",
        border: "2px solid var(--loki-panel)",
        fontSize: 9.5,
        fontWeight: 700,
        lineHeight: "13px",
        textAlign: "center",
        fontVariantNumeric: "tabular-nums",
      }}
    >
      {n > 99 ? "99+" : n}
    </span>
  );
}

/** Every rail icon: an 18px 20-unit box, hairline strokes. */
const common = { width: 18, height: 18, viewBox: "0 0 20 20", fill: "none", stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };

function Icon({ id }: { id: Segment }) {
  if (id === "desk") {
    // a sheet with two plates on it
    return (
      <svg {...common} aria-hidden>
        <rect x="2.5" y="3.5" width="15" height="13" rx="1.5" />
        <rect x="5" y="6" width="5" height="4" rx="0.8" />
        <rect x="11.5" y="6" width="3.5" height="8" rx="0.8" />
      </svg>
    );
  }
  if (id === "inbox") {
    // a tray
    return (
      <svg {...common} aria-hidden>
        <path d="M3 11.5V15a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 17 15v-3.5" />
        <path d="M3 11.5h4l1.2 2h3.6l1.2-2h4" />
        <path d="M5.5 11.5 7 4.5h6l1.5 7" />
      </svg>
    );
  }
  if (id === "board") {
    // three columns of cards
    return (
      <svg {...common} aria-hidden>
        <rect x="2.5" y="3.5" width="4" height="13" rx="0.8" />
        <rect x="8" y="3.5" width="4" height="8" rx="0.8" />
        <rect x="13.5" y="3.5" width="4" height="10.5" rx="0.8" />
      </svg>
    );
  }
  if (id === "learn") {
    // two cards, one behind the other
    return (
      <svg {...common} aria-hidden>
        <rect x="4.5" y="2.5" width="12" height="9" rx="1.2" />
        <path d="M2.5 7.5v8a2 2 0 0 0 2 2h9.5" />
        <path d="M8 6.5h5M8 8.75h3" />
      </svg>
    );
  }
  if (id === "agents") {
    // two faces
    return (
      <svg {...common} aria-hidden>
        <circle cx="7" cy="7.5" r="3" />
        <path d="M2.5 16.5c0-2.8 2-4.5 4.5-4.5s4.5 1.7 4.5 4.5" />
        <circle cx="14" cy="8.5" r="2.4" />
        <path d="M13 12.6c2.6 0 4.5 1.6 4.5 3.9" />
      </svg>
    );
  }
  // settings: a set square and a pencil, drafting-table style
  return (
    <svg {...common} aria-hidden>
      <path d="M3.5 16.5 12 3.5l4.5 13z" />
      <path d="M8.5 16.5 12 9l2.5 7.5" />
    </svg>
  );
}

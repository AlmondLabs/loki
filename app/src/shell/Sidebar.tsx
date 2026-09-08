import { SEGMENTS, type Segment } from "./shortcuts";
import { LAYER } from "../kit/layers";
import { Dot } from "../ui";

export const SIDEBAR_WIDTH = 48;

/**
 * The rail under the title bar: five segments and nothing else. The inbox icon carries
 * the waiting count — the same number the tray title and the dock badge show — and ticks
 * when it grows. The desk icon is also the tree's toggle, so it reads pressed while the
 * tree is out.
 */
export function Sidebar({
  segment,
  onSelect,
  waiting,
  tick,
  treeOpen,
  openTasks = 0,
  lanOn = false,
}: {
  segment: Segment;
  onSelect: (s: Segment) => void;
  waiting: number;
  tick: boolean;
  treeOpen: boolean;
  /** Open tasks on the board, shown quietly under its icon. */
  openTasks?: number;
  /** The mod is reachable on the Wi‑Fi (Settings › phone): a brass dot on the settings icon while it is. */
  lanOn?: boolean;
}) {
  return (
    <nav
      aria-label="sections"
      onPointerDown={(e) => e.stopPropagation()}
      style={{
        position: "absolute",
        top: 0,
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
        const active = segment === s.id || (s.id === "desk" && treeOpen);
        const isInbox = s.id === "inbox";
        return (
          <span key={s.id} style={{ display: "grid", placeItems: "center", marginTop: s.id === "settings" ? "auto" : 0 }}>
            <button
              onClick={() => onSelect(s.id)}
              aria-label={isInbox && waiting > 0 ? `${s.label}, ${waiting} waiting` : s.id === "board" && openTasks > 0 ? `${s.label}, ${openTasks} open` : s.id === "settings" && lanOn ? `${s.label}, phones can reach this Mac` : s.label}
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
                borderRadius: 8,
                background: active ? "var(--loki-accent-soft)" : "transparent",
                color: active ? "var(--loki-fg)" : "var(--loki-muted)",
                cursor: "pointer",
                padding: 0,
              }}
            >
              <Icon id={s.id} />
              {/* Badges like the Dock's: brass when something needs you (inbox), quiet for a count you chose to keep (board). */}
              {isInbox && waiting > 0 && <Badge n={waiting} tone="accent" />}
              {s.id === "board" && openTasks > 0 && <Badge n={openTasks} tone="quiet" />}
              {/* The listener is on: the page is reachable from the Wi‑Fi, which is worth a brass dot (D11). */}
              {s.id === "settings" && lanOn && <Dot aria-hidden halo color="var(--loki-accent)" style={{ position: "absolute", top: 3, right: 3 }} />}
            </button>
            <span className="loki-label" style={{ fontSize: 9.5, letterSpacing: "0.14em", marginTop: 2, color: active ? "var(--loki-fg)" : "var(--loki-muted)" }}>
              {s.label}
            </span>
          </span>
        );
      })}
    </nav>
  );
}

function Badge({ n, tone }: { n: number; tone: "accent" | "quiet" }) {
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
        background: tone === "accent" ? "var(--loki-accent)" : "var(--loki-muted)",
        color: "var(--loki-bg)",
        border: "2px solid var(--loki-panel)",
        fontFamily: "var(--loki-mono)",
        fontSize: 9.5,
        fontWeight: 600,
        lineHeight: "13px",
        textAlign: "center",
        fontVariantNumeric: "tabular-nums",
      }}
    >
      {n > 99 ? "99+" : n}
    </span>
  );
}

function Icon({ id }: { id: Segment }) {
  const common = { width: 18, height: 18, viewBox: "0 0 20 20", fill: "none", stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
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

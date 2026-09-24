/**
 * The keymap: every shortcut in loki, in one table. The window's single key handler dispatches
 * from it, Settings renders it, and the native menu bar is built from it (the Rust side receives
 * the same table at startup). A shortcut exists here or nowhere.
 *
 * Grammar: "cmd+shift+a", "cmd+]", "enter", "shift+backspace", "left". cmd is ⌘ on a Mac and Ctrl
 * elsewhere. `typing` says whether a binding fires while a text box has focus: plain letters never
 * do; chords may, except the ones the text itself uses (⌘Z, ⌘⌫, ⌘←, ⌘→, ⌘A, ⌘C, ⌘V, ⌘X are the text's).
 *
 * Each system reads its own words (formatKeys), and a Mac key the system keeps for itself on Windows or Linux
 * is swapped for another in `keysOn`, so matching, the menu and every listing use the same key (plan 014 U2).
 */
import { platform, type Platform } from "../desk/env";

export type { Platform };
export type Segment = "desk" | "inbox" | "board" | "learn" | "agents" | "settings";
export type Where = "anywhere" | Segment | "chat" | "global";

export interface Binding {
  /** Stable id; the action registry and the menu use it. */
  id: string;
  keys: string[];
  /** The keys on Windows or Linux where the Mac's are the system's there (keysOf); [] when the binding has none there. */
  keysOn?: Partial<Record<"windows" | "linux", string[]>>;
  where: Where;
  /** Human label, as shown in Settings and the menu. */
  label: string;
  /** Fires while a text box has focus? Default false. */
  typing?: boolean;
  /** Menu placement: "<menu>" or "<menu>/<group>" for a separator group. Absent: not in the menu. */
  menu?: string;
  /** Show the accelerator in the menu (macOS then fires it when the page does not handle the key). Default true when `menu` is set. */
  menuAccel?: boolean;
  /** Not dispatched by the keymap (documented only): the view or the OS owns it. */
  note?: string;
  /** What the key did before a redesign changed its job, and where that job went; the keys sheet and Settings › keys say it (R30). `{id}` reads as that binding's key (wasFor). */
  was?: string;
}

export const MENUS = ["Desk", "Chat", "Inbox", "Board", "Learn", "View"] as const;

export const KEYMAP: Binding[] = [
  // --- anywhere ------------------------------------------------------
  { id: "segment.desk", keys: ["cmd+1"], where: "anywhere", label: "Desk", typing: true, menu: "View/segments" },
  { id: "segment.inbox", keys: ["cmd+2"], where: "anywhere", label: "Inbox", typing: true, menu: "View/segments" },
  { id: "segment.board", keys: ["cmd+3"], where: "anywhere", label: "Board", typing: true, menu: "View/segments" },
  { id: "segment.agents", keys: ["cmd+4"], where: "anywhere", label: "Agents", typing: true, menu: "View/segments" },
  { id: "segment.learn", keys: ["cmd+5"], where: "anywhere", label: "Learn", typing: true, menu: "View/segments" },
  { id: "segment.settings", keys: ["cmd+6", "cmd+,"], where: "anywhere", label: "Settings…", typing: true, menu: "View/segments" },
  // Slack's ⌘K: search desks, agents, waiting items and pages; it toggles, so ⌘K again closes it.
  { id: "search.open", keys: ["cmd+k"], where: "anywhere", label: "Search", typing: true, menu: "Desk", was: "was the desks tree: desks are in the sidebar now ({column.toggle} shows or hides it)" },
  { id: "desk.new", keys: ["cmd+n"], where: "anywhere", label: "New Desk…", typing: true, menu: "Desk" },
  { id: "task.new", keys: ["cmd+t"], where: "anywhere", label: "New Task…", typing: true, menu: "Board" },
  // Slack's sidebar key. The inbox has no list column, so there ⌘⇧D stays Deny (its own binding wins; takenBy lists it so).
  { id: "column.toggle", keys: ["cmd+shift+d"], where: "anywhere", label: "Show / Hide Sidebar", typing: true, menu: "View/column" },
  { id: "window.hide", keys: ["cmd+shift+w"], where: "anywhere", label: "Hide loki", typing: true },
  { id: "keys.sheet", keys: ["shift+/"], where: "anywhere", label: "Keys for This View", menu: "View/help" },
  { id: "layer.peel", keys: ["escape"], where: "anywhere", label: "close the topmost layer", note: "handled by the layer" },

  // --- desk ----------------------------------------------------------
  // ⌘[ and ⌘] step through what a section is made of: desks here, cards in the inbox, columns on the
  // board, views in Learn, agents in Agents, pages in Settings. Never "the next desk" from somewhere else.
  { id: "desk.prev", keys: ["cmd+["], where: "desk", label: "Previous Desk", typing: true, menu: "Desk/step" },
  { id: "desk.next", keys: ["cmd+]"], where: "desk", label: "Next Desk", typing: true, menu: "Desk/step" },
  // Done is the Inbox's clear (seen); opening a desk only views it. The desk's header menu offers the same, and Mark as Not Done.
  { id: "desk.done", keys: ["cmd+shift+enter"], where: "desk", label: "Mark as Done", typing: true, menu: "Desk/done" },
  { id: "chat.toggle", keys: ["cmd+/"], where: "desk", label: "Show / Hide Chat", typing: true, menu: "Chat" },
  { id: "chat.close", keys: ["cmd+w"], where: "desk", label: "Close Chat", typing: true, menu: "Chat" },
  { id: "chat.focus", keys: ["cmd+l"], where: "desk", label: "Focus Message Box", typing: true, menu: "Chat" },
  { id: "chat.find", keys: ["cmd+f"], where: "desk", label: "Find in Transcript…", typing: true, menu: "Chat" },
  { id: "chat.model", keys: ["cmd+shift+m"], where: "desk", label: "Change Model…", typing: true, menu: "Chat" },
  { id: "chat.mode", keys: ["cmd+shift+p"], where: "desk", label: "Change Permission Mode…", typing: true, menu: "Chat" },
  // Ctrl+Alt+arrows are the system's off the Mac (workspaces on Linux, screen rotation on Windows, where Ctrl+Alt is also AltGr).
  { id: "chat.left", keys: ["cmd+left", "alt+cmd+left"], keysOn: { windows: ["cmd+left", "cmd+shift+["], linux: ["cmd+left", "cmd+shift+["] }, where: "desk", label: "Move Chat Left", typing: true, menu: "Chat/place", menuAccel: false },
  { id: "chat.right", keys: ["cmd+right", "alt+cmd+right"], keysOn: { windows: ["cmd+right", "cmd+shift+]"], linux: ["cmd+right", "cmd+shift+]"] }, where: "desk", label: "Move Chat Right", typing: true, menu: "Chat/place", menuAccel: false },
  { id: "view.fit", keys: ["cmd+0"], where: "desk", label: "Fit All Widgets", typing: true, menu: "View" },
  { id: "view.reset", keys: ["cmd+shift+0"], where: "desk", label: "Actual Size (1:1)", typing: true, menu: "View" },
  { id: "view.zoomIn", keys: ["cmd+=", "cmd+shift+="], where: "desk", label: "Zoom In", typing: true, menu: "View" },
  { id: "view.zoomOut", keys: ["cmd+-"], where: "desk", label: "Zoom Out", typing: true, menu: "View" },
  { id: "desk.arrange", keys: ["cmd+shift+a"], where: "desk", label: "Arrange Widgets", typing: true, menu: "Desk/sheet" },
  { id: "desk.undo", keys: ["cmd+z"], where: "desk", label: "Undo Widget Move", menu: "Desk/sheet", menuAccel: false },
  { id: "desk.messages", keys: ["escape"], where: "desk", label: "back to Messages from the Desk tab", note: "handled by the shell" },

  // --- chat (the box owns these) ---------------------------------------
  { id: "chat.send", keys: ["enter"], where: "chat", label: "send", typing: true, note: "the box" },
  { id: "chat.newline", keys: ["shift+enter"], where: "chat", label: "new line", typing: true, note: "the box" },
  { id: "chat.dictate", keys: ["cmd+d"], where: "chat", label: "dictate", typing: true, note: "the box" },

  // --- inbox (the reply box usually has focus: chords) -------------------
  { id: "inbox.next", keys: ["cmd+]", "right"], where: "inbox", label: "Next Card", typing: true, menu: "Inbox" },
  { id: "inbox.later", keys: ["cmd+[", "left"], where: "inbox", label: "Later (backs off each time)", typing: true, menu: "Inbox" },
  { id: "inbox.approve", keys: ["cmd+enter", "a"], where: "inbox", label: "Approve", typing: true, menu: "Inbox/decide" },
  { id: "inbox.deny", keys: ["cmd+shift+d", "d"], where: "inbox", label: "Deny", typing: true, menu: "Inbox/decide" },
  { id: "inbox.open", keys: ["cmd+o", "o"], where: "inbox", label: "Open the Desk", typing: true, menu: "Inbox/go" },
  { id: "inbox.reply", keys: ["r"], where: "inbox", label: "reply (focus the box)" },
  { id: "inbox.snoozed", keys: ["cmd+s", "s"], where: "inbox", label: "Show Snoozed", typing: true, menu: "Inbox/go" },
  { id: "inbox.undo", keys: ["cmd+z", "z"], where: "inbox", label: "Undo Last Decision", menu: "Inbox/go", menuAccel: false },

  // --- board (nothing has focus by default: plain keys) ------------------
  { id: "board.up", keys: ["up"], where: "board", label: "move up" },
  { id: "board.down", keys: ["down"], where: "board", label: "move down" },
  { id: "board.left", keys: ["left"], where: "board", label: "previous column" },
  { id: "board.right", keys: ["right"], where: "board", label: "next column" },
  { id: "board.select", keys: ["x", "space"], where: "board", label: "select" },
  { id: "board.selectRange", keys: ["shift+x"], where: "board", label: "select a range" },
  { id: "board.assign", keys: ["enter"], where: "board", label: "Assign to a Desk…", menu: "Board/act" },
  { id: "board.dispatch", keys: ["cmd+enter"], where: "board", label: "Dispatch (assign and start now)…", typing: true, menu: "Board/act" },
  { id: "board.done", keys: ["backspace"], where: "board", label: "Done (strike from the board)", menu: "Board/act", menuAccel: false },
  { id: "board.blocked", keys: ["shift+backspace"], where: "board", label: "Blocked / Unblocked", menu: "Board/act", menuAccel: false },
  { id: "board.prevColumn", keys: ["cmd+["], where: "board", label: "Previous Column", typing: true, menu: "Board/step" },
  { id: "board.nextColumn", keys: ["cmd+]"], where: "board", label: "Next Column", typing: true, menu: "Board/step" },
  { id: "board.filter", keys: ["/"], where: "board", label: "filter" },
  { id: "board.refresh", keys: ["cmd+r"], where: "board", label: "Refresh Board", typing: true, menu: "Board" },
  { id: "board.clear", keys: ["escape"], where: "board", label: "clear the selection", note: "handled by the board" },

  // --- learn: one card at a time; the two answers only once the answer shows -------------------------
  { id: "recall.reveal", keys: ["space", "enter", "down"], where: "learn", label: "show the answer (then: got it)" },
  { id: "recall.again", keys: ["left", "1"], where: "learn", label: "again (shows the answer first)" },
  { id: "recall.good", keys: ["right", "2"], where: "learn", label: "got it (shows the answer first)" },
  { id: "recall.delete", keys: ["x", "backspace"], where: "learn", label: "Delete Card (the worker learns from it)", menu: "Learn", menuAccel: false },
  { id: "recall.undo", keys: ["z"], where: "learn", label: "Undo Delete", menu: "Learn", menuAccel: false },
  { id: "recall.edit", keys: ["e"], where: "learn", label: "Edit Card", menu: "Learn", menuAccel: false },
  { id: "recall.open", keys: ["cmd+o", "o"], where: "learn", label: "Open the Source Desk", typing: true, menu: "Learn/go" },
  { id: "recall.refresh", keys: ["cmd+r"], where: "learn", label: "Refresh", typing: true, menu: "Learn/go" },
  { id: "learn.prevView", keys: ["cmd+["], where: "learn", label: "Previous View", typing: true, menu: "Learn/step" },
  { id: "learn.nextView", keys: ["cmd+]"], where: "learn", label: "Next View", typing: true, menu: "Learn/step" },

  // --- agents / settings: the tabs across the top, the pages down the left ------------------------------
  // "settings" is Preferences, a sheet over the section showing: its keys resolve there while it is up (keySegment).
  { id: "agents.prev", keys: ["cmd+["], where: "agents", label: "previous agent", typing: true },
  { id: "agents.next", keys: ["cmd+]"], where: "agents", label: "next agent", typing: true },
  { id: "settings.prevPage", keys: ["cmd+["], where: "settings", label: "previous page", typing: true },
  { id: "settings.nextPage", keys: ["cmd+]"], where: "settings", label: "next page", typing: true },

  // --- global --------------------------------------------------------
  // The Mac's alone: Alt+Space is the window menu on Windows and Linux.
  { id: "global.inbox", keys: ["alt+space"], keysOn: { windows: [], linux: [] }, where: "global", label: "bring loki up on the inbox", note: "the OS" },
];

/** The Mac's key symbols: the one place in the app they are written. */
const MAC_SYMBOL: Record<string, string> = {
  cmd: "⌘",
  shift: "⇧",
  alt: "⌥",
  ctrl: "⌃",
  enter: "↵",
  backspace: "⌫",
  tab: "⇥",
  escape: "esc",
  space: "space",
  left: "←",
  right: "→",
  up: "↑",
  down: "↓",
};

/** Windows' and Linux's: the words on the keys, spaced apart. */
const WORD: Record<string, string> = {
  cmd: "Ctrl",
  shift: "Shift",
  alt: "Alt",
  ctrl: "Ctrl",
  enter: "Enter",
  backspace: "Backspace",
  tab: "Tab",
  escape: "Esc",
  space: "Space",
  left: "←",
  right: "→",
  up: "↑",
  down: "↓",
};

/**
 * "cmd+shift+a" → "⌘⇧A" on the Mac, "Ctrl Shift A" elsewhere; letters upper-cased, named keys as symbols or words;
 * the one shifted punctuation chord shows as the character it types.
 */
export function formatKeys(spec: string, os: Platform = platform): string {
  if (spec === "shift+/") return "?";
  const names = os === "macos" ? MAC_SYMBOL : WORD;
  return spec
    .split("+")
    .map((p) => names[p] ?? (p.length === 1 ? p.toUpperCase() : p))
    .join(os === "macos" ? "" : " ");
}

/** A binding's keys on a system: the Mac's, unless the system keeps one of them for itself (keysOn). */
export function keysOf(b: Binding, os: Platform = platform): string[] {
  return (os === "macos" ? undefined : b.keysOn?.[os]) ?? b.keys;
}

/** The key a binding shows, by id, as this system reads it: every shortcut the app prints comes through here or formatKeys. */
export function keyFor(id: string, os: Platform = platform, index = 0): string {
  const b = KEYMAP.find((x) => x.id === id);
  const k = b ? keysOf(b, os)[index] : undefined;
  if (!k) throw new Error(`keymap: no key ${index} for ${id} on ${os}`);
  return formatKeys(k, os);
}

/** A binding's `was` line with its `{id}` references read as keys. */
export function wasFor(b: Binding, os: Platform = platform): string | undefined {
  return b.was?.replace(/\{([\w.]+)\}/g, (_, id: string) => keyFor(id, os));
}

/** ⌘ held, as a view checking its own chord reads it: ⌘ alone on the Mac (Ctrl+D deletes forward in a Mac text box), Ctrl alone elsewhere. */
export function cmdHeld(e: Pick<KeyboardEvent, "metaKey" | "ctrlKey">, os: Platform = platform): boolean {
  return os === "macos" ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
}

/** Does this keyboard event match the spec? `cmd` accepts ⌘ or Ctrl, never both meanings at once. */
/**
 * Every binding whose chord this event is, whatever its scope: what the native menu bar might also fire for
 * the same keystroke. ⌘] is both "next card" (inbox) and "next desk" (anywhere); the key handler runs the
 * one for the showing segment, and the menu's echo — which carries the *other* id — must be dropped too.
 */
export function chordIds(e: KeyboardEvent, map: Binding[] = KEYMAP, os: Platform = platform): string[] {
  return map.filter((b) => keysOf(b, os).some((k) => matches(e, k))).map((b) => b.id);
}

export function matches(e: KeyboardEvent, spec: string): boolean {
  const parts = spec.split("+");
  const key = parts[parts.length - 1];
  const want = { cmd: parts.includes("cmd"), shift: parts.includes("shift"), alt: parts.includes("alt"), ctrl: parts.includes("ctrl") };
  const hasCmd = e.metaKey || e.ctrlKey;
  if (want.cmd !== hasCmd) return false;
  if (want.ctrl && !e.ctrlKey) return false;
  if (want.alt !== e.altKey) return false;
  // Shift: required when asked; tolerated for "=" (⌘⇧= is also zoom in on a Mac) via a separate spec.
  if (want.shift !== e.shiftKey && !(key.length === 1 && !/[a-z0-9]/.test(key) && !want.shift && !e.shiftKey)) return false;
  const k = e.key;
  switch (key) {
    case "enter":
      return k === "Enter";
    case "backspace":
      return k === "Backspace";
    case "escape":
      return k === "Escape";
    case "space":
      return k === " ";
    case "left":
      return k === "ArrowLeft";
    case "right":
      return k === "ArrowRight";
    case "up":
      return k === "ArrowUp";
    case "down":
      return k === "ArrowDown";
    default:
      // Letters compare case-insensitively (shift is checked above); punctuation compares as typed,
      // with the shifted forms of the digits and punctuation accepted for chords ("cmd+shift+0" arrives as "0" or ")").
      if (/^[a-z]$/.test(key)) return k.toLowerCase() === key;
      if (key === "0") return k === "0" || k === ")";
      if (key === "=") return k === "=" || k === "+";
      if (key === "-") return k === "-" || k === "_";
      if (key === ",") return k === "," || k === "<";
      if (key === "/") return k === "/" || k === "?";
      if (key === "[") return k === "[" || k === "{";
      if (key === "]") return k === "]" || k === "}";
      return k === key;
  }
}

/** True when the event's target is something you type into. */
export function typingIn(e: KeyboardEvent): boolean {
  const t = e.target as { tagName?: string; isContentEditable?: boolean } | null;
  if (!t) return false;
  return t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable === true;
}

/**
 * The binding an event triggers in the current context, or null. View bindings win over "anywhere"
 * so ⌘] can mean "next card" in the inbox and "next desk" on the desk. Bindings with a `note`
 * are documentation only.
 */
/** Chords the text itself uses: never taken while a box has focus, whatever a binding says. */
export const TEXT_CHORDS = new Set(["cmd+left", "cmd+right", "cmd+up", "cmd+down", "cmd+backspace", "cmd+z", "cmd+shift+z", "cmd+a", "cmd+c", "cmd+v", "cmd+x", "alt+left", "alt+right", "alt+backspace"]);

export function resolve(e: KeyboardEvent, segment: Segment, os: Platform = platform): Binding | null {
  const typing = typingIn(e);
  // A key fires while typing only if the binding allows it AND the key is a chord the text does not use:
  // a plain letter or arrow always belongs to the text, whatever the binding says.
  const live = (b: Binding, k: string) => matches(e, k) && (!typing || (b.typing === true && k.includes("cmd+") && !TEXT_CHORDS.has(k)));
  const hit = (where: Where) => KEYMAP.find((b) => !b.note && b.where === where && keysOf(b, os).some((k) => live(b, k))) ?? null;
  return hit(segment) ?? hit("anywhere");
}

/**
 * Where a view's own binding takes a key that works everywhere (resolve lets the view's win): ⌘⇧D is Deny in the
 * inbox, not the sidebar. The keys sheet leaves such a key out of that view's "everywhere" group; Settings says it.
 */
export function takenBy(b: Binding, map: Binding[] = KEYMAP, os: Platform = platform): Array<{ where: Where; key: string; id: string; label: string }> {
  if (b.where !== "anywhere" || b.note) return [];
  return map.flatMap((o) => (o.note || o.where === "anywhere" || o.where === "global" ? [] : keysOf(b, os).filter((k) => keysOf(o, os).includes(k)).map((key) => ({ where: o.where, key, id: o.id, label: o.label }))));
}

/** Bindings that share a key inside one scope — a mistake to catch in tests. With no system named, all three; another system's own clashes carry its name. */
export function conflicts(map: Binding[] = KEYMAP, os?: Platform): string[] {
  if (!os) {
    const mac = conflicts(map, "macos");
    const own = (o: Platform) => conflicts(map, o).filter((c) => !mac.includes(c)).map((c) => `${c} (${o})`);
    return [...mac, ...own("windows"), ...own("linux")];
  }
  const seen = new Map<string, string>();
  const out: string[] = [];
  for (const b of map) {
    if (b.note) continue;
    for (const k of keysOf(b, os)) {
      const key = `${b.where}:${k}`;
      const other = seen.get(key);
      if (other) out.push(`${k} in ${b.where}: ${other} and ${b.id}`);
      else seen.set(key, b.id);
    }
  }
  return out;
}

/** The menu bar, for the Rust side: sections in MENUS order, groups separated, accelerators in Tauri's grammar. */
export interface MenuSpec {
  title: string;
  items: Array<{ id: string; label: string; accelerator: string | null } | { separator: true }>;
}

const TAURI_KEY: Record<string, string> = {
  cmd: "CmdOrCtrl",
  shift: "Shift",
  alt: "Alt",
  ctrl: "Ctrl",
  enter: "Enter",
  backspace: "Backspace",
  escape: "Escape",
  space: "Space",
  left: "Left",
  right: "Right",
  up: "Up",
  down: "Down",
  "[": "BracketLeft",
  "]": "BracketRight",
  "/": "Slash",
  ",": "Comma",
  "=": "Equal",
  "-": "Minus",
};

export function tauriAccelerator(spec: string): string {
  return spec
    .split("+")
    .map((p) => TAURI_KEY[p] ?? (/^[0-9]$/.test(p) ? `Digit${p}` : p.toUpperCase()))
    .join("+");
}

export function menuSpec(map: Binding[] = KEYMAP, os: Platform = platform): MenuSpec[] {
  return MENUS.map((title) => {
    const mine = map.filter((b) => b.menu && b.menu.split("/")[0] === title);
    const items: MenuSpec["items"] = [];
    let lastGroup: string | undefined;
    for (const b of mine) {
      const group = b.menu!.split("/")[1];
      if (items.length && group !== lastGroup) items.push({ separator: true });
      lastGroup = group;
      const key = keysOf(b, os)[0];
      items.push({ id: b.id, label: b.label, accelerator: b.menuAccel === false || !key ? null : tauriAccelerator(key) });
    }
    return { title, items };
  }).filter((m) => m.items.length > 0);
}

/**
 * The dialogs up, for the shell's keys: none, only Preferences (the sheet marked data-preferences), only
 * search (data-search), or some other dialog, which wins over both (a sheet opened from a settings page).
 * The Board's desk picker is not a dialog here: it owns its keys (data-tree).
 */
export type DialogState = "none" | "preferences" | "search" | "other";
export function dialogState(root: ParentNode = document): DialogState {
  const up = [...root.querySelectorAll('[role="dialog"]:not([data-tree])')];
  if (up.length === 0) return "none";
  if (up.every((d) => d.hasAttribute("data-preferences"))) return "preferences";
  return up.every((d) => d.hasAttribute("data-search")) ? "search" : "other";
}

/**
 * Preferences lets the segment keys (⌘1-6, ⌘,) and its own page steps (⌘[ ⌘]) through; search lets only ⌘K
 * through, which closes it (Esc too, from the sheet), as Slack's does; every other dialog blocks every shell key.
 */
const PREFERENCES_KEYS = new Set(["settings.prevPage", "settings.nextPage"]);
export function shellKeyAllowed(dialog: DialogState, id: string): boolean {
  if (dialog === "none") return true;
  if (dialog === "other") return false;
  if (dialog === "search") return id === "search.open";
  return id.startsWith("segment.") || PREFERENCES_KEYS.has(id);
}

/** The scope keys resolve in: with Preferences up, "settings" (its bindings are its page steps), else the section showing. */
export function keySegment(segment: Segment, dialog: DialogState): Segment {
  return dialog === "preferences" ? "settings" : segment;
}

/** Rows for Settings, grouped by scope in display order. */
export const WHERE_ORDER: Where[] = ["anywhere", "desk", "chat", "inbox", "board", "learn", "agents", "settings", "global"];

/** Preferences › keys' table: every binding in WHERE_ORDER with this system's keys, less the ones it has no key for. */
export function keyRows(os: Platform = platform, map: Binding[] = KEYMAP): Binding[] {
  return WHERE_ORDER.flatMap((where) => map.filter((b) => b.where === where))
    .map((b) => ({ ...b, keys: keysOf(b, os) }))
    .filter((b) => b.keys.length > 0);
}

// --- the action registry: views register what their ids do; the shell dispatches ----------------
type Action = () => void;
const actions = new Map<string, Action>();

export function registerActions(map: Record<string, Action>): () => void {
  for (const [id, fn] of Object.entries(map)) actions.set(id, fn);
  return () => {
    for (const [id, fn] of Object.entries(map)) if (actions.get(id) === fn) actions.delete(id);
  };
}

export function runAction(id: string): boolean {
  const fn = actions.get(id);
  if (!fn) return false;
  fn();
  return true;
}

/**
 * The keymap: every shortcut in loki, in one table. The window's single key handler dispatches
 * from it, Settings renders it, and the native menu bar is built from it (the Rust side receives
 * the same table at startup). A shortcut exists here or nowhere.
 *
 * Grammar: "cmd+shift+a", "cmd+]", "enter", "shift+backspace", "left". cmd is ⌘ on a Mac and Ctrl
 * elsewhere. `typing` says whether a binding fires while a text box has focus: plain letters never
 * do; chords may, except the ones the text itself uses (⌘Z, ⌘⌫, ⌘←, ⌘→, ⌘A, ⌘C, ⌘V, ⌘X are the text's).
 */
export type Segment = "desk" | "inbox" | "board" | "learn" | "agents" | "settings";
export type Where = "anywhere" | Segment | "chat" | "global";

export interface Binding {
  /** Stable id; the action registry and the menu use it. */
  id: string;
  keys: string[];
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
  { id: "tree.toggle", keys: ["cmd+k"], where: "anywhere", label: "Desks Tree", typing: true, menu: "Desk" },
  { id: "desk.new", keys: ["cmd+n"], where: "anywhere", label: "New Desk…", typing: true, menu: "Desk" },
  { id: "task.new", keys: ["cmd+t"], where: "anywhere", label: "New Task…", typing: true, menu: "Board" },
  { id: "window.hide", keys: ["cmd+shift+w"], where: "anywhere", label: "Hide loki", typing: true },
  { id: "keys.sheet", keys: ["shift+/"], where: "anywhere", label: "Keys for This View", menu: "View/help" },
  { id: "layer.peel", keys: ["escape"], where: "anywhere", label: "close the topmost layer", note: "handled by the layer" },

  // --- desk ----------------------------------------------------------
  // ⌘[ and ⌘] step through what a section is made of: desks here, cards in the inbox, columns on the
  // board, views in Learn, agents in Agents, pages in Settings. Never "the next desk" from somewhere else.
  { id: "desk.prev", keys: ["cmd+["], where: "desk", label: "Previous Desk", typing: true, menu: "Desk/step" },
  { id: "desk.next", keys: ["cmd+]"], where: "desk", label: "Next Desk", typing: true, menu: "Desk/step" },
  { id: "chat.toggle", keys: ["cmd+/"], where: "desk", label: "Show / Hide Chat", typing: true, menu: "Chat" },
  { id: "chat.close", keys: ["cmd+w"], where: "desk", label: "Close Chat", typing: true, menu: "Chat" },
  { id: "chat.focus", keys: ["cmd+l"], where: "desk", label: "Focus Message Box", typing: true, menu: "Chat" },
  { id: "chat.find", keys: ["cmd+f"], where: "desk", label: "Find in Transcript…", typing: true, menu: "Chat" },
  { id: "chat.model", keys: ["cmd+shift+m"], where: "desk", label: "Change Model…", typing: true, menu: "Chat" },
  { id: "chat.mode", keys: ["cmd+shift+p"], where: "desk", label: "Change Permission Mode…", typing: true, menu: "Chat" },
  { id: "chat.left", keys: ["cmd+left", "alt+cmd+left"], where: "desk", label: "Move Chat Left", typing: true, menu: "Chat/place", menuAccel: false },
  { id: "chat.right", keys: ["cmd+right", "alt+cmd+right"], where: "desk", label: "Move Chat Right", typing: true, menu: "Chat/place", menuAccel: false },
  { id: "view.fit", keys: ["cmd+0"], where: "desk", label: "Fit All Widgets", typing: true, menu: "View" },
  { id: "view.reset", keys: ["cmd+shift+0"], where: "desk", label: "Actual Size (1:1)", typing: true, menu: "View" },
  { id: "view.zoomIn", keys: ["cmd+=", "cmd+shift+="], where: "desk", label: "Zoom In", typing: true, menu: "View" },
  { id: "view.zoomOut", keys: ["cmd+-"], where: "desk", label: "Zoom Out", typing: true, menu: "View" },
  { id: "desk.arrange", keys: ["cmd+shift+a"], where: "desk", label: "Arrange Widgets", typing: true, menu: "Desk/sheet" },
  { id: "desk.undo", keys: ["cmd+z"], where: "desk", label: "Undo Widget Move", menu: "Desk/sheet", menuAccel: false },

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
  { id: "agents.prev", keys: ["cmd+["], where: "agents", label: "previous agent", typing: true },
  { id: "agents.next", keys: ["cmd+]"], where: "agents", label: "next agent", typing: true },
  { id: "settings.prevPage", keys: ["cmd+["], where: "settings", label: "previous page", typing: true },
  { id: "settings.nextPage", keys: ["cmd+]"], where: "settings", label: "next page", typing: true },

  // --- global --------------------------------------------------------
  { id: "global.inbox", keys: ["alt+space"], where: "global", label: "bring loki up on the inbox", note: "the OS" },
];

const SYMBOL: Record<string, string> = {
  cmd: "⌘",
  shift: "⇧",
  alt: "⌥",
  ctrl: "⌃",
  enter: "↵",
  backspace: "⌫",
  escape: "esc",
  space: "space",
  left: "←",
  right: "→",
  up: "↑",
  down: "↓",
};

/** "cmd+shift+a" → "⌘⇧A"; letters upper-cased, named keys as symbols; the one shifted punctuation chord shows as the character it types. */
export function formatKeys(spec: string): string {
  if (spec === "shift+/") return "?";
  return spec
    .split("+")
    .map((p) => SYMBOL[p] ?? (p.length === 1 ? p.toUpperCase() : p))
    .join("");
}

/** Does this keyboard event match the spec? `cmd` accepts ⌘ or Ctrl, never both meanings at once. */
/**
 * Every binding whose chord this event is, whatever its scope: what the native menu bar might also fire for
 * the same keystroke. ⌘] is both "next card" (inbox) and "next desk" (anywhere); the key handler runs the
 * one for the showing segment, and the menu's echo — which carries the *other* id — must be dropped too.
 */
export function chordIds(e: KeyboardEvent, map: Binding[] = KEYMAP): string[] {
  return map.filter((b) => b.keys.some((k) => matches(e, k))).map((b) => b.id);
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

export function resolve(e: KeyboardEvent, segment: Segment): Binding | null {
  const typing = typingIn(e);
  // A key fires while typing only if the binding allows it AND the key is a chord the text does not use:
  // a plain letter or arrow always belongs to the text, whatever the binding says.
  const live = (b: Binding, k: string) => matches(e, k) && (!typing || (b.typing === true && k.includes("cmd+") && !TEXT_CHORDS.has(k)));
  const hit = (where: Where) => KEYMAP.find((b) => !b.note && b.where === where && b.keys.some((k) => live(b, k))) ?? null;
  return hit(segment) ?? hit("anywhere");
}

/** Bindings that share a key inside one scope — a mistake to catch in tests. */
export function conflicts(map: Binding[] = KEYMAP): string[] {
  const seen = new Map<string, string>();
  const out: string[] = [];
  for (const b of map) {
    if (b.note) continue;
    for (const k of b.keys) {
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

export function menuSpec(map: Binding[] = KEYMAP): MenuSpec[] {
  return MENUS.map((title) => {
    const mine = map.filter((b) => b.menu && b.menu.split("/")[0] === title);
    const items: MenuSpec["items"] = [];
    let lastGroup: string | undefined;
    for (const b of mine) {
      const group = b.menu!.split("/")[1];
      if (items.length && group !== lastGroup) items.push({ separator: true });
      lastGroup = group;
      items.push({ id: b.id, label: b.label, accelerator: b.menuAccel === false ? null : tauriAccelerator(b.keys[0]) });
    }
    return { title, items };
  }).filter((m) => m.items.length > 0);
}

/** Rows for Settings, grouped by scope in display order. */
export const WHERE_ORDER: Where[] = ["anywhere", "desk", "chat", "inbox", "board", "learn", "agents", "settings", "global"];

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

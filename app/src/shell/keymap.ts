import { keyboard, type Platform } from "../workspace/env";

export type { Platform };
export type Segment = "chats" | "flow" | "goals" | "learn" | "agents" | "settings";
export type Where = "anywhere" | Segment | "chat" | "global";

export interface Binding {
  id: string;
  keys: string[];
  keysOn?: Partial<Record<"windows" | "linux", string[]>>;
  where: Where;
  label: string;
  labelOn?: Partial<Record<"windows" | "linux", string>>;
  typing?: boolean;
  menu?: string;
  /** Show the accelerator in the menu (macOS then fires it when the page does not handle the key). Default true when `menu` is set. */
  menuAccel?: boolean;
  note?: string;
  was?: string;
}

export const MENUS = ["loki", "Go", "Chat", "Flow", "Learn", "View"] as const;

export const KEYMAP: Binding[] = [
  { id: "segment.chats", keys: ["cmd+1"], where: "anywhere", label: "Chats", typing: true, menu: "View/segments" },
  { id: "segment.flow", keys: ["cmd+2"], where: "anywhere", label: "Flow", typing: true, menu: "View/segments" },
  { id: "segment.goals", keys: ["cmd+3"], where: "anywhere", label: "Goals", typing: true, menu: "View/segments" },
  { id: "segment.agents", keys: ["cmd+4"], where: "anywhere", label: "Agents", typing: true, menu: "View/segments" },
  { id: "segment.learn", keys: ["cmd+5"], where: "anywhere", label: "Learn", typing: true, menu: "View/segments" },
  { id: "segment.settings", keys: ["cmd+6", "cmd+,"], where: "anywhere", label: "Settings…", typing: true, menu: "loki/settings" },
  { id: "app.update", keys: [], where: "anywhere", label: "Check for Updates…", typing: true, menu: "loki/update" },
  { id: "search.open", keys: ["cmd+k"], where: "anywhere", label: "Search", typing: true, menu: "Go" },
  { id: "chat.new", keys: ["cmd+n"], where: "anywhere", label: "New Chat", typing: true, menu: "Go" },
  {
    id: "column.toggle",
    keys: ["ctrl+cmd+s"],
    keysOn: { windows: ["cmd+b"], linux: ["cmd+b"] },
    where: "anywhere",
    label: "Show / Hide Sidebar",
    typing: true,
    menu: "View/column",
    was: "was {flow.deny} outside Flow",
  },
  {
    id: "list.toggle",
    keys: ["ctrl+cmd+l"],
    keysOn: { windows: ["cmd+shift+l"], linux: ["cmd+shift+l"] },
    where: "anywhere",
    label: "Show / Hide List",
    typing: true,
    menu: "View/column",
  },
  {
    id: "window.hide",
    keys: ["cmd+shift+w"],
    where: "anywhere",
    label: "Hide loki",
    labelOn: { windows: "Minimise loki", linux: "Minimise loki" },
    typing: true,
  },
  // Outside (Windows): Ctrl+Alt is AltGr off the Mac, so there the chord is Ctrl+Shift+F.
  {
    id: "list.search",
    keys: ["alt+cmd+f"],
    keysOn: { windows: ["cmd+shift+f"], linux: ["cmd+shift+f"] },
    where: "anywhere",
    label: "Search List",
    typing: true,
    menu: "View/list",
  },
  { id: "keys.sheet", keys: ["shift+/"], where: "anywhere", label: "Keys for This View", menu: "View/help" },
  { id: "layer.peel", keys: ["escape"], where: "anywhere", label: "close the topmost layer", note: "handled by the layer" },

  { id: "chat.prev", keys: ["cmd+["], where: "chats", label: "Previous Chat", typing: true, menu: "Go/step" },
  { id: "chat.next", keys: ["cmd+]"], where: "chats", label: "Next Chat", typing: true, menu: "Go/step" },
  { id: "chat.done", keys: ["cmd+shift+enter"], where: "chats", label: "Mark as Read", typing: true, menu: "Go/done" },
  { id: "chat.focus", keys: ["cmd+l"], where: "chats", label: "Focus Message Box", typing: true, menu: "Chat" },
  { id: "chat.find", keys: ["cmd+f"], where: "chats", label: "Find in Transcript…", typing: true, menu: "Chat" },
  { id: "chat.model", keys: ["cmd+shift+m"], where: "chats", label: "Change Model…", typing: true, menu: "Chat" },
  { id: "chat.mode", keys: ["cmd+shift+p"], where: "chats", label: "Change Permission Mode…", typing: true, menu: "Chat" },
  { id: "chat.suggestions", keys: ["cmd+shift+s"], where: "chats", label: "Show Suggestions…", typing: true, menu: "Chat" },
  { id: "chat.allow", keys: ["cmd+enter"], where: "chats", label: "Allow Step", typing: true, menu: "Chat/decide" },
  { id: "chat.deny", keys: ["cmd+shift+backspace"], where: "chats", label: "Deny Step", typing: true, menu: "Chat/decide" },
  { id: "worker.toggle", keys: ["cmd+\\"], where: "chats", label: "Toggle Workers", typing: true, menu: "Chat/workers" },
  { id: "worker.prev", keys: ["cmd+shift+["], where: "chats", label: "Previous Worker", typing: true, menu: "Chat/workers" },
  { id: "worker.next", keys: ["cmd+shift+]"], where: "chats", label: "Next Worker", typing: true, menu: "Chat/workers" },
  { id: "canvas.messages", keys: ["escape"], where: "chats", label: "back to Messages from the Workers tab", note: "handled by the shell" },

  { id: "chat.send", keys: ["enter"], where: "chat", label: "send", typing: true, note: "the box" },
  { id: "chat.newline", keys: ["shift+enter"], where: "chat", label: "new line", typing: true, note: "the box" },
  { id: "chat.reply", keys: ["1", "2", "3", "4"], where: "chat", label: "send a quick reply, while one has focus", note: "a quick reply with focus" },
  { id: "chat.dictate", keys: ["cmd+d"], keysOn: { windows: [], linux: [] }, where: "chat", label: "dictate", typing: true, note: "the box" },

  { id: "flow.next", keys: ["cmd+]", "right"], where: "flow", label: "Mark as Read", typing: true, menu: "Flow" },
  { id: "flow.later", keys: ["cmd+[", "left"], where: "flow", label: "Later", typing: true, menu: "Flow" },
  { id: "flow.archive", keys: ["cmd+e", "e"], where: "flow", label: "Archive", typing: true, menu: "Flow" },
  { id: "flow.label", keys: ["l"], where: "flow", label: "Add a Label", menu: "Flow", menuAccel: false },
  { id: "flow.approve", keys: ["cmd+enter", "a"], where: "flow", label: "Approve", typing: true, menu: "Flow/decide" },
  { id: "flow.deny", keys: ["cmd+shift+d", "d"], where: "flow", label: "Deny", typing: true, menu: "Flow/decide" },
  { id: "flow.open", keys: ["cmd+o", "o"], where: "flow", label: "Open the Chat", typing: true, menu: "Flow/go" },
  { id: "flow.reply", keys: ["r"], where: "flow", label: "reply (focus the box)" },
  { id: "flow.reply_sender", keys: ["shift+r"], where: "flow", label: "reply to the sender only (mail)" },
  { id: "flow.forward", keys: ["f"], where: "flow", label: "forward (mail)" },
  { id: "flow.react", keys: ["cmd+shift+\\"], where: "flow", label: "react with an emoji" },
  { id: "flow.undo", keys: ["cmd+z", "z"], where: "flow", label: "Undo Last Decision", menu: "Flow/go", menuAccel: false },

  { id: "learn.reveal", keys: ["space", "enter", "down"], where: "learn", label: "show the answer (then: got it)" },
  { id: "learn.again", keys: ["left", "1"], where: "learn", label: "again (shows the answer first)" },
  { id: "learn.good", keys: ["right", "2"], where: "learn", label: "got it (shows the answer first)" },
  { id: "learn.delete", keys: ["x", "backspace"], where: "learn", label: "Delete Card (the worker learns from it)", menu: "Learn", menuAccel: false },
  { id: "learn.undo", keys: ["z"], where: "learn", label: "Undo Delete", menu: "Learn", menuAccel: false },
  { id: "learn.edit", keys: ["e"], where: "learn", label: "Edit Card", menu: "Learn", menuAccel: false },
  { id: "learn.open", keys: ["cmd+o", "o"], where: "learn", label: "Open the Source Chat", typing: true, menu: "Learn/go" },
  { id: "learn.refresh", keys: ["cmd+r"], where: "learn", label: "Refresh", typing: true, menu: "Learn/go" },
  { id: "learn.prevView", keys: ["cmd+["], where: "learn", label: "Previous View", typing: true, menu: "Learn/step" },
  { id: "learn.nextView", keys: ["cmd+]"], where: "learn", label: "Next View", typing: true, menu: "Learn/step" },

  { id: "agents.prev", keys: ["cmd+["], where: "agents", label: "previous item in the list", typing: true },
  { id: "agents.next", keys: ["cmd+]"], where: "agents", label: "next item in the list", typing: true },
  { id: "settings.prevPage", keys: ["cmd+["], where: "settings", label: "previous page", typing: true },
  { id: "settings.nextPage", keys: ["cmd+]"], where: "settings", label: "next page", typing: true },

  // Outside (Windows): Alt+Space opens the window menu on Windows and Linux, so this is the Mac's alone.
  { id: "global.inbox", keys: ["alt+space"], keysOn: { windows: [], linux: [] }, where: "global", label: "bring loki up on Flow", note: "the OS" },
];

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

export function formatKeys(spec: string, os: Platform = keyboard): string {
  if (spec === "shift+/") return "?";
  const names = os === "macos" ? MAC_SYMBOL : WORD;
  return spec
    .split("+")
    .map((p) => names[p] ?? (p.length === 1 ? p.toUpperCase() : p))
    .join(os === "macos" ? "" : " ");
}

const ARIA_NAME: Record<string, string> = {
  cmd: "Meta",
  shift: "Shift",
  alt: "Alt",
  ctrl: "Control",
  enter: "Enter",
  backspace: "Backspace",
  tab: "Tab",
  escape: "Escape",
  space: "Space",
  left: "ArrowLeft",
  right: "ArrowRight",
  up: "ArrowUp",
  down: "ArrowDown",
};

export function ariaShortcut(shown: string): string {
  const aria = new Map<string, string>();
  for (const table of [MAC_SYMBOL, WORD]) for (const [name, said] of Object.entries(table)) aria.set(said, ARIA_NAME[name] ?? said);
  const modifiers = new Set(["cmd", "shift", "alt", "ctrl"].map((m) => MAC_SYMBOL[m]));
  const parts: string[] = [];
  let rest = shown;
  if (shown.includes(" ")) parts.push(...shown.split(" "));
  else {
    while (rest.length > 1 && modifiers.has(rest.charAt(0))) {
      parts.push(rest.charAt(0));
      rest = rest.slice(1);
    }
    parts.push(rest);
  }
  return parts.map((p) => aria.get(p) ?? (p.length === 1 ? p.toUpperCase() : p)).join("+");
}

export function keysOf(b: Binding, os: Platform = keyboard): string[] {
  return (os === "macos" ? undefined : b.keysOn?.[os]) ?? b.keys;
}

export function labelOf(b: Binding, os: Platform = keyboard): string {
  return (os === "macos" ? undefined : b.labelOn?.[os]) ?? b.label;
}

export function specFor(id: string, os: Platform = keyboard, index = 0): string | null {
  const b = KEYMAP.find((x) => x.id === id);
  return (b && keysOf(b, os)[index]) ?? null;
}

export function keyFor(id: string, os: Platform = keyboard, index = 0): string {
  const b = KEYMAP.find((x) => x.id === id);
  const k = b ? keysOf(b, os)[index] : undefined;
  if (!k) throw new Error(`keymap: no key ${index} for ${id} on ${os}`);
  return formatKeys(k, os);
}

export function wasFor(b: Binding, os: Platform = keyboard): string | undefined {
  return b.was?.replace(/\{([\w.]+)\}/g, (_, id: string) => keyFor(id, os));
}

/** ⌘ held, as a view checking its own chord reads it: ⌘ alone on the Mac (Ctrl+D deletes forward in a Mac text box), Ctrl alone elsewhere. */
export function cmdHeld(e: Pick<KeyboardEvent, "metaKey" | "ctrlKey">, os: Platform = keyboard): boolean {
  return os === "macos" ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
}

export function chordIds(e: KeyboardEvent, map: Binding[] = KEYMAP, os: Platform = keyboard): string[] {
  return map.filter((b) => keysOf(b, os).some((k) => matches(e, k))).map((b) => b.id);
}

const SHIFTED_FORM = new Map([
  ["0", ")"],
  ["=", "+"],
  ["-", "_"],
  [",", "<"],
  ["/", "?"],
  ["[", "{"],
  ["]", "}"],
  ["\\", "|"],
]);

export function matches(e: KeyboardEvent, spec: string): boolean {
  const parts = spec.split("+");
  const key = parts[parts.length - 1];
  const want = { cmd: parts.includes("cmd"), shift: parts.includes("shift"), alt: parts.includes("alt"), ctrl: parts.includes("ctrl") };
  const hasCmd = e.metaKey || e.ctrlKey;
  if (want.cmd !== hasCmd) return false;
  if (want.ctrl && !e.ctrlKey) return false;
  if (!want.ctrl && e.metaKey && e.ctrlKey) return false;
  if (want.alt !== e.altKey) return false;
  if (want.shift !== e.shiftKey) return false;
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
      // Outside (macOS): ⌥ changes the letter a key types (⌥F is "ƒ"), so a chord with ⌥ also matches by the key's place.
      if (/^[a-z]$/.test(key)) return k.toLowerCase() === key || (want.alt && e.code === `Key${key.toUpperCase()}`);
      return k === key || k === SHIFTED_FORM.get(key);
  }
}

export function typingIn(e: KeyboardEvent): boolean {
  const t = e.target as { tagName?: string; isContentEditable?: boolean } | null;
  if (!t) return false;
  return t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable === true;
}

export const TEXT_CHORDS = new Set([
  "cmd+left",
  "cmd+right",
  "cmd+up",
  "cmd+down",
  "cmd+backspace",
  "cmd+z",
  "cmd+shift+z",
  "cmd+a",
  "cmd+c",
  "cmd+v",
  "cmd+x",
  "alt+left",
  "alt+right",
  "alt+backspace",
]);

export function resolve(e: KeyboardEvent, segment: Segment, os: Platform = keyboard): Binding | null {
  const typing = typingIn(e);
  // Outside (macOS): Ctrl with a letter edits text (Ctrl+K cuts to the line's end, Ctrl+E goes to it), so there only ⌘
  // counts while typing, unless the binding asks for ⌃⌘ together (⌃⌘S), which no text box uses.
  const held = (k: string) => (k.includes("ctrl+") ? e.metaKey && e.ctrlKey : cmdHeld(e, os));
  const firesWhileTyping = (b: Binding, k: string) => b.typing === true && k.includes("cmd+") && !TEXT_CHORDS.has(k) && held(k);
  const live = (b: Binding, k: string) => matches(e, k) && (!typing || firesWhileTyping(b, k));
  const hit = (where: Where) => KEYMAP.find((b) => !b.note && b.where === where && keysOf(b, os).some((k) => live(b, k))) ?? null;
  return hit(segment) ?? hit("anywhere");
}

export function takenBy(b: Binding, map: Binding[] = KEYMAP, os: Platform = keyboard): Array<{ where: Where; key: string; id: string; label: string }> {
  if (b.where !== "anywhere" || b.note) return [];
  return map.flatMap((o) =>
    o.note || o.where === "anywhere" || o.where === "global"
      ? []
      : keysOf(b, os)
          .filter((k) => keysOf(o, os).includes(k))
          .map((key) => ({ where: o.where, key, id: o.id, label: labelOf(o, os) })),
  );
}

export function conflicts(map: Binding[] = KEYMAP, os?: Platform): string[] {
  if (!os) {
    const mac = conflicts(map, "macos");
    const own = (o: Platform) =>
      conflicts(map, o)
        .filter((c) => !mac.includes(c))
        .map((c) => `${c} (${o})`);
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

/** The menu bar, as the shell's `set_menu` takes it: sections in MENUS order, groups separated, accelerators in Electron's grammar. */
export interface MenuSpec {
  title: string;
  items: Array<{ id: string; label: string; accelerator: string | null } | { separator: true }>;
}

const ACCELERATOR_KEY: Record<string, string> = {
  cmd: "CommandOrControl",
  shift: "Shift",
  alt: "Alt",
  ctrl: "Control",
  enter: "Enter",
  backspace: "Backspace",
  delete: "Delete",
  escape: "Escape",
  tab: "Tab",
  space: "Space",
  left: "Left",
  right: "Right",
  up: "Up",
  down: "Down",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown",
};

export function menuAccelerator(spec: string): string {
  return spec
    .split("+")
    .map((p) => ACCELERATOR_KEY[p] ?? p.toUpperCase())
    .join("+");
}

export function menuSpec(map: Binding[] = KEYMAP, os: Platform = keyboard, labels: Record<string, string> = {}): MenuSpec[] {
  return MENUS.map((title) => {
    const mine = map.filter((b): b is Binding & { menu: string } => b.menu?.split("/")[0] === title);
    const items: MenuSpec["items"] = [];
    let lastGroup: string | undefined;
    for (const b of mine) {
      const group = b.menu.split("/")[1];
      if (items.length && group !== lastGroup) items.push({ separator: true });
      lastGroup = group;
      const key = keysOf(b, os)[0];
      items.push({ id: b.id, label: labels[b.id] ?? labelOf(b, os), accelerator: b.menuAccel === false || !key ? null : menuAccelerator(key) });
    }
    return { title, items };
  }).filter((m) => m.items.length > 0);
}

export type DialogState = "none" | "preferences" | "search" | "other";
export function dialogState(root: ParentNode = document): DialogState {
  const up = [...root.querySelectorAll('[role="dialog"]')];
  if (up.length === 0) return "none";
  if (up.every((d) => d.hasAttribute("data-preferences"))) return "preferences";
  return up.every((d) => d.hasAttribute("data-search")) ? "search" : "other";
}

const PREFERENCES_KEYS = new Set(["settings.prevPage", "settings.nextPage"]);
export function shellKeyAllowed(dialog: DialogState, id: string): boolean {
  if (dialog === "none") return true;
  if (dialog === "other") return false;
  if (dialog === "search") return id === "search.open";
  return id.startsWith("segment.") || PREFERENCES_KEYS.has(id);
}

export function keySegment(segment: Segment, dialog: DialogState): Segment {
  return dialog === "preferences" ? "settings" : segment;
}

export const WHERE_ORDER: Where[] = ["anywhere", "chats", "chat", "flow", "learn", "agents", "settings", "global"];

export function keyRows(os: Platform = keyboard, map: Binding[] = KEYMAP): Binding[] {
  return WHERE_ORDER.flatMap((where) => map.filter((b) => b.where === where))
    .map((b) => ({ ...b, keys: keysOf(b, os), label: labelOf(b, os) }))
    .filter((b) => b.keys.length > 0);
}

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

export interface Command {
  id: string;
  label: string;
  keys: string | null;
}

export function commandsFor(segment: Segment, os: Platform = keyboard, map: Binding[] = KEYMAP): Command[] {
  const here: Where[] = segment === "chats" ? ["anywhere", "chats", "chat"] : ["anywhere", segment];
  return map
    .filter((b) => b.menu && b.id !== "search.open" && here.includes(b.where) && actions.has(b.id))
    .map((b) => {
      const key = keysOf(b, os).at(0);
      return { id: b.id, label: labelOf(b, os), keys: key ? formatKeys(key, os) : null };
    });
}

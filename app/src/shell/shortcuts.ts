/** The segments of the rail, and small helpers. The keymap itself lives in keymap.ts. */
export { typingIn, type Segment } from "./keymap";
import type { Segment } from "./keymap";

export const SEGMENTS: Array<{ id: Segment; label: string; key: string }> = [
  { id: "desk", label: "Desk", key: "⌘1" },
  { id: "inbox", label: "Inbox", key: "⌘2" },
  { id: "board", label: "Board", key: "⌘3" },
  { id: "agents", label: "Agents", key: "⌘4" },
  { id: "learn", label: "Learn", key: "⌘5" },
  { id: "settings", label: "Settings", key: "⌘6" },
];

/** The segments of the rail, and small helpers. The keymap itself lives in keymap.ts. */
export { typingIn, type Segment } from "./keymap";
import type { Segment } from "./keymap";

export const SEGMENTS: Array<{ id: Segment; label: string; key: string }> = [
  { id: "desk", label: "desk", key: "⌘1" },
  { id: "inbox", label: "inbox", key: "⌘2" },
  { id: "board", label: "board", key: "⌘3" },
  { id: "agents", label: "agents", key: "⌘4" },
  { id: "learn", label: "learn", key: "⌘5" },
  { id: "settings", label: "settings", key: "⌘6" },
];

/** The segments of the rail, and small helpers. The keymap itself lives in keymap.ts. */
export { typingIn, type Segment } from "./keymap";
import { keyFor, type Segment } from "./keymap";

const segment = (id: Segment, label: string) => ({ id, label, key: keyFor(`segment.${id}`) });

export const SEGMENTS: Array<{ id: Segment; label: string; key: string }> = [
  segment("desk", "Desk"),
  segment("inbox", "Inbox"),
  segment("board", "Board"),
  segment("agents", "Agents"),
  segment("learn", "Learn"),
  segment("settings", "Settings"),
];

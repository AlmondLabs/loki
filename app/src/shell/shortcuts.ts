import { keyFor, type Segment } from "./keymap";

const segment = (id: Segment, label: string) => ({ id, label, key: keyFor(`segment.${id}`) });

export const SEGMENTS: Array<{ id: Segment; label: string; key: string }> = [
  segment("desk", "Chats"),
  segment("inbox", "Flow"),
  segment("agents", "Agents"),
  segment("learn", "Learn"),
  segment("settings", "Preferences"),
];

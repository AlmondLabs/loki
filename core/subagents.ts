export const SUBAGENT_CHAT_SEP = "~subagent~";

export const subagentChatId = (parentChatId: string, id: string): string => `${parentChatId}${SUBAGENT_CHAT_SEP}${id}`;

export const isSubagentChat = (chatId: string): boolean => chatId.includes(SUBAGENT_CHAT_SEP);

export function parentChatOfSubagent(chatId: string): string | null {
  const idx = chatId.indexOf(SUBAGENT_CHAT_SEP);
  return idx >= 0 ? chatId.slice(0, idx) : null;
}

export function subagentIdOfChat(chatId: string): string | null {
  const idx = chatId.indexOf(SUBAGENT_CHAT_SEP);
  return idx >= 0 ? chatId.slice(idx + SUBAGENT_CHAT_SEP.length) : null;
}

export function subagentDisplayName(id: string): string {
  if (!id) return "Worker";
  return id
    .split("-")
    .map((part) => (part ? part[0].toUpperCase() + part.slice(1) : ""))
    .filter(Boolean)
    .join(" ");
}

export const SUBAGENT_NAMES: readonly string[] = [
  "atlas",
  "beacon",
  "cairn",
  "compass",
  "corvus",
  "drifter",
  "ember",
  "falcon",
  "fjord",
  "flint",
  "forge",
  "frost",
  "harbor",
  "hawk",
  "hearth",
  "heron",
  "indigo",
  "kestrel",
  "lantern",
  "lynx",
  "magpie",
  "marrow",
  "merlin",
  "nebula",
  "nova",
  "obsidian",
  "onyx",
  "orion",
  "osprey",
  "otter",
  "pebble",
  "phoenix",
  "polaris",
  "prism",
  "quartz",
  "raven",
  "ridge",
  "rune",
  "sable",
  "scout",
  "slate",
  "spark",
  "sparrow",
  "spruce",
  "strider",
  "talon",
  "thistle",
  "timber",
  "valkyrie",
  "vanguard",
  "vesper",
  "warden",
  "wren",
  "zephyr",
];

export function pickSubagentName(used: ReadonlySet<string>, startIndex = 0): string {
  const len = SUBAGENT_NAMES.length;
  const offset = ((startIndex % len) + len) % len;
  for (let i = 0; i < len; i += 1) {
    const candidate = SUBAGENT_NAMES[(offset + i) % len];
    if (!used.has(candidate)) return candidate;
  }
  for (let n = 2; ; n += 1) {
    const base = SUBAGENT_NAMES[offset];
    const candidate = `${base}-${n}`;
    if (!used.has(candidate)) return candidate;
  }
}

export type SubagentStatus = "running" | "done" | "error" | "stopped";

export interface SubagentView {
  id: string;
  chat_id: string;
  name: string;
  description: string;
  model: string | null;
  status: SubagentStatus;
  read_only?: boolean;
  branch?: string | null;
  started_at: string;
  error?: string | null;
}

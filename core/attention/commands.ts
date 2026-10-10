/**
 * Slash commands in the message box, as Letta Desktop has them. Two kinds: the harness's own
 * (`execute_command` over the app-server socket — the same path Desktop and the channels use) and
 * loki's (a keymap action, run in place). The box shows a palette while a command is being typed;
 * Enter runs it, or fills it in when it takes arguments.
 */
export interface SlashCommand {
  id: string;
  description: string;
  /** Argument hint, when the command takes any (e.g. "[tokens]"). */
  args?: string;
  /** Where it runs: the harness (Letta Code) or loki itself. */
  where: "harness" | "loki";
  /** loki commands: the keymap action id to run. */
  action?: string;
  /** The palette shows the action's key after the description, in the system's own words (the app formats it; core names no keys). */
  withKey?: boolean;
}

/** What loki's daemon runs (daemon/chat-backend.ts command); it says so in serverInfo, and the palette offers only these. */
export const HARNESS_COMMANDS: SlashCommand[] = [
  { id: "compact", description: "summarise the conversation so far (compaction)", args: "[instructions]", where: "harness" },
  { id: "clear", description: "start the agent afresh in this chat; what was said stays in the thread", where: "harness" },
  { id: "remember", description: "remember something from this conversation", args: "[what]", where: "harness" },
  { id: "reflect", description: "reflect on this conversation now: a pass that commits what it keeps to memory", where: "harness" },
];

/** loki's own: things the header chips and the rail already do, reachable from the box. */
export const LOKI_COMMANDS: SlashCommand[] = [
  { id: "model", description: "choose the model for this conversation", where: "loki", action: "chat.model" },
  { id: "mode", description: "choose the permission mode for this conversation", where: "loki", action: "chat.mode" },
  { id: "inbox", description: "open the inbox", where: "loki", action: "segment.inbox" },
  { id: "chats", description: "search chats, agents and pages", where: "loki", action: "search.open", withKey: true },
];


/** Every command the box offers: loki's, the harness's, then whatever else the harness advertised. */
/** loki's commands and the harness's; `only`, when the backend names exactly what it runs (loki's daemon), keeps those. */
export function allCommands(advertised: SlashCommand[] = [], only?: string[]): SlashCommand[] {
  const harness = only ? HARNESS_COMMANDS.filter((c) => only.includes(c.id)) : HARNESS_COMMANDS;
  return [...LOKI_COMMANDS, ...harness, ...advertised];
}

const HEAD = /^\/([a-z][\w-]*)(?:\s+([\s\S]*))?$/;

/**
 * "/compact all" → { id: "compact", args: "all" }; null for anything that is not a command
 * (a path like /Users/…, a line that only starts with a slash mid-sentence).
 */
export function parseSlash(text: string): { id: string; args: string } | null {
  const m = HEAD.exec(text.trim());
  return m ? { id: m[1], args: (m[2] ?? "").trim() } : null;
}

/** While the command name is still being typed (no space yet): the partial name, so the palette can filter. Otherwise null. */
export function slashQuery(draft: string): string | null {
  const m = /^\/([\w-]*)$/.exec(draft);
  return m ? m[1].toLowerCase() : null;
}

/** Commands matching a partial name: those starting with it first, then those containing it. */
export function matchCommands(query: string, commands: SlashCommand[]): SlashCommand[] {
  const q = query.toLowerCase();
  const starts = commands.filter((c) => c.id.startsWith(q));
  const contains = commands.filter((c) => !c.id.startsWith(q) && (c.id.includes(q) || c.description.toLowerCase().includes(q)));
  return [...starts, ...contains];
}

/** The line the harness echoes for a command: "/compact all". */
export function commandInput(id: string, args?: string): string {
  const a = args?.trim();
  return a ? `/${id} ${a}` : `/${id}`;
}

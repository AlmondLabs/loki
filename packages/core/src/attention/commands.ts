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
}

/** What Letta Code 0.31 runs remotely (SUPPORTED_REMOTE_COMMANDS); the app_server_info list, when the harness sends one, is merged on top. */
export const HARNESS_COMMANDS: SlashCommand[] = [
  { id: "reload", description: "reload settings, local mods and secrets", where: "harness" },
  { id: "compact", description: "summarise the conversation so far (compaction)", args: "[all|sliding_window]", where: "harness" },
  { id: "clear", description: "clear the in-context messages", where: "harness" },
  { id: "remember", description: "remember something from this conversation", args: "[instructions]", where: "harness" },
  { id: "init", description: "initialise (or re-initialise) the agent's memory", where: "harness" },
  { id: "doctor", description: "audit and refine the agent's memory structure", where: "harness" },
  { id: "context-limit", description: "set this conversation's context window", args: "[tokens] [--override]", where: "harness" },
  { id: "channels", description: "manage channels (Slack, Telegram)", args: "[subcommand]", where: "harness" },
  { id: "upgrade-letta-code", description: "upgrade Letta Code to the latest release", where: "harness" },
];

/** loki's own: things the header chips and the rail already do, reachable from the box. */
export const LOKI_COMMANDS: SlashCommand[] = [
  { id: "model", description: "choose the model for this conversation", where: "loki", action: "chat.model" },
  { id: "mode", description: "choose the permission mode for this conversation", where: "loki", action: "chat.mode" },
  { id: "inbox", description: "open the inbox", where: "loki", action: "segment.inbox" },
  { id: "desks", description: "open the desks tree", where: "loki", action: "tree.toggle" },
];

/** A command the harness advertised in app_server_info that the table above does not know. */
export function fromAdvertised(ids: string[] | undefined, mods: Array<{ id: string; description?: string; args?: string }> | undefined, known: SlashCommand[] = HARNESS_COMMANDS): SlashCommand[] {
  const have = new Set(known.map((c) => c.id));
  const out: SlashCommand[] = [];
  for (const id of ids ?? []) if (!have.has(id) && /^[a-z][\w-]*$/.test(id)) (have.add(id), out.push({ id, description: "", where: "harness" }));
  for (const m of mods ?? []) if (m.id && !have.has(m.id)) (have.add(m.id), out.push({ id: m.id, description: m.description ?? "", args: m.args, where: "harness" }));
  return out;
}

/** Every command the box offers: loki's, the harness's, then whatever else the harness advertised. */
export function allCommands(advertised: SlashCommand[] = []): SlashCommand[] {
  return [...LOKI_COMMANDS, ...HARNESS_COMMANDS, ...advertised];
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

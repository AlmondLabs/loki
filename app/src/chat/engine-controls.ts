import { engineCommands, type SlashCommand } from "../../../core/attention/commands.ts";
import { pickableEntries, type ChatEngineView, type ModelEntry } from "../../../core/models.ts";
import type { TranscriptRow } from "../../../core/attention/transcript.ts";
import { agentModes, isPermissionMode, type ModeChoice } from "./permission-mode";

/**
 * What the box's switchers offer for the engine a chat runs on (plan 020): on an ACP agent, its own modes and
 * commands, and only its models once something is said (KD4); on loki's engine, loki's four modes and its commands.
 */
export function engineControls(
  view: { engine?: ChatEngineView | null; mode?: string | null; rows: TranscriptRow[] | undefined },
  models: ModelEntry[] | null,
  commands: SlashCommand[] | undefined,
): { mode: string | null; modes: ModeChoice[] | undefined; pickable: ModelEntry[] | null; commands: SlashCommand[] | undefined } {
  const engine = view.engine ?? null;
  const started = view.rows?.some((r) => r.role === "user") ?? false;
  return {
    mode: engine || isPermissionMode(view.mode) ? (view.mode ?? null) : null,
    modes: engine ? agentModes(engine) : undefined,
    pickable: pickableEntries(models, engine, started),
    commands: engine ? engineCommands(engine) : commands,
  };
}

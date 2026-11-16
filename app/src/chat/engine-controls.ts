import { engineCommands, type SlashCommand } from "../../../core/attention/commands.ts";
import type { ChatEngineView } from "../../../core/models.ts";
import type { TranscriptRow } from "../../../core/attention/transcript.ts";
import { agentModes, isPermissionMode, type ModeChoice } from "./permission-mode";

export function engineControls(
  view: { engine?: ChatEngineView | null; mode?: string | null; rows: TranscriptRow[] | undefined },
  commands: SlashCommand[] | undefined,
): { mode: string | null; modes: ModeChoice[] | undefined; started: boolean; commands: SlashCommand[] | undefined } {
  const engine = view.engine ?? null;
  const started = view.rows?.some((r) => r.role === "user") ?? false;
  return {
    mode: engine || isPermissionMode(view.mode) ? (view.mode ?? null) : null,
    modes: engine ? agentModes(engine) : undefined,
    started,
    commands: engine ? engineCommands(engine) : commands,
  };
}

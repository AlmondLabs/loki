/**
 * Every Letta harness on the Mac loads this mod (Letta reads one shared ~/.letta/mods; LETTA_MODS_DIR is
 * honoured by `letta install`, not by the loader). Only one may serve the desk: the harness that hosts an
 * app-server, because the chat, the model picker, permissions, the reflection page, Catch Up and the card
 * writer all go through that socket, and a mod serving the desk from a plain terminal session would hold the
 * port with nothing behind it (and run a second card writer). Letta tells the two apart in the capabilities it
 * hands the mod: an interactive or headless session gets lifecycle events (TUI_MOD_CAPABILITIES,
 * HEADLESS_MOD_CAPABILITIES: events.lifecycle true); the listener that hosts an app-server — `letta server`,
 * Letta Desktop, the channel gateway — does not (LISTENER_MOD_CAPABILITIES: lifecycle false). Observed in
 * Letta Code 0.31.x and 0.32.x. LOKI_MOD_SERVE=1 overrides (scripts/harness.ts, a debugging session).
 */
export type Capabilities = { events?: { lifecycle?: boolean } | boolean } | undefined;

export function shouldServe(capabilities: Capabilities, env: Record<string, string | undefined> = process.env): { serve: boolean; reason: string } {
  if (env.LOKI_MOD_SERVE === "1") return { serve: true, reason: "LOKI_MOD_SERVE=1" };
  if (env.LOKI_MOD_SERVE === "0") return { serve: false, reason: "LOKI_MOD_SERVE=0" };
  const events = capabilities?.events;
  const lifecycle = typeof events === "object" && events !== null ? events.lifecycle === true : false;
  if (lifecycle) return { serve: false, reason: "a session harness (lifecycle events on): no app-server here; the desk is served by the harness that hosts one" };
  return { serve: true, reason: "a listener harness (no lifecycle events): it hosts the app-server" };
}

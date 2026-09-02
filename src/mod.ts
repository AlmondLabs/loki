import { spawn } from "node:child_process";
import { startServer, type LociServer } from "./server.js";

/**
 * loci — a memory palace your agent builds.
 * Letta Code mod entry: registers /canvas and owns the local server.
 * Installed via a thin shim in ~/.letta/mods/loci.ts (see README).
 */
// Minimal structural types for the mod API surface we use (no .d.ts ships with letta-code).
interface LettaMod {
  capabilities?: { commands?: boolean };
  commands: {
    register(command: {
      id: string;
      description: string;
      run(ctx: unknown): Promise<CommandResult> | CommandResult;
    }): (() => void) | void;
  };
  diagnostics?: { report(d: { message: string; severity: "info" | "warning" | "error" }): void };
  signal?: AbortSignal;
}
interface CommandResult {
  type: "output";
  output: string;
}

export default function activate(letta: LettaMod): (() => void) | void {
  if (!letta.capabilities?.commands) return;

  let srv: LociServer | null = null;
  let starting: Promise<LociServer> | null = null;

  const ensureServer = async (): Promise<LociServer> => {
    if (srv) return srv;
    starting ??= startServer().then((s) => (srv = s));
    try {
      return await starting;
    } catch (err) {
      starting = null;
      letta.diagnostics?.report({
        message: `loci: server failed to start (${err instanceof Error ? err.message : String(err)}) — is another Letta instance holding the port?`,
        severity: "error",
      });
      throw err;
    }
  };

  const disposeCommand = letta.commands.register({
    id: "canvas",
    description: "Open the loci canvas — the widget desk",
    async run() {
      const s = await ensureServer();
      if (process.platform === "darwin") {
        spawn("open", [s.url], { stdio: "ignore", detached: true }).unref();
      }
      return { type: "output", output: `loci canvas: ${s.url}` };
    },
  });

  const shutdown = (): void => {
    void srv?.close();
    srv = null;
    starting = null;
  };
  letta.signal?.addEventListener("abort", shutdown, { once: true });

  return () => {
    disposeCommand?.();
    shutdown();
  };
}

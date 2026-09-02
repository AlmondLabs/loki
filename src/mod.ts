import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { startServer, type LociServer } from "./server.js";
import { attachWs, type WsBridge } from "./ws.js";
import { DeskStore, seedDesk } from "./store.js";
import { createChatBridge, type ConversationHandle } from "./chat.js";
import { registerTools } from "./tools.js";

/** Token persists at ~/.letta/loci/token so canvas URLs survive /reload. */
function loadOrCreateToken(): string {
  const dir = join(homedir(), ".letta", "loci");
  const file = join(dir, "token");
  try {
    const existing = readFileSync(file, "utf8").trim();
    if (/^[a-f0-9]{32}$/.test(existing)) return existing;
  } catch {
    // fall through to create
  }
  const token = randomBytes(16).toString("hex");
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, token, { mode: 0o600 });
  return token;
}

/**
 * loci — a memory palace your agent builds.
 * Letta Code mod entry: registers /canvas and owns the local server.
 * Installed via a thin shim in ~/.letta/mods/loci.ts (see README).
 */
// Minimal structural types for the mod API surface we use (no .d.ts ships with letta-code).
interface LettaMod {
  capabilities?: {
    commands?: boolean;
    tools?: boolean;
    events?: { turns?: boolean } | boolean;
  };
  tools?: Parameters<typeof registerTools>[0]["tools"];
  commands: {
    register(command: {
      id: string;
      description: string;
      run(ctx: CommandContext): Promise<CommandResult> | CommandResult;
    }): (() => void) | void;
  };
  events?: {
    on(
      name: string,
      handler: (event: unknown, ctx: EventContext) => void,
    ): (() => void) | void;
  };
  diagnostics?: { report(d: { message: string; severity: "info" | "warning" | "error" }): void };
  signal?: AbortSignal;
}
interface CommandContext {
  conversation?: ConversationHandle;
}
interface EventContext {
  conversation?: ConversationHandle;
}
interface CommandResult {
  type: "output";
  output: string;
}

export default function activate(letta: LettaMod): (() => void) | void {
  if (!letta.capabilities?.commands) return;

  let srv: LociServer | null = null;
  let ws: WsBridge | null = null;
  let starting: Promise<LociServer> | null = null;
  const store = new DeskStore();
  seedDesk(store);

  // Freshest handle to the active conversation — captured from /canvas and
  // from turn/conversation events. The chat bridge forks from it lazily.
  let activeConversation: ConversationHandle | null = null;
  const chat = createChatBridge(() => activeConversation);

  const eventDisposers: Array<(() => void) | void> = [];
  for (const name of ["conversation_open", "turn_start"]) {
    try {
      eventDisposers.push(
        letta.events?.on(name, (_event, ctx) => {
          if (ctx?.conversation?.id) activeConversation = ctx.conversation;
        }),
      );
    } catch {
      // events capability absent — /canvas capture still works
    }
  }

  const ensureServer = async (): Promise<LociServer> => {
    if (srv) return srv;
    starting ??= startServer({ token: loadOrCreateToken() }).then((s) => {
      ws = attachWs(s.server, store, s.token, chat);
      return (srv = s);
    });
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

  // Eager start: the canvas must survive /reload + tab refresh without
  // waiting for the next /canvas. Failure lands in diagnostics, not a crash.
  void ensureServer().catch(() => {});

  // Agent tools: render widgets onto the desk, read desk state.
  const toolDisposers = registerTools(letta, store, (msg) => ws?.broadcast(msg));

  const disposeCommand = letta.commands.register({
    id: "canvas",
    description: "Open the loci canvas — the widget desk",
    async run(ctx) {
      if (ctx?.conversation?.id) activeConversation = ctx.conversation;
      const s = await ensureServer();
      if (process.platform === "darwin") {
        spawn("open", [s.url], { stdio: "ignore", detached: true }).unref();
      }
      return { type: "output", output: `loci canvas: ${s.url}` };
    },
  });

  const shutdown = (): void => {
    ws?.close();
    void srv?.close();
    ws = null;
    srv = null;
    starting = null;
  };
  letta.signal?.addEventListener("abort", shutdown, { once: true });

  return () => {
    disposeCommand?.();
    for (const dispose of eventDisposers) dispose?.();
    for (const dispose of toolDisposers) dispose?.();
    shutdown();
  };
}

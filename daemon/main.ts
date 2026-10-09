/**
 * The loki daemon (plan 017): the one long-running process the shell starts and supervises in place of
 * `letta server`. For now it holds the lock and hosts loki's mod (canvas, board, Learn, the phone listener) with the
 * host object the mod was written against; the versioned mod API (U4) and the chats themselves (U5, U6) follow.
 *
 *   node daemon.mjs --loki-daemon --dir <loki folder> --mod <mod entry> [--token-file <file>]
 *
 * `--loki-daemon` and the token file mark the command line as loki's, so a shell finds a leftover from a crash.
 * Exit code 3: another daemon holds this folder's lock; the shell then leaves that one serving.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { acquire, type Lock } from "./lock.ts";

export const EXIT_HELD = 3;

const { values: args } = parseArgs({
  options: {
    "loki-daemon": { type: "boolean" },
    dir: { type: "string" },
    mod: { type: "string" },
    "token-file": { type: "string" },
  },
});
if (!args.dir || !args.mod) {
  console.error("loki-daemon: --dir and --mod are required");
  process.exit(2);
}

mkdirSync(args.dir, { recursive: true });
const taken = acquire(join(args.dir, "daemon.lock"));
if (!("release" in taken)) {
  console.error(`loki-daemon: another daemon (pid ${taken.heldBy}) is serving ${args.dir}`);
  process.exit(EXIT_HELD);
}
const lock: Lock = taken;

type Handler = (...a: unknown[]) => unknown;

/**
 * The host the mod was written against (mod/letta-types.ts): tools, commands, events, diagnostics and an abort
 * signal. Nothing fires the events yet; tools are kept for the agent loop to offer (U4 replaces this object).
 */
const controller = new AbortController();
const tools = new Map<string, unknown>();
const events = new Map<string, Handler[]>();
const host = {
  capabilities: { commands: false, tools: true, events: { turns: true, lifecycle: false } },
  tools: { register: (t: { name: string }) => (tools.set(t.name, t), () => tools.delete(t.name)) },
  commands: { register: () => () => {} },
  events: {
    on: (name: string, handler: Handler) => {
      events.set(name, [...(events.get(name) ?? []), handler]);
      return () => events.set(name, (events.get(name) ?? []).filter((h) => h !== handler));
    },
  },
  diagnostics: { report: (d: { severity: string; message: string }) => console.error(`loki-daemon: ${d.severity}: ${d.message}`) },
  signal: controller.signal,
};

// The mod serves only inside a host that is not a terminal session (mod/gate.ts); the daemon always is.
process.env.LOKI_MOD_SERVE ??= "1";
const mod = (await import(pathToFileURL(args.mod).href)) as { default: (h: unknown) => unknown };
const dispose = (await mod.default(host)) as (() => void) | undefined;
console.error(`loki-daemon: pid ${process.pid} serving ${args.dir}`);

let stopping = false;
function stop(signal: string) {
  if (stopping) return;
  stopping = true;
  console.error(`loki-daemon: ${signal}, stopping`);
  controller.abort();
  try {
    dispose?.();
  } finally {
    lock.release();
    process.exit(0);
  }
}
process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGINT", () => stop("SIGINT"));
process.on("exit", () => lock.release());

/**
 * Scripts (docs/plans/2026-11-11-1011-feat-scripts-google-tools-plan.md): pi-durable's Code Mode on loki's own engine.
 * The agent writes a short JavaScript program, and it runs in a QuickJS sandbox on a worker thread with no file,
 * network or process access of its own: it reaches anything outside only by calling the tools this module lets it.
 * Those are the script-only tools (a tool with `callers: ["tools"]`, which the model is never offered: a mod's, and
 * loki's `ls`, `find` and `grep`) and pi-durable's file tools; bash, background runs, helpers and the rest stay with the model, so a script never starts a process.
 *
 * Everything a script may cost is a constant here, in one place, so the trade between what a script can do and what
 * the daemon spends on it stays visible.
 */
import { existsSync } from "node:fs";
import { defineExtension, wrapSection, wrapTool, type Agent, type Extension, type ToolExecutionApi, type ToolRegistration } from "@earendil-works/pi-durable";
import { CODEMODE_TOOL_NAME, createCodemodeExtension, type CodemodeNamespace } from "@earendil-works/pi-durable/codemode";
import { CODEMODE_OPTIONS_PREFIX, CodemodeSandbox, parseCodemodeSource, type CodemodeSandboxBase } from "@earendil-works/pi-codemode";
import { withKind } from "./tool-kinds.ts";

/** The script tool's name, as the model calls it. */
export const SCRIPT_TOOL = CODEMODE_TOOL_NAME;

/**
 * The model's file tools a script may call besides the script-only tools (loki's `ls`, `find` and `grep` are among
 * those): reads and edits in the chat's folder, which the approval gate already knows how to weigh. bash is not here,
 * nor anything else that starts a process (plan, R3).
 */
export const SCRIPT_FILE_TOOLS: ReadonlySet<string> = new Set(["read", "write", "edit"]);

/**
 * How long one script may run, waiting on its tools included. Long enough to move a few hundred Drive files one at a
 * time; a script that needs longer is better split, so a restart costs less.
 */
export const SCRIPT_TIMEOUT_MS = 10 * 60_000;

/**
 * The sandbox's own memory cap. A run measured +39 MB of daemon memory at its peak, most of it the worker and the
 * QuickJS instance, which the cap does not count; this bounds what a script builds on top.
 */
export const SCRIPT_MEMORY_BYTES = 64 * 1024 * 1024;

/**
 * Scripts running at once across every chat. Each holds a worker thread (9-13 MB each, measured on Node 22), so the
 * cap keeps a burst of chats from multiplying the daemon's memory; a script over it is refused with the reason, not
 * queued, and the agent can run it again.
 */
export const SCRIPTS_AT_ONCE = 4;

/**
 * Estimated tokens the prompt's script section may spend listing tools one by one: none. The section names each
 * namespace and what it is for, and a script finds a tool with `searchTools()` and reads it with `describeTool()`.
 * Measured on 2026-11-11 (test/scripts-prompt.test.ts): an owning agent's prompt gains about 991 tokens a turn with
 * this (582 the section, 409 the script tool), 1,119 with 150 and 1,460 with 600, against a 1,000-token target.
 */
export const SCRIPT_LISTING_TOKENS = 0;

/** The namespaces scripts see in the prompt and in `searchTools()`, one per family of script-only tools. */
export const SCRIPT_NAMESPACES: readonly CodemodeNamespace[] = [
  {
    name: "google",
    prefix: "google_",
    description:
      "Gmail, Drive, Sheets, Docs and Calendar of the Google accounts this agent owns on this Mac; `account` (an address) may be left out when it owns one. Changes happen at once. Send mail or invites only when the person asks.",
  },
];

/** Whether only scripts may call a tool: it names scripts as callers and not the model. */
export function isScriptOnly(tool: Pick<ToolRegistration, "callers">): boolean {
  return tool.callers !== undefined && tool.callers.includes("tools") && !tool.callers.includes("model");
}

/** Whether a script may call a tool: a script-only tool or one of SCRIPT_FILE_TOOLS. */
export function scriptMayCall(tool: Pick<ToolRegistration, "name" | "callers">): boolean {
  return isScriptOnly(tool) || SCRIPT_FILE_TOOLS.has(tool.name);
}

/**
 * Where the release bundle keeps the sandbox's worker: beside daemon.mjs (scripts/build-mod.ts). From a checkout the
 * package's own worker is used. The QuickJS wasm needs no path: the bundle carries `quickjs-wasi` in node_modules
 * beside it, where the package looks.
 */
function bundledWorker(): URL | undefined {
  const url = new URL("./codemode-worker.mjs", import.meta.url);
  return url.protocol === "file:" && existsSync(url) ? url : undefined;
}

/**
 * The daemon's one sandbox, holding only defaults: each script gets its own worker and VM. Admission counts workers
 * until they exit, so a script that timed out still holds its place while its thread winds down. `limits` default to
 * the constants above; tests pass small ones.
 */
export function scriptSandbox(limits: { timeoutMs?: number; memoryLimitBytes?: number; atOnce?: number } = {}): CodemodeSandbox {
  const atOnce = limits.atOnce ?? SCRIPTS_AT_ONCE;
  let running = 0;
  const workerUrl = bundledWorker();
  return new CodemodeSandbox({
    timeoutMs: limits.timeoutMs ?? SCRIPT_TIMEOUT_MS,
    memoryLimitBytes: limits.memoryLimitBytes ?? SCRIPT_MEMORY_BYTES,
    ...(workerUrl ? { workerUrl } : {}),
    acquireWorker: () => {
      if (running >= atOnce) throw new Error(`${atOnce} scripts are already running in other chats: run this one again when one finishes`);
      running++;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        running--;
      };
    },
  });
}

/**
 * A script's source with its deadline at most `limitMs`. Code Mode takes a script's deadline from its own options line
 * only, never from the sandbox, so a script that sets none would run without one: loki writes the line in, or lowers
 * the one the agent wrote. A source the options parser refuses is left as it is, for Code Mode to report. A script
 * without an options line gains one, so its error line numbers count one more.
 */
export function withTimeLimit(source: string, limitMs: number): string {
  let parsed: ReturnType<typeof parseCodemodeSource>;
  try {
    parsed = parseCodemodeSource(source);
  } catch {
    return source;
  }
  const { timeoutMs, maxOutputTokens } = parsed.options;
  if (timeoutMs !== undefined && timeoutMs <= limitMs) return source;
  const line = `${CODEMODE_OPTIONS_PREFIX} ${JSON.stringify({ ...(maxOutputTokens === undefined ? {} : { max_output_tokens: maxOutputTokens }), timeout_ms: limitMs })}`;
  // parseCodemodeSource leaves an empty first line where the options line was, so the new line takes its place.
  return source.trimStart().startsWith(CODEMODE_OPTIONS_PREFIX) ? `${line}${parsed.code}` : `${line}\n${source}`;
}

/** Whether a script tool call's arguments carry its code, as they do once the Harness has validated them. */
const isScript = (args: unknown): args is { code: string } => typeof args === "object" && args !== null && "code" in args && typeof args.code === "string";

/** An agent as a script sees it: its callable tools cut to the ones scripts may call. */
function confined<Tool extends ToolRegistration>(agent: Agent<Tool>): Agent<Tool> {
  return { ...agent, callable: agent.callable.filter(scriptMayCall) };
}

/**
 * The tool api a script runs with: the same api, whose `agent()` lists only what scripts may call. Code Mode builds
 * `tools.*` from that list and resolves nested calls by name, so a tool left out is not a function in the script.
 */
function confinedApi<Api extends ToolExecutionApi>(api: Api): Api {
  return new Proxy(api, {
    get(target, prop) {
      if (prop === "agent") return async (...args: Parameters<ToolExecutionApi["agent"]>) => confined(await target.agent(...args));
      const value: unknown = Reflect.get(target, prop, target);
      if (typeof value !== "function") return value;
      const method = value as (...a: unknown[]) => unknown;
      return method.bind(target);
    },
  });
}

/**
 * The script tool and its prompt section, confined (plan, KTD1-KTD3): Code Mode without paid model calls, its tool
 * wrapped so a script sees only what `scriptMayCall` allows and runs one at a time in a model round, and its section
 * shown only where the tool is offered, so a background pass with a fixed tool list never gets it. Every script runs
 * within `timeLimitMs` (withTimeLimit).
 */
export function scriptExtensions(sandbox: CodemodeSandboxBase, timeLimitMs = SCRIPT_TIMEOUT_MS): Extension[] {
  const codemode = createCodemodeExtension({ sandbox, namespaces: SCRIPT_NAMESPACES, inlineBudget: SCRIPT_LISTING_TOKENS, models: false });
  const tool = codemode.tools?.find((t) => t.name === SCRIPT_TOOL);
  if (!tool) throw new Error("pi-durable's code mode extension has no code mode tool");
  // A script asks as a command does (plan, R7): the kind rides on the registered tool, where the gate reads it.
  withKind("command", tool);
  const confine = defineExtension({
    name: "loki.scripts",
    wraps: [
      wrapTool(tool, (t) => ({
        ...t,
        executionMode: "sequential",
        execute: (args, api, context) => t.execute(isScript(args) ? { ...args, code: withTimeLimit(args.code, timeLimitMs) } : args, confinedApi(api), context),
      })),
      wrapSection(SCRIPT_TOOL, (s) => ({
        ...s,
        render: (input, context) =>
          input.agent.tools.some((t) => t.name === SCRIPT_TOOL) ? s.render({ ...input, agent: confined(input.agent) }, context) : undefined,
      })),
    ],
  });
  return [codemode, confine];
}

/**
 * Whether this daemon can run a script at all, for the release smoke test (`daemon.mjs --check-scripts`): the bundle
 * must find the worker and the QuickJS wasm, which a checkout's tests never exercise.
 */
export async function checkScripts(): Promise<string> {
  const sandbox = scriptSandbox();
  try {
    const result = await sandbox.execute("return 1 + 1");
    if (!result.ok) throw new Error(`the sandbox failed: ${result.error.message}`);
    return `scripts run: 1 + 1 = ${String(result.value)}`;
  } finally {
    await sandbox.close();
  }
}

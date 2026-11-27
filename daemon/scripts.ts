import { existsSync } from "node:fs";
import {
  defineExtension,
  wrapSection,
  wrapTool,
  type Agent,
  type Extension,
  type ToolExecutionApi,
  type ToolExecutionResult,
  type ToolNamespace,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { CODEMODE_TOOL_NAME, createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { CODEMODE_OPTIONS_PREFIX, CodemodeSandbox, parseCodemodeSource, type CodemodeSandboxBase } from "@earendil-works/pi-codemode";
import { isScriptDescriptionLine, SCRIPT_DESCRIPTION_PREFIX } from "../core/harness.ts";
import { fenceScriptAnswer } from "../mod/account-ops/fence.ts";
import { withKind } from "./tool-kinds.ts";

export const SCRIPT_TOOL = CODEMODE_TOOL_NAME;

export const SCRIPT_FILE_TOOLS: ReadonlySet<string> = new Set(["read", "write", "edit", "find", "grep"]);

export const SCRIPT_TIMEOUT_MS = 10 * 60_000;

export const SCRIPT_MEMORY_BYTES = 64 * 1024 * 1024;

export const SCRIPTS_AT_ONCE = 4;

export const SCRIPT_LISTING_TOKENS = 300;

export interface ScriptNamespace extends ToolNamespace {
  readonly prefix: string;
}

export const SCRIPT_NAMESPACES: readonly ScriptNamespace[] = [
  {
    name: "google",
    prefix: "google_",
    description:
      "Gmail, Drive, Sheets, Docs and Calendar of the Google accounts this agent owns on this Mac; `account` (an address) may be left out when it owns one. Changes happen at once. Send mail or invites only when the person asks.",
  },
  { name: "slack", prefix: "slack_", description: "Read the Slack workspaces this agent owns." },
  { name: "jira", prefix: "jira_", description: "Read tickets on the Jira sites this agent owns." },
  { name: "flow", prefix: "flow_", description: "The threads waiting in Flow for this agent's accounts." },
  { name: "history", prefix: "history_", description: "Search and read this chat's whole history, compacted turns included." },
  { name: "schedule", prefix: "schedule_", description: "List, create and cancel this chat's scheduled prompts." },
  { name: "canvas", prefix: "canvas_", description: "Read the canvas beside this chat, and move the person's view to widgets." },
  { name: "chat", prefix: "chat_", description: "List the person's agents and open chats." },
];

export const SCRIPT_DESCRIPTION = [
  "Run JavaScript that calls loki's tools, in a sandbox with no files, network, timers or programs of its own. The input is raw JavaScript (no JSON, no code fence), run as an async function body: top-level `await` and `return` work.",
  "- `await tools.<name>({ ...args })` resolves to a string, or an object when the tool's declaration says so, and rejects with an Error on failure. Calls still running when the script ends are cancelled.",
  "- The `codemode` section names the namespaces. Find a tool with `await searchTools(query)` and read how to call it with `await describeTool(name)`.",
  "- `return`, `text(value)` and `console.log(...)` give output. `store(key, value)` and `load(key)` keep JSON values between scripts.",
  '- An optional first line sets limits: `// @options: {"timeout_ms": 60000, "max_output_tokens": 10000}`.',
  `- Then a few words on what it does, its title for the person: \`${SCRIPT_DESCRIPTION_PREFIX} Count open PRs\`.`,
].join("\n");

export function isScriptOnly(tool: Pick<ToolRegistration, "callers">): boolean {
  return tool.callers !== undefined && tool.callers.includes("tools") && !tool.callers.includes("model");
}

export function scriptMayCall(tool: Pick<ToolRegistration, "name" | "callers">): boolean {
  return isScriptOnly(tool) || SCRIPT_FILE_TOOLS.has(tool.name);
}

function bundledWorker(): URL | undefined {
  const url = new URL("./codemode-worker.mjs", import.meta.url);
  return url.protocol === "file:" && existsSync(url) ? url : undefined;
}

export function scriptSandbox(
  limits: { timeoutMs?: number; memoryLimitBytes?: number; atOnce?: number } = {},
  refused: (running: number) => void = () => {},
): CodemodeSandbox {
  const atOnce = limits.atOnce ?? SCRIPTS_AT_ONCE;
  let running = 0;
  const workerUrl = bundledWorker();
  return new CodemodeSandbox({
    timeoutMs: limits.timeoutMs ?? SCRIPT_TIMEOUT_MS,
    memoryLimitBytes: limits.memoryLimitBytes ?? SCRIPT_MEMORY_BYTES,
    ...(workerUrl ? { workerUrl } : {}),
    acquireWorker: () => {
      if (running >= atOnce) {
        refused(running);
        throw new Error(`${atOnce} scripts are already running in other chats: run this one again when one finishes`);
      }
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
  // Outside (pi-codemode): parseCodemodeSource leaves an empty first line where the options line was, so the new line takes its place.
  return source.trimStart().startsWith(CODEMODE_OPTIONS_PREFIX) ? `${line}${parsed.code}` : `${line}\n${source}`;
}

function withOptionsFirst(source: string): string {
  const lines = source.split("\n");
  const options = lines.findIndex((line) => line.trimStart().startsWith(CODEMODE_OPTIONS_PREFIX));
  const description = lines.findIndex(isScriptDescriptionLine);
  if (description === -1 || options === -1 || description > options) return source;
  const moved = lines.splice(description, 1);
  lines.splice(options, 0, ...moved);
  return lines.join("\n");
}

export function fencedIfRead<Result extends ToolExecutionResult>(result: Result, strangerText: (tool: string) => boolean): Result {
  const details: unknown = result.details;
  const calls = typeof details === "object" && details !== null && "calls" in details && Array.isArray(details.calls) ? (details.calls as unknown[]) : [];
  const read = calls.some((c) => typeof c === "object" && c !== null && "name" in c && typeof c.name === "string" && strangerText(c.name));
  if (!read || !result.output) return result;
  const text = result.output.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
  const rest = result.output.filter((part) => part.type !== "text");
  return { ...result, output: [{ type: "text" as const, text: fenceScriptAnswer(text) }, ...rest] };
}

const isScript = (args: unknown): args is { code: string } => typeof args === "object" && args !== null && "code" in args && typeof args.code === "string";

function scriptNamespaceExtensions<Tool extends ToolRegistration>(
  callable: readonly Tool[],
  extensions: ReadonlyArray<Extension<Tool>>,
): Array<Extension<Tool>> {
  const synthetic: Array<Extension<Tool>> = [];
  for (const ns of SCRIPT_NAMESPACES) {
    const matching = callable.filter((t) => t.name.startsWith(ns.prefix));
    if (matching.length > 0) {
      synthetic.push({ name: `loki.namespace.${ns.name}`, namespace: { name: ns.name, description: ns.description }, tools: matching });
    }
  }
  return [...synthetic, ...extensions];
}

function confined<Tool extends ToolRegistration>(agent: Agent<Tool>): Agent<Tool> {
  const callable = agent.callable.filter(scriptMayCall);
  return { ...agent, callable, extensions: scriptNamespaceExtensions(callable, agent.extensions) };
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

export function scriptExtensions(
  sandbox: CodemodeSandboxBase,
  timeLimitMs = SCRIPT_TIMEOUT_MS,
  strangerText: (tool: string) => boolean = () => false,
): Extension[] {
  const codemode = createCodemodeExtension({ sandbox, inlineBudget: SCRIPT_LISTING_TOKENS, models: false });
  const tool = codemode.tools?.find((t) => t.name === SCRIPT_TOOL);
  if (!tool) throw new Error("pi-durable's code mode extension has no code mode tool");
  withKind("read", tool);
  const confine = defineExtension({
    name: "loki.scripts",
    wraps: [
      wrapTool(tool, (t) => ({
        ...t,
        description: SCRIPT_DESCRIPTION,
        executionMode: "sequential",
        execute: async (args, api, context) => {
          const result = await t.execute(
            isScript(args) ? { ...args, code: withTimeLimit(withOptionsFirst(args.code), timeLimitMs) } : args,
            confinedApi(api),
            context,
          );
          return result.kind === undefined ? fencedIfRead(result, strangerText) : result;
        },
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

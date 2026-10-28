import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { migrateKeys, OLD_TASK_METADATA_KEYS } from "../core/snake-keys.ts";
import type { ChatRouter } from "./chat-router.ts";
import { lokiDir } from "./paths.ts";
import { envVar, execProgram, firstExisting, onPath } from "./programs.ts";
import type { ChatKey, SuggestionInput, Suggestions } from "./suggestions.ts";

/**
 * Tasks retired into suggestions (plan 047, U7, KTD10): each open task in the beads store becomes a suggestion in the
 * chat it was filed from, written on the Mac that chat lives on, and its id is noted in `state/migrations.json`
 * (`tasks_moved`) so it moves once. A task that cannot move now (bd missing, its chat's Mac off, its chat gone) is
 * left for the next run. The beads store is only read: this file keeps its own reader, apart from mod/tasks.ts.
 */

/** Runs bd with the given arguments, without the binary, and resolves to its stdout; tests pass canned output. */
export type BdRunner = (args: string[]) => Promise<string>;

/** An open task as the move needs it: what it says, and the chat and folder it was filed from. */
export interface OpenTask {
  id: string;
  title: string;
  description: string;
  status: string;
  /** The chat it was filed from; null when its stamp names none. */
  source: ChatKey | null;
  folder: string | null;
}

/** Where the beads store is: LOKI_TASKS_DIR (or LOKI_BOARD_DIR), else <loki>/tasks, else <loki>/board from before Tasks. */
export function tasksDir(home = lokiDir(), env: NodeJS.ProcessEnv = process.env): string {
  const set = env.LOKI_TASKS_DIR ?? env.LOKI_BOARD_DIR;
  if (set) return set;
  const dir = join(home, "tasks");
  const old = join(home, "board");
  return existsSync(dir) || !existsSync(old) ? dir : old;
}

/** LOKI_BD, then PATH (`bd.exe` on Windows), then Homebrew, /usr/local, Go's and ~/.local's bin. */
function bdBinary(): string | null {
  return firstExisting([
    envVar("LOKI_BD"),
    ...onPath("bd"),
    "/opt/homebrew/bin/bd",
    "/usr/local/bin/bd",
    join(homedir(), "go", "bin", "bd"),
    join(homedir(), ".local", "bin", "bd"),
  ]);
}

/**
 * bd run against the beads store in `dir`. A store that was never made lists nothing, and is not made: the move must
 * not create what it retires.
 */
export function bdReader(dir: string): BdRunner {
  return (args) => {
    if (!existsSync(join(dir, ".beads"))) return Promise.resolve("[]");
    const bin = bdBinary();
    if (!bin) return Promise.reject(new Error("bd (beads) is not installed"));
    return new Promise((resolve, reject) => {
      execProgram(
        bin,
        args,
        { cwd: dir, env: { ...process.env, BEADS_DIR: join(dir, ".beads"), BD_NON_INTERACTIVE: "1" }, timeout: 20_000, maxBuffer: 16 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err) reject(new Error((stderr || err.message).trim() || `bd ${args[0] ?? ""} failed`));
          else resolve(stdout);
        },
      );
    });
  };
}

const text = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/** bd's `list --json` output as tasks; text before the JSON is skipped, and anything else that is not JSON throws. */
export function parseOpenTasks(stdout: string): OpenTask[] {
  const out = stdout.trim();
  if (!out) return [];
  const start = Math.min(...["[", "{"].map((c) => out.indexOf(c)).filter((i) => i >= 0));
  const parsed: unknown = JSON.parse(Number.isFinite(start) ? out.slice(start) : out);
  const list: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
  return list.flatMap((raw): OpenTask[] => {
    if (!raw || typeof raw !== "object") return [];
    const r = raw as Record<string, unknown>;
    const id = text(r.id);
    if (!id) return [];
    const md = r.metadata && typeof r.metadata === "object" ? (r.metadata as Record<string, unknown>) : {};
    // Keys saved camelCase before October 2026 (agentId) read under their names now.
    const { value: m } = migrateKeys(md, OLD_TASK_METADATA_KEYS);
    const agentId = text(m.agent_id);
    const conversation = text(m.conversation);
    return [
      {
        id,
        title: text(r.title) ?? id,
        description: typeof r.description === "string" ? r.description : "",
        status: text(r.status) ?? "open",
        source: agentId && conversation ? { agent_id: agentId, conversation_id: conversation } : null,
        folder: text(m.folder),
      },
    ];
  });
}

/** What the move is built from: bd, the state file, the router and this Mac's suggestions, and where to report. */
export interface TaskMoveDeps {
  run: BdRunner;
  /** `state/migrations.json`. */
  stateFile: string;
  route: Pick<ChatRouter, "target" | "forward">;
  suggestions: Pick<Suggestions, "add">;
  /** The folder a chat works in, for a task that names none; null when it is not known. */
  folderOf(chat: ChatKey): string | null;
  report(message: string): void;
}

const readState = (file: string): Record<string, unknown> => {
  try {
    const v: unknown = JSON.parse(readFileSync(file, "utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

const movedIds = (state: Record<string, unknown>): string[] =>
  Array.isArray(state.tasks_moved) ? state.tasks_moved.filter((id): id is string => typeof id === "string") : [];

/** Note one more moved task, keeping every other key the file holds; written at once, so a crash never moves it twice. */
function record(file: string, id: string): void {
  const state = readState(file);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ ...state, tasks_moved: [...movedIds(state), id] }, null, 2)}\n`);
}

/** Add the suggestion on the Mac its source chat lives on: here, or the paired Mac the router names. */
async function addAtHome(d: TaskMoveDeps, source: ChatKey, input: SuggestionInput): Promise<string | null> {
  try {
    const frame = { type: "suggestion_add", ...source, ...input };
    const home = await d.route.target(frame);
    if (!home) {
      await d.suggestions.add(source, input);
      return null;
    }
    const out = await d.route.forward(home, frame, "request");
    return out.ok ? null : out.message;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/**
 * Move every open task not moved yet into a suggestion in its source chat; the ids moved this run. When bd cannot list
 * the tasks nothing is moved; a task that cannot move now is reported and tried again next run.
 */
export async function moveTasks(d: TaskMoveDeps): Promise<string[]> {
  let tasks: OpenTask[];
  try {
    tasks = parseOpenTasks(await d.run(["list", "--json", "--flat", "-n", "0"]));
  } catch (err) {
    d.report(`tasks not moved into suggestions yet: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
  const done = new Set(movedIds(readState(d.stateFile)));
  const moved: string[] = [];
  for (const t of tasks) {
    if (t.status === "closed" || done.has(t.id)) continue;
    const folder = t.folder ?? (t.source ? d.folderOf(t.source) : null);
    if (!t.source || !folder) {
      d.report(`task ${t.id} stays in beads: it names no ${t.source ? "folder" : "chat it was filed from"}`);
      continue;
    }
    const input = {
      title: t.title,
      text: t.description.trim() ? `${t.title}\n\n${t.description.trim()}` : t.title,
      target: { agent_id: t.source.agent_id, folder },
    };
    const failed = await addAtHome(d, t.source, input);
    if (failed) {
      d.report(`task ${t.id} stays in beads for now: ${failed}`);
      continue;
    }
    record(d.stateFile, t.id);
    moved.push(t.id);
  }
  if (moved.length) d.report(`${moved.length} tasks moved into suggestions: ${moved.join(", ")}`);
  return moved;
}

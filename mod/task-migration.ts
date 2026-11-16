import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { migrateKeys, OLD_TASK_METADATA_KEYS } from "../core/snake-keys.ts";
import type { ChatRouter } from "./chat-router.ts";
import { lokiDir } from "./paths.ts";
import { envVar, execProgram, firstExisting, onPath } from "./programs.ts";
import type { ChatKey, SuggestionInput, Suggestions } from "./suggestions.ts";
import { messageOf } from "../core/errors.ts";
import { writeJsonAtomic } from "./json-file.ts";

export type BdRunner = (args: string[]) => Promise<string>;

export interface OpenTask {
  id: string;
  title: string;
  description: string;
  status: string;
  source: ChatKey | null;
  folder: string | null;
}

export function tasksDir(home = lokiDir(), env: NodeJS.ProcessEnv = process.env): string {
  const set = env.LOKI_TASKS_DIR ?? env.LOKI_BOARD_DIR;
  if (set) return set;
  const dir = join(home, "tasks");
  const old = join(home, "board");
  return existsSync(dir) || !existsSync(old) ? dir : old;
}

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

export interface TaskMoveDeps {
  run: BdRunner;
  stateFile: string;
  route: Pick<ChatRouter, "target" | "forward">;
  suggestions: Pick<Suggestions, "add">;
  folderOf(chat: ChatKey): string | null;
  report(message: string): void;
}

function readState(file: string): Record<string, unknown> {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") return {};
    throw err;
  }
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${file} does not parse (${messageOf(err)}): left as it is`);
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(`${file} is not a JSON object: left as it is`);
  return v as Record<string, unknown>;
}

const movedIds = (state: Record<string, unknown>): string[] =>
  Array.isArray(state.tasks_moved) ? state.tasks_moved.filter((id): id is string => typeof id === "string") : [];

function record(file: string, id: string): void {
  const state = readState(file);
  writeJsonAtomic(file, { ...state, tasks_moved: [...movedIds(state), id] }, { pretty: true, newline: true, pidTemp: true });
}

async function addAtHome(d: TaskMoveDeps, source: ChatKey, input: SuggestionInput, id: string): Promise<string | null> {
  try {
    const frame = { type: "suggestion_add", ...source, ...input, suggestion_id: id };
    const home = await d.route.target(frame);
    if (!home) {
      await d.suggestions.add(source, input, { id });
      return null;
    }
    const out = await d.route.forward(home, frame, "request");
    return out.ok ? null : out.message;
  } catch (err) {
    return messageOf(err);
  }
}

export async function moveTasks(d: TaskMoveDeps): Promise<string[]> {
  let tasks: OpenTask[];
  try {
    // --readonly makes bd refuse any write, so reading the list can never change the store (docs/SECURITY.md).
    tasks = parseOpenTasks(await d.run(["--readonly", "list", "--json", "--flat", "-n", "0"]));
  } catch (err) {
    d.report(`tasks not moved into suggestions yet: ${messageOf(err)}`);
    return [];
  }
  let done: Set<string>;
  try {
    done = new Set(movedIds(readState(d.stateFile)));
  } catch (err) {
    d.report(`tasks not moved into suggestions: ${messageOf(err)}`);
    return [];
  }
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
    const failed = await addAtHome(d, t.source, input, `task-${t.id}`);
    if (failed) {
      d.report(`task ${t.id} stays in beads for now: ${failed}`);
      continue;
    }
    try {
      record(d.stateFile, t.id);
    } catch (err) {
      d.report(`tasks not moved into suggestions: ${messageOf(err)}`);
      break;
    }
    moved.push(t.id);
  }
  if (moved.length) d.report(`${moved.length} tasks moved into suggestions: ${moved.join(", ")}`);
  return moved;
}

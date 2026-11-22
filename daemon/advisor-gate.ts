import { realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CHANGES_TOOL } from "./changes.ts";
import { memoryRoot } from "./memory.ts";
import { commandWords, isReadOnlyCommand } from "./read-only-command.ts";
import { resultsDirOf } from "./tool-results.ts";

export const ADVISOR_TOOLS: readonly string[] = [
  "read",
  "ls",
  "find",
  "grep",
  "bash",
  "web_search",
  "memory_read",
  "history_search",
  "history_read",
  CHANGES_TOOL,
];
const ADVISOR_TOOL_SET: ReadonlySet<string> = new Set(ADVISOR_TOOLS);

export interface AdvisorFolders {
  dataDir: string;
  backendDir: string;
  home: string;
}

export interface AdvisorCall {
  name: string;
  args: Record<string, unknown>;
  cwd: string | undefined;
  agentId: string;
  chatId: string;
}

interface Reach {
  asked: string;
  recursive: boolean;
}

const WORKING_FOLDER = ".";
const UNICODE_SPACES = /[  -   　]/g;

const offList = (name: string) => `An advisor reads and never changes anything, so it cannot use ${name}.`;
const NOT_READ_ONLY =
  "An advisor runs only commands that read (ls, find, rg, grep, cat, head, tail, wc and pwd, joined by |), never one that changes anything or runs another program; read git changes with changes_read.";
const shown = (asked: string) => (asked === WORKING_FOLDER ? "The working folder" : asked);
const inData = (asked: string) => `${shown(asked)} is inside loki's data folder, where chats are kept, which an advisor may not read.`;
const aboveData = (asked: string) =>
  `A search of ${asked === WORKING_FOLDER ? "the working folder" : asked} would reach into loki's data folder, where chats are kept: search a folder within it instead, with the grep or find tool and a path.`;
const FOLLOWS_LINKS = "An advisor's search may not follow links, since a link can lead into loki's data folder.";
const otherHome = (asked: string) => `An advisor may not read another home folder (${asked}).`;
const UNCHECKED = "loki cannot check where this advisor's paths lead, so it refuses them.";

const pathArg = (value: unknown): string => (typeof value === "string" && value ? value : WORKING_FOLDER);

const hasShort = (args: readonly string[], letters: RegExp) => args.some((a) => /^-[^-]/.test(a) && letters.test(a.slice(1)));

const RECURSIVE: Readonly<Partial<Record<string, (args: readonly string[]) => boolean>>> = {
  find: () => true,
  rg: () => true,
  grep: (a) => hasShort(a, /[rR]/) || a.some((w) => ["--recursive", "--dereference-recursive", "--directories=recurse", "recurse"].includes(w)),
  ls: (a) => hasShort(a, /R/) || a.includes("--recursive"),
};

const FOLLOWS: Readonly<Partial<Record<string, (args: readonly string[]) => boolean>>> = {
  find: (a) => a.includes("-L") || a.includes("-follow"),
  rg: (a) => hasShort(a, /L/) || a.includes("--follow"),
  grep: (a) => hasShort(a, /R/) || a.includes("--dereference-recursive"),
  ls: (a) => hasShort(a, /L/) || a.includes("--dereference"),
};

function candidates(word: string): string[] {
  const out = [word];
  const eq = word.indexOf("=");
  if (eq >= 0) out.push(word.slice(eq + 1));
  if (/^-[^-]/.test(word) && word.length > 2) out.push(word.slice(2));
  return out.filter(Boolean);
}

function globRoot(word: string): string {
  const at = word.search(/[*?[]/);
  const before = at < 0 ? word : word.slice(0, at);
  const cut = Math.max(before.lastIndexOf("/"), before.lastIndexOf("\\"));
  return cut < 0 ? WORKING_FOLDER : before.slice(0, cut + 1);
}

function bashReach(command: unknown): Reach[] | string {
  const reach: Reach[] = [];
  for (const [program, ...rest] of commandWords(command) ?? []) {
    const args = rest.map((w) => w.text);
    const recursive = RECURSIVE[program.text]?.(args) ?? false;
    if (recursive && FOLLOWS[program.text]?.(args)) return FOLLOWS_LINKS;
    if (recursive) reach.push({ asked: WORKING_FOLDER, recursive });
    for (const word of rest)
      for (const asked of candidates(word.text)) reach.push(word.glob ? { asked: globRoot(asked), recursive: true } : { asked, recursive });
  }
  return reach;
}

function reachOf(name: string, args: Record<string, unknown>): Reach[] | string {
  if (name === "read" || name === "ls") return [{ asked: pathArg(args.path), recursive: false }];
  if (name === "find" || name === "grep") return [{ asked: pathArg(args.path), recursive: true }];
  if (name === CHANGES_TOOL) {
    const paths = Array.isArray(args.paths) ? args.paths.filter((p): p is string => typeof p === "string" && p !== "") : [];
    return [WORKING_FOLDER, ...paths].map((asked) => ({ asked, recursive: false }));
  }
  if (name === "bash") return bashReach(args.command);
  return [];
}

const fromUrl = (path: string): string | null => {
  try {
    return fileURLToPath(path);
  } catch {
    return null;
  }
};

function spellings(asked: string, home: string): string[] {
  const plain = asked.replace(UNICODE_SPACES, " ");
  const out = new Set([asked, plain, plain.startsWith("@") ? plain.slice(1) : plain]);
  for (const p of [...out]) {
    if (p === "~") out.add(home);
    else if (p.startsWith("~/") || p.startsWith("~\\")) out.add(join(home, p.slice(2)));
    else if (p.startsWith("file://")) out.add(fromUrl(p) ?? p);
  }
  return [...out];
}

const namesOtherHome = (asked: string) => asked.startsWith("~") && asked !== "~" && !asked.startsWith("~/") && !asked.startsWith("~\\");

async function identity(path: string): Promise<string | null> {
  try {
    const s = await stat(path, { bigint: true });
    return `${String(s.dev)}:${String(s.ino)}`;
  } catch {
    return null;
  }
}

async function deepestReal(path: string): Promise<{ real: string; whole: boolean }> {
  for (let at = path; ; at = dirname(at)) {
    try {
      return { real: await realpath(at), whole: at === path };
    } catch {
      if (dirname(at) === at) return { real: at, whole: false };
    }
  }
}

async function chainOf(path: string): Promise<{ ids: string[]; whole: boolean }> {
  const { real, whole } = await deepestReal(path);
  const ids: string[] = [];
  for (let at = real; ; at = dirname(at)) {
    const id = await identity(at);
    if (id) ids.push(id);
    if (dirname(at) === at) return { ids, whole };
  }
}

export async function advisorRefusal(call: AdvisorCall, folders: AdvisorFolders | undefined): Promise<string | null> {
  if (!ADVISOR_TOOL_SET.has(call.name)) return offList(call.name);
  if (call.name === "bash" && !isReadOnlyCommand(call.args.command)) return NOT_READ_ONLY;
  const reach = reachOf(call.name, call.args);
  if (typeof reach === "string") return reach;
  if (!reach.length) return null;
  const strange = reach.find((r) => namesOtherHome(r.asked));
  if (strange) return otherHome(strange.asked);
  if (!folders || !call.cwd) return UNCHECKED;
  const data = await identity(folders.dataDir);
  if (!data) return null;
  const readable = (await Promise.all([memoryRoot(folders.backendDir, call.agentId), resultsDirOf(folders.dataDir, call.chatId)].map(identity))).filter(
    (id): id is string => id !== null,
  );
  const above = (await chainOf(folders.dataDir)).ids;
  for (const r of reach)
    for (const spelled of spellings(r.asked, folders.home)) {
      const { ids, whole } = await chainOf(isAbsolute(spelled) ? resolve(spelled) : resolve(call.cwd, spelled));
      const at = ids.indexOf(data);
      if (at >= 0 && !ids.slice(0, at).some((id) => readable.includes(id))) return inData(r.asked);
      if (r.recursive && whole && above.includes(ids[0] ?? "")) return aboveData(r.asked);
    }
  return null;
}

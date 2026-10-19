import { describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reflectionJob } from "../daemon/reflection.ts";
import { CONFLICTS_PATH, applyMemoryBundle, memoryBundle, memoryHead, pendingConflicts } from "../daemon/memory-sync.ts";

const BOOK = "aaaaaaaa-1111-4111-8111-111111111111";
const MINI = "bbbbbbbb-2222-4222-8222-222222222222";

/** git in a repo, as a person would, with a fixed author. */
const git = (root: string, ...args: string[]) =>
  execFileSync("git", ["-C", root, "-c", "user.name=Friday", "-c", "user.email=friday@loki.local", "-c", "core.autocrlf=false", ...args], {
    encoding: "utf8",
  });

/** A note written and committed. */
function write(root: string, path: string, text: string): void {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), text);
  git(root, "add", "--", path);
  git(root, "commit", "--quiet", "-m", `write ${path}`);
}

/** Friday's memory on the MacBook (with a first note) and an empty folder for it on the mini. */
function macs() {
  const dir = mkdtempSync(join(tmpdir(), "loki-memory-sync-"));
  const book = join(dir, "book", "memory");
  const mini = join(dir, "mini", "memory");
  mkdirSync(book, { recursive: true });
  git(book, "init", "--quiet");
  write(book, "system/persona.md", "I am Friday.\n");
  write(book, "notes/work.md", "first paragraph\n\nsecond paragraph\n");
  return { dir, book, mini, done: () => rmSync(dir, { recursive: true, force: true }) };
}

/** The mini takes what the MacBook has that it lacks. */
async function miniPulls(book: string, mini: string, homeIsHere = false) {
  const have = [await memoryHead(mini), ...(existsSync(join(mini, ".git")) ? [] : [])].filter((x): x is string => !!x);
  const bundle = await memoryBundle(book, have);
  return bundle ? applyMemoryBundle(mini, bundle, { from: BOOK, homeIsHere }) : "unchanged";
}

/** The MacBook takes what the mini has that it lacks. */
async function bookPulls(book: string, mini: string, homeIsHere = true) {
  const have = [await memoryHead(book)].filter((x): x is string => !!x);
  const bundle = await memoryBundle(mini, have);
  return bundle ? applyMemoryBundle(book, bundle, { from: MINI, homeIsHere, now: () => new Date("2026-10-18T10:00:00Z") }) : "unchanged";
}

const markers = (text: string) => /^(<<<<<<<|=======|>>>>>>>)/m.test(text);

describe("an agent's memory on two Macs", () => {
  test("a Mac with no repo clones it, and a later commit arrives with the same commit id", async () => {
    const m = macs();
    try {
      expect(await miniPulls(m.book, m.mini)).toBe("cloned");
      expect(readFileSync(join(m.mini, "system/persona.md"), "utf8")).toBe("I am Friday.\n");
      write(m.book, "notes/today.md", "met Ira\n");
      expect(await miniPulls(m.book, m.mini)).toBe("merged");
      expect(await memoryHead(m.mini)).toBe(await memoryHead(m.book));
      expect(await memoryBundle(m.book, [(await memoryHead(m.mini)) ?? ""])).toBeNull();
    } finally {
      m.done();
    }
  });

  test("edits to different notes on each Mac, made apart, both survive", async () => {
    const m = macs();
    try {
      await miniPulls(m.book, m.mini);
      write(m.book, "notes/work.md", "first paragraph\n\nsecond paragraph\n\nfrom the MacBook\n");
      write(m.mini, "notes/home.md", "from the mini\n");
      expect(await bookPulls(m.book, m.mini)).toBe("merged");
      expect(readFileSync(join(m.book, "notes/home.md"), "utf8")).toBe("from the mini\n");
      expect(await miniPulls(m.book, m.mini)).toBe("merged");
      expect(readFileSync(join(m.mini, "notes/work.md"), "utf8")).toContain("from the MacBook");
      expect(await memoryHead(m.mini)).toBe(await memoryHead(m.book));
    } finally {
      m.done();
    }
  });

  test("edits to different paragraphs of one note both survive without a clash", async () => {
    const m = macs();
    try {
      await miniPulls(m.book, m.mini);
      write(m.book, "notes/work.md", "first paragraph, edited on the MacBook\n\nsecond paragraph\n");
      write(m.mini, "notes/work.md", "first paragraph\n\nsecond paragraph, edited on the mini\n");
      expect(await bookPulls(m.book, m.mini)).toBe("merged");
      expect(readFileSync(join(m.book, "notes/work.md"), "utf8")).toBe("first paragraph, edited on the MacBook\n\nsecond paragraph, edited on the mini\n");
      expect(pendingConflicts(m.book)).toBeNull();
    } finally {
      m.done();
    }
  });

  test("the same line changed on both: the note keeps the home Mac's text, the other goes to the conflicts note, no markers (AE3)", async () => {
    const m = macs();
    try {
      await miniPulls(m.book, m.mini);
      write(m.book, "system/persona.md", "I am Friday, at work.\n");
      write(m.mini, "system/persona.md", "I am Friday, at home.\n");
      // The MacBook is Friday's home: its text stays.
      expect(await bookPulls(m.book, m.mini, true)).toBe("conflicted");
      const note = readFileSync(join(m.book, "system/persona.md"), "utf8");
      expect(note).toBe("I am Friday, at work.\n");
      expect(markers(note)).toBe(false);
      const conflicts = pendingConflicts(m.book) ?? "";
      expect(conflicts).toContain("## system/persona.md");
      expect(conflicts).toContain("I am Friday, at home.");
      expect(git(m.book, "status", "--porcelain")).toBe("");
      expect(git(m.book, "log", "-1", "--format=%an")).toBe("Sync\n");
      // The mini, not the home, takes the merge as it is and ends where the MacBook did.
      expect(await miniPulls(m.book, m.mini)).toBe("merged");
      expect(readFileSync(join(m.mini, "system/persona.md"), "utf8")).toBe("I am Friday, at work.\n");
      expect(readFileSync(join(m.mini, CONFLICTS_PATH), "utf8")).toContain("I am Friday, at home.");
    } finally {
      m.done();
    }
  });
});

describe("reflection after a clash", () => {
  test("is shown the other side of each clash and told to fold it in, and is not when there is none", async () => {
    const m = macs();
    try {
      const input = {
        agentId: "agent-1",
        agentName: "Friday",
        memoryRoot: m.book,
        parts: [{ chatId: "c", title: null, material: "x" }],
        material: "x",
        now: new Date(),
      };
      expect(await reflectionJob.prompt(input as never)).not.toContain("<conflicts>");
      await miniPulls(m.book, m.mini);
      write(m.book, "system/persona.md", "I am Friday, at work.\n");
      write(m.mini, "system/persona.md", "I am Friday, at home.\n");
      await bookPulls(m.book, m.mini, true);
      const prompt = String(await reflectionJob.prompt(input as never));
      expect(prompt).toContain("<conflicts>");
      expect(prompt).toContain("I am Friday, at home.");
      expect(prompt).toContain(`then delete ${CONFLICTS_PATH}`);
    } finally {
      m.done();
    }
  });
});

import { describe, expect, test } from "bun:test";
import { createElement, createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { checkFolder, completeFolder, expandPath, gitBranch, recentFolders } from "../mod/folders.ts";
import { conversationDirName } from "../core/desk-core.ts";
import { FolderPicker, browseWith, dialogPick, folderLabel, suggestedFolder, type BrowseWith } from "../app/src/desk/NewDesk.tsx";

describe("folders", () => {
  test("new desk prefers the current desk folder, then the selected agent's latest folder", () => {
    const recent = { a1: ["/work/latest", "/work/older"], a2: ["/other/project"] };

    expect(suggestedFolder(recent, "/work/current", "a1", "a1")).toEqual({ path: "/work/current", source: "current" });
    expect(suggestedFolder(recent, "/work/current", "a2", "a1")).toEqual({ path: "/other/project", source: "recent" });
    expect(suggestedFolder(recent, "/work/current", "a1", null)).toEqual({ path: "/work/latest", source: "recent" });
    expect(suggestedFolder(recent, null, "a1", "a1")).toEqual({ path: "/work/latest", source: "recent" });
    expect(suggestedFolder(recent, null, "missing", "a1")).toBeNull();
  });

  test("recent folders per agent, newest first, deduped; the desk's own folder by conversation", () => {
    const backend = mkdtempSync(join(tmpdir(), "loki-backend-"));
    try {
      const conv = (id: string, agent: string, at: string, cwd: string) => {
        const d = join(backend, "conversations", conversationDirName(id));
        mkdirSync(d, { recursive: true });
        writeFileSync(join(d, "conversation.json"), JSON.stringify({ id, agent_id: agent, last_message_at: at }));
        writeFileSync(join(d, "messages.jsonl"), JSON.stringify({ type: "session", id, cwd }) + "\n" + JSON.stringify({ type: "message" }) + "\n");
      };
      conv("c1", "a1", "2026-09-01T00:00:00Z", "/work/old");
      conv("c2", "a1", "2026-09-03T00:00:00Z", "/work/new");
      conv("c3", "a1", "2026-09-02T00:00:00Z", "/work/new");
      conv("c4", "a2", "2026-09-02T00:00:00Z", "/home/x");
      const r = recentFolders(backend);
      expect(r.byAgent).toEqual({ a1: ["/work/new", "/work/old"], a2: ["/home/x"] });
      expect(r.byConversation[conversationDirName("c4")]).toBe("/home/x");
    } finally {
      rmSync(backend, { recursive: true, force: true });
    }
  });

  test("expand, complete, check and branch", () => {
    const home = mkdtempSync(join(tmpdir(), "loki-home-"));
    try {
      mkdirSync(join(home, "proj", "alpha", ".git"), { recursive: true });
      mkdirSync(join(home, "proj", "beta"), { recursive: true });
      mkdirSync(join(home, "proj", ".hidden"), { recursive: true });
      writeFileSync(join(home, "proj", "alpha", ".git", "HEAD"), "ref: refs/heads/feature/x\n");
      writeFileSync(join(home, "proj", "note.txt"), "");
      expect(expandPath("~/proj", home)).toBe(join(home, "proj"));
      expect(completeFolder("~/proj/", home)).toEqual([join(home, "proj", "alpha"), join(home, "proj", "beta")]);
      expect(completeFolder("~/proj/al", home)).toEqual([join(home, "proj", "alpha")]);
      expect(completeFolder("relative/path", home)).toEqual([]);
      expect(checkFolder("~/proj/alpha", home)).toEqual({ ok: true, path: join(home, "proj", "alpha"), branch: "feature/x" });
      expect(checkFolder("~/proj/alpha/sub", home).reason).toBe("no such folder");
      expect(checkFolder("~/proj/note.txt", home).reason).toBe("not a folder");
      expect(gitBranch(join(home, "proj", "beta"))).toBeNull();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("Windows: drive paths and ~\\ expand with backslashes (the separator is injected, so this runs on the Mac)", () => {
    const home = "C:\\Users\\x";
    expect(expandPath("~\\proj", home, true)).toBe("C:\\Users\\x\\proj");
    expect(expandPath("~/proj", home, true)).toBe("C:\\Users\\x\\proj");
    expect(expandPath("~", home, true)).toBe(home);
    expect(expandPath("  ~\\  ", home, true)).toBe(home);
    expect(expandPath("C:\\Users\\x\\..\\y", home, true)).toBe("C:\\Users\\y");
    expect(expandPath("D:/work/loki", home, true)).toBe("D:\\work\\loki");
    expect(expandPath("~other\\proj", home, true)).not.toContain(home); // ~user is not this home
    // On the Mac a backslash is a character in a name, not a separator: ~\proj is not under home.
    expect(expandPath("~\\proj", "/Users/x", false)).toBe(posix.resolve("~\\proj"));
  });

  test("Windows: completion offers matching folders under a drive path or ~\\", () => {
    const dir = (name: string) => ({ name, isDirectory: () => true });
    const file = (name: string) => ({ name, isDirectory: () => false });
    const disk: Record<string, ReturnType<typeof dir>[]> = {
      "C:\\": [dir("Users"), dir("Windows"), file("pagefile.sys")],
      "C:\\Users\\x": [dir("Documents"), dir("Downloads"), dir("docker"), dir(".config"), file("Doc.txt"), dir("Pictures")],
    };
    const list = (d: string) => {
      const entries = disk[d];
      if (!entries) throw new Error(`ENOENT ${d}`);
      return entries;
    };
    const win = { windows: true, list };
    const home = "C:\\Users\\x";
    expect(completeFolder("C:\\Users\\x\\Doc", home, 12, win)).toEqual(["C:\\Users\\x\\docker", "C:\\Users\\x\\Documents"].sort());
    expect(completeFolder("C:\\Users\\x\\Docu", home, 12, win)).toEqual(["C:\\Users\\x\\Documents"]);
    expect(completeFolder("~\\Pic", home, 12, win)).toEqual(["C:\\Users\\x\\Pictures"]);
    expect(completeFolder("~/Pic", home, 12, win)).toEqual(["C:\\Users\\x\\Pictures"]);
    expect(completeFolder("~\\", home, 12, win)).toEqual(["C:\\Users\\x\\Documents", "C:\\Users\\x\\Downloads", "C:\\Users\\x\\Pictures", "C:\\Users\\x\\docker"].sort());
    expect(completeFolder("C:/Users/x/Down", home, 12, win)).toEqual(["C:\\Users\\x\\Downloads"]);
    expect(completeFolder("C:\\", home, 12, win)).toEqual(["C:\\Users", "C:\\Windows"]);
    expect(completeFolder("C:\\W", home, 12, win)).toEqual(["C:\\Windows"]);
    expect(completeFolder("C:\\Users\\x\\Doc", home, 1, win)).toHaveLength(1);
    expect(completeFolder("C:", home, 12, win)).toEqual([]); // drive-relative, not a path to complete
    expect(completeFolder("relative\\path", home, 12, win)).toEqual([]);
    expect(completeFolder("E:\\missing\\x", home, 12, win)).toEqual([]);
    // On the Mac a drive path is just text: nothing to complete.
    expect(completeFolder("C:\\Users\\x\\Doc", "/Users/x", 12, { windows: false, list })).toEqual([]);
  });

  test("Browse opens the system's dialog in the app on every system, the mod's chooser in a Mac tab, nothing in a tab elsewhere", () => {
    expect(browseWith(true, "macos")).toBe("dialog");
    expect(browseWith(true, "windows")).toBe("dialog");
    expect(browseWith(true, "linux")).toBe("dialog");
    expect(browseWith(false, "macos")).toBe("mod");
    expect(browseWith(false, "windows")).toBeNull();
    expect(browseWith(false, "linux")).toBeNull();
  });

  test("the dialog's choice becomes the folder; a cancelled dialog yields nothing", async () => {
    const calls: unknown[] = [];
    const chose = (value: string | string[] | null) => async (options: unknown) => {
      calls.push(options);
      return value;
    };
    expect(await dialogPick("/work/current", chose("/work/picked"))).toBe("/work/picked");
    expect(calls[0]).toMatchObject({ directory: true, multiple: false, defaultPath: "/work/current" });
    expect(await dialogPick(undefined, chose(null))).toBeNull();
    expect((calls[1] as { defaultPath?: string }).defaultPath).toBeUndefined();
    expect(await dialogPick(undefined, chose(["C:\\a", "C:\\b"]))).toBe("C:\\a");
    expect(await dialogPick(undefined, chose([]))).toBeNull();
    expect(await dialogPick(undefined, chose(""))).toBeNull();
    expect(await dialogPick(undefined, async () => { throw new Error("no dialog"); })).toBeNull();
  });

  test("the folder row shows Browse only where there is a chooser", () => {
    const html = (browser: BrowseWith) =>
      renderToStaticMarkup(
        createElement(FolderPicker, { inputRef: createRef<HTMLInputElement>(), folder: "", onType: () => {}, onChoose: () => {}, status: null, options: [], listOpen: false, setListOpen: () => {}, busy: false, onBrowse: () => {}, agentName: null, source: null, canBrowse: true, browser }),
      );
    expect(html("dialog")).toContain("browse…");
    expect(html("mod")).toContain("browse…");
    expect(html(null)).not.toContain("browse…");
    expect(html(null)).toContain('aria-label="folder"'); // typing and completion still work
  });

  test("a folder's name in the list: the last segment, split on backslashes too on Windows", () => {
    expect(folderLabel("/Users/x/proj", "macos")).toBe("proj");
    expect(folderLabel("/Users/x/proj/", "linux")).toBe("proj");
    expect(folderLabel("C:\\Users\\x\\proj", "windows")).toBe("proj");
    expect(folderLabel("C:/Users/x/proj", "windows")).toBe("proj");
    expect(folderLabel("C:\\", "windows")).toBe("C:");
    expect(folderLabel("/", "macos")).toBe("/");
    expect(folderLabel("/a/back\\slash", "macos")).toBe("back\\slash"); // a Mac name may hold a backslash
  });
});

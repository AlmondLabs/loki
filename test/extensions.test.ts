import { describe, expect, test } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Approvals, kindOf } from "../daemon/approvals.ts";
import { BackgroundTasks } from "../daemon/background.ts";
import { builtinExtensions, builtinKinds } from "../daemon/extensions.ts";
import { Schedules } from "../daemon/schedule.ts";
import { RENAMED_TOOLS } from "../daemon/tool-kinds.ts";

/**
 * Every chat's built-in tools come from one ordered list (daemon/extensions.ts), each tool says what kind it is on its
 * own definition, and every name is snake_case (docs/style.md, tool names).
 */
function builtins() {
  const dir = mkdtempSync(join(tmpdir(), "loki-extensions-"));
  const approvals = new Approvals();
  const extensions = builtinExtensions({
    approvals,
    backendDir: dir,
    background: new BackgroundTasks(() => {}),
    schedules: new Schedules(join(dir, "crons.json"), () => Promise.resolve(null)),
    history: { thread: () => [], compactedSince: () => false },
  });
  return { extensions, dir };
}

describe("the built-in tools", () => {
  test("the permission gate is installed first, and these are the tools every chat has", () => {
    const { extensions, dir } = builtins();
    try {
      expect(extensions[0]?.name).toBe("loki.approvals");
      // Quick replies (plan 066) reach every loki chat as a prompt section, with no tool of their own.
      expect(extensions.find((e) => e.name === "loki.replies")?.sections?.length).toBe(1);
      const names = extensions.flatMap((e) => (e.tools ?? []).map((t) => t.name));
      expect(new Set(names).size).toBe(names.length);
      expect(names.sort()).toEqual(
        [
          "user_ask",
          "background_run",
          "background_watch",
          "bash",
          "edit",
          "find",
          "grep",
          "history_read",
          "history_search",
          "ls",
          "memory_delete",
          "memory_edit",
          "memory_read",
          "memory_write",
          "read",
          "schedule_create",
          "schedule_delete",
          "schedule_list",
          "subagent",
          "web_search",
          "write",
        ].sort(),
      );
      // ls, find and grep are there for scripts only; bash does their work for the model (plan 094).
      const scriptsOnly = extensions.flatMap((e) => e.tools ?? []).filter((t) => t.callers?.includes("model") === false);
      expect(scriptsOnly.map((t) => t.name).sort()).toEqual(["find", "grep", "ls"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("every built-in tool declares its kind; none falls back to a command for want of one", () => {
    const { extensions, dir } = builtins();
    try {
      const kinds = builtinKinds(extensions);
      const names = extensions.flatMap((e) => (e.tools ?? []).map((t) => t.name));
      expect(names.filter((n) => !kinds.has(n))).toEqual([]);
      // Today's classes, kept as they were before each tool declared its own.
      expect(Object.fromEntries([...kinds].filter(([, k]) => k !== "read"))).toEqual({
        background_run: "command",
        bash: "command",
        edit: "edit",
        schedule_create: "command",
        schedule_delete: "command",
        write: "edit",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("every name is snake_case", () => {
    const { extensions, dir } = builtins();
    try {
      const names = extensions.flatMap((e) => (e.tools ?? []).map((t) => t.name));
      expect(names.filter((n) => !/^[a-z][a-z0-9]*(_[a-z0-9]+)*$/.test(n))).toEqual([]);
      expect(Object.values(RENAMED_TOOLS).filter((n) => n && !/^[a-z][a-z0-9]*(_[a-z0-9]+)*$/.test(n))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a tool that is not loki's: pi-durable's by name, a mod's or MCP's by its annotations, else a command", () => {
    expect(kindOf("write")).toBe("edit");
    expect(kindOf("mcp__github__list_issues", { readOnly: true })).toBe("read");
    expect(kindOf("mcp__github__create_issue")).toBe("command");
  });
});

describe("tools allowed always, under their old names", () => {
  test("carry over to the new names, written back once", () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-always-"));
    const path = join(dir, "approvals.json");
    try {
      writeFileSync(path, JSON.stringify({ always: ["Agent", "TaskOutput", "bash", "mcp__github__list_issues"] }));
      const approvals = new Approvals({ alwaysPath: path });
      // TaskOutput only read, so its allow is not carried to background_watch, which can also stop (plan 095).
      expect(approvals.always()).toEqual(["bash", "mcp__github__list_issues", "subagent"]);
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ always: ["bash", "mcp__github__list_issues", "subagent"] });
      // A merged tool that was a command carries its allow to the tool it is in.
      writeFileSync(path, JSON.stringify({ always: ["background_stop", "background_write"] }));
      expect(new Approvals({ alwaysPath: path }).always()).toEqual(["background_watch"]);
      // A list with no old names is left as it is on disk.
      writeFileSync(path, JSON.stringify({ always: ["bash"] }));
      new Approvals({ alwaysPath: path });
      expect(readFileSync(path, "utf8")).toBe(JSON.stringify({ always: ["bash"] }));
      expect(existsSync(path)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

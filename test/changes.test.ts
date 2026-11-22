import { describe, expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, MemoryStorage } from "@earendil-works/pi-durable";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { Approvals } from "../daemon/approvals.ts";
import { BackgroundTasks } from "../daemon/background.ts";
import { CHANGES_TOOL, changeList, changesExtension, fullOutputFile, readChanges, type GitExec } from "../daemon/changes.ts";
import { builtinExtensions } from "../daemon/extensions.ts";
import { AgentStore } from "../daemon/kernel/index.ts";
import { Schedules } from "../daemon/schedule.ts";
import { ChatEnv } from "../daemon/tool-results.ts";
import { must } from "./fixtures/must.ts";

const ctx = BACKGROUND_CONTEXT;

interface Call {
  args: readonly string[];
  env: Record<string, string | undefined>;
  cwd: string;
}

type Answer = string | Error;

function fakeGit(answer: (args: readonly string[]) => Answer = () => "") {
  const calls: Call[] = [];
  const exec: GitExec = (file, args, options) => {
    expect(file).toBe("git");
    calls.push({ args, env: { ...options.env }, cwd: options.cwd });
    const out = answer(args);
    return out instanceof Error ? Promise.reject(out) : Promise.resolve({ stdout: out, stderr: "" });
  };
  return { calls, exec };
}

const subcommandOf = (args: readonly string[]) => args.find((a) => !a.startsWith("-")) ?? "";

function configPairs(env: Record<string, string | undefined>): Map<string, string> {
  const pairs = new Map<string, string>();
  const count = Number(env.GIT_CONFIG_COUNT ?? "0");
  for (let i = 0; i < count; i++) pairs.set(must(env[`GIT_CONFIG_KEY_${i}`], `key ${i}`), must(env[`GIT_CONFIG_VALUE_${i}`], `value ${i}`));
  return pairs;
}

const exitWith = (code: number, stderr: string) => Object.assign(new Error(`Command failed: git\n${stderr}`), { code, stdout: "", stderr });

describe("changes_read's runner", () => {
  test("every git call switches off the programs a folder's config can name, blanks each filter driver, and keeps outside config out", async () => {
    const listing = [
      "core.fsmonitor\n/tmp/evil",
      "filter.lfs.clean\ngit-lfs clean -- %f",
      "filter.a=b.process\nevil",
      "filter.Odd.Name.smudge\nx",
      "diff.tool.textconv\nx",
    ]
      .map((e) => `${e}\0`)
      .join("");
    const git = fakeGit((args) => (subcommandOf(args) === "config" ? listing : ""));
    const base = { PATH: "/usr/bin", HOME: "/home/someone", GIT_DIR: "/elsewhere/.git", GIT_EXTERNAL_DIFF: "evil", git_work_tree: "/elsewhere" };
    for (const kind of ["status", "diff", "log", "show"])
      expect((await readChanges("/work", { kind }, { exec: git.exec, env: base })).failed).toBe(false);

    const ran = git.calls.filter((c) => subcommandOf(c.args) !== "config");
    expect(ran.map((c) => subcommandOf(c.args))).toEqual(["status", "diff", "log", "show"]);
    for (const call of git.calls) {
      expect(call.cwd).toBe("/work");
      expect(call.args.slice(0, 2)).toEqual(["--no-pager", "--no-optional-locks"]);
      expect(call.env).toMatchObject({ PATH: "/usr/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: devNull, GIT_OPTIONAL_LOCKS: "0" });
      expect(Object.keys(call.env).filter((k) => /^git_(dir|work_tree|external_diff)$/i.test(k))).toEqual([]);
      const pairs = configPairs(call.env);
      expect(pairs.get("core.fsmonitor")).toBe("false");
      expect(pairs.get("core.hooksPath")).toBe(devNull);
      expect(pairs.get("core.pager")).toBe("");
      expect(pairs.get("diff.external")).toBe("");
      expect(pairs.get("log.showSignature")).toBe("false");
      expect(pairs.get("gpg.program")).toBe("");
      expect(pairs.get("gpg.ssh.program")).toBe("");
      expect(pairs.get("protocol.allow")).toBe("never");
    }
    for (const call of ran) {
      const pairs = configPairs(call.env);
      for (const name of ["lfs", "a=b", "Odd.Name"])
        for (const key of ["clean", "smudge", "process"]) expect(pairs.get(`filter.${name}.${key}`), `${name}.${key}`).toBe("");
      expect(pairs.get("filter.lfs.required")).toBe("false");
      expect(call.args).toContain("--ignore-submodules=all");
      expect(call.args.at(-1)).toBe("--");
    }
    for (const call of ran.slice(1)) expect(call.args).toEqual(expect.arrayContaining(["--no-ext-diff", "--no-textconv"]));
    for (const call of ran.slice(2)) expect(call.args).toContain("--no-show-signature");
  });

  test("options from the kind's list, revisions and paths reach git in that order, the paths after --", async () => {
    const git = fakeGit(() => "diff output");
    const result = await readChanges(
      "/work",
      { kind: "diff", options: ["--staged", "--stat", "-U5"], revisions: ["main..HEAD"], paths: ["src/a.ts", "-weird name"] },
      { exec: git.exec, env: {} },
    );
    expect(result).toEqual({ text: "diff output", failed: false });
    const args = must(git.calls.at(-1), "the diff").args;
    expect(args.slice(args.indexOf("--staged"))).toEqual(["--staged", "--stat", "-U5", "main..HEAD", "--", "src/a.ts", "-weird name"]);
  });

  test.each([
    ["diff --output=x", { kind: "diff", options: ["--output=x"] }, '"--output=x" is not an option changes_read takes for diff'],
    ["-c core.pager=x", { kind: "log", options: ["-c", "core.pager=x"] }, '"-c" is not an option changes_read takes for log'],
    ["diff --no-index /dev/null x", { kind: "diff", options: ["--no-index"], revisions: ["/dev/null", "x"] }, '"--no-index" is not an option'],
    ["/dev/null as a revision", { kind: "diff", revisions: ["/dev/null", "x"] }, '"/dev/null" is not a revision'],
    ["--git-dir=x", { kind: "status", options: ["--git-dir=x"] }, '"--git-dir=x" is not an option changes_read takes for status'],
    ["--work-tree=x", { kind: "show", options: ["--work-tree=x"] }, '"--work-tree=x" is not an option changes_read takes for show'],
    ["--ext-diff", { kind: "diff", options: ["--ext-diff"] }, '"--ext-diff" is not an option'],
    ["--textconv", { kind: "show", options: ["--textconv"] }, '"--textconv" is not an option'],
    ["an option as a revision", { kind: "log", revisions: ["--output=x"] }, '"--output=x" is not a revision'],
    ["a format that checks signatures", { kind: "log", options: ["--format=%G?"] }, '"--format=%G?" is not an option'],
    ["revisions for status", { kind: "status", revisions: ["HEAD"] }, "status takes no revisions"],
    ["two commits to show", { kind: "show", revisions: ["HEAD", "HEAD~1"] }, "show takes at most 1 revision"],
    ["an unknown kind", { kind: "push" }, "kind is one of status, diff, log or show"],
  ])("%s is refused with a reason and runs no git", async (_name, args, reason) => {
    const git = fakeGit();
    const result = await readChanges("/work", args, { exec: git.exec, env: {} });
    expect(result.failed).toBe(true);
    expect(result.text).toContain(reason);
    expect(git.calls).toEqual([]);
  });

  test("git's own error comes back as the tool's error", async () => {
    const git = fakeGit((args) => (subcommandOf(args) === "show" ? exitWith(128, "fatal: bad revision 'nope'\n") : ""));
    expect(await readChanges("/work", { kind: "show", revisions: ["nope"] }, { exec: git.exec, env: {} })).toEqual({
      text: "fatal: bad revision 'nope'",
      failed: true,
    });
  });
});

describe("the change list for /advisor alone", () => {
  const entries = (...parts: string[]) => parts.map((p) => `${p}\0`).join("");

  function repo(answers: { status?: string; unstaged?: string; staged?: string; upstream?: Answer; log?: string; range?: string; checkout?: Answer }) {
    return fakeGit((args) => {
      const sub = subcommandOf(args);
      if (sub === "config") return "";
      if (sub === "rev-parse")
        return args.includes("--is-inside-work-tree") ? (answers.checkout ?? "true\n") : (answers.upstream ?? exitWith(128, "fatal: no upstream configured"));
      if (sub === "status") return answers.status ?? "";
      if (sub === "log") return answers.log ?? "";
      if (sub === "diff" && args.includes("--cached")) return answers.staged ?? "";
      if (sub === "diff") return args.some((a) => a.includes("...")) ? (answers.range ?? "") : (answers.unstaged ?? "");
      throw new Error(`unexpected git ${args.join(" ")}`);
    });
  }

  test("a dirty tree lists its files, staged and unstaged stats added, renames by their new name, new files without stats", async () => {
    const git = repo({
      status: entries(" M a.ts", "M  b.ts", "R  c-new.ts", "c-old.ts", "?? d.ts", "MM e.png"),
      unstaged: entries("3\t1\ta.ts", "-\t-\te.png"),
      staged: entries("2\t0\tb.ts", "1\t1\t", "c-old.ts", "c-new.ts", "4\t4\te.png"),
    });
    expect(await changeList("/work", { exec: git.exec, env: {} })).toEqual({
      kind: "uncommitted",
      files: [
        { path: "a.ts", added: 3, deleted: 1 },
        { path: "b.ts", added: 2, deleted: 0 },
        { path: "c-new.ts", added: 1, deleted: 1 },
        { path: "d.ts", added: null, deleted: null },
        { path: "e.png", added: null, deleted: null },
      ],
      more: 0,
    });
  });

  test("a clean tree with two commits not on its upstream lists those commits and their files", async () => {
    const git = repo({ upstream: "origin/main\n", log: "abc1234\u001ffix the parser\ndef5678\u001fadd a test\n", range: entries("5\t2\tsrc/parse.ts") });
    expect(await changeList("/work", { exec: git.exec, env: {} })).toEqual({
      kind: "unpushed",
      upstream: "origin/main",
      commits: [
        { hash: "abc1234", subject: "fix the parser" },
        { hash: "def5678", subject: "add a test" },
      ],
      files: [{ path: "src/parse.ts", added: 5, deleted: 2 }],
      more: 0,
    });
    const log = must(
      git.calls.find((c) => subcommandOf(c.args) === "log"),
      "the log",
    ).args;
    expect(log).toContain("@{upstream}..HEAD");
  });

  test("a clean tree that is pushed, or a branch with no upstream, has nothing changed", async () => {
    expect(await changeList("/work", { exec: repo({ upstream: "origin/main\n" }).exec, env: {} })).toEqual({ kind: "nothing_changed" });
    expect(await changeList("/work", { exec: repo({}).exec, env: {} })).toEqual({ kind: "nothing_changed" });
  });

  test("a folder that is not a checkout, and a chat with no folder, each say so", async () => {
    const outside = repo({ checkout: exitWith(128, "fatal: not a git repository") });
    expect(await changeList("/work", { exec: outside.exec, env: {} })).toEqual({ kind: "not_a_checkout" });
    expect(await changeList("/work", { exec: repo({ checkout: "false\n" }).exec, env: {} })).toEqual({ kind: "not_a_checkout" });
    const none = fakeGit();
    expect(await changeList(undefined, { exec: none.exec, env: {} })).toEqual({ kind: "no_folder" });
    expect(none.calls).toEqual([]);
  });

  test("250 changed files list the first 200 and count the other 50", async () => {
    const names = Array.from({ length: 250 }, (_, i) => `f${String(i).padStart(3, "0")}.ts`);
    const git = repo({ status: entries(...names.map((n) => ` M ${n}`)), unstaged: entries(...names.map((n) => `1\t0\t${n}`)) });
    const list = await changeList("/work", { exec: git.exec, env: {} });
    if (list.kind !== "uncommitted") throw new Error(`expected uncommitted, got ${list.kind}`);
    expect(list.files).toHaveLength(200);
    expect(list.files.at(-1)?.path).toBe("f199.ts");
    expect(list.more).toBe(50);
  });

  test("every call the list makes carries the same switches", async () => {
    const git = repo({ status: entries(" M a.ts"), unstaged: entries("1\t0\ta.ts") });
    await changeList("/work", { exec: git.exec, env: {} });
    expect(git.calls.length).toBeGreaterThan(1);
    for (const call of git.calls) {
      expect(call.args.slice(0, 2)).toEqual(["--no-pager", "--no-optional-locks"]);
      expect(configPairs(call.env).get("core.hooksPath")).toBe(devNull);
    }
  });
});

describe("changes_read as a tool", () => {
  test("a normal chat is neither offered changes_read nor lets a script call it; a chat whose tool list adds it is offered it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-changes-"));
    const registry = createRegistry();
    for (const extension of builtinExtensions({
      approvals: new Approvals(),
      backendDir: dir,
      background: new BackgroundTasks(() => {}),
      schedules: new Schedules(join(dir, "crons.json"), () => Promise.resolve(null)),
      history: { thread: () => [], compactedSince: () => false },
    }))
      registry.install(extension);
    const store = await AgentStore.open({ storage: new MemoryStorage() }, { models: createModels(), registry }, ctx);
    try {
      await store.setAgent({ id: "agent-a", name: "Ada" }, ctx);
      const normal = await (await store.createChat("normal", { title: null }, ctx)).agent(ctx);
      expect(normal.tools.map((t) => t.name)).toContain("read");
      expect(normal.tools.map((t) => t.name)).not.toContain(CHANGES_TOOL);
      expect(normal.callable.map((t) => t.name)).not.toContain(CHANGES_TOOL);

      const tool = must(
        changesExtension().tools?.find((t) => t.name === CHANGES_TOOL),
        "the tool",
      );
      const advisor = await (await store.createChat("advisor-normal", { title: null, agent: { modelTools: { add: [tool] } } }, ctx)).agent(ctx);
      expect(advisor.tools.map((t) => t.name)).toContain(CHANGES_TOOL);
    } finally {
      await store.close(ctx);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("output past bash's budget is saved whole in the chat's tool-results folder; shorter output is not", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-changes-"));
    try {
      const resultsDir = join(dir, "tool-results", "advisor-c");
      const env = new ChatEnv({ cwd: dir, resultsDir });
      expect(await fullOutputFile(env, "short\n", ctx)).toBeNull();
      const long = Array.from({ length: 3000 }, (_, i) => `line ${i}`).join("\n");
      const file = must(await fullOutputFile(env, long, ctx), "the saved file");
      expect(file.startsWith(resultsDir)).toBe(true);
      expect(existsSync(file)).toBe(true);
      expect(readFileSync(file, "utf8")).toBe(long);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

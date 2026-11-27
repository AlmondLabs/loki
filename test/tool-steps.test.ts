import { describe, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StepDetail, StepsTouch, ToolSteps } from "../app/src/chat/tool-steps.tsx";
import { TOOL_TEXT_MAX, toolInput, toolLabel, toolOutput, toolStep, withResult } from "../core/harness.ts";
import { shownStep } from "../core/attention/pi-steps.ts";
import { shellTitle } from "../core/shell-title.ts";
import { must } from "./fixtures/must.ts";
import {
  isNamedStep,
  isWorkRow,
  lastFailure,
  stepFailed,
  stepIcon,
  stepLine,
  stepLines,
  stepTarget,
  stepTitle,
  stepVerb,
  toolRuns,
  workSummary,
} from "../app/src/shared/tool-steps.ts";
import type { TranscriptRow } from "../core/attention/transcript.ts";

const bash = (failed = false): TranscriptRow => ({ role: "tool", text: "Bash · ls", tool: { name: "Bash", ...(failed ? { failed: true } : {}) } });
const read = (failed = false): TranscriptRow => ({ role: "tool", text: "Read · a.ts", tool: { name: "Read", ...(failed ? { failed: true } : {}) } });

describe("the line for a run of tools", () => {
  test("commands first, then the other tools, then what failed", () => {
    expect(workSummary([bash()])).toBe("Ran a command");
    expect(workSummary([bash(), bash(), bash()])).toBe("Ran 3 commands");
    expect(workSummary([read(), read()])).toBe("Used 2 tools");
    expect(workSummary([read()])).toBe("Read a.ts");
    expect(workSummary([read(true)])).toBe("Read a.ts · failed");
    expect(workSummary([{ role: "tool", text: "Read", tool: { name: "Read" } }])).toBe("Used a tool");
    expect(workSummary([{ role: "tool", text: "Read signups.csv · signups.csv", tool: { name: "Read signups.csv" } }])).toBe("Read signups.csv");
    expect(workSummary([bash(), read(true), ...Array.from({ length: 8 }, () => read())])).toBe("Ran a command, used 9 tools · 1 failed");
    expect(workSummary([bash(), read()], true)).toBe("Working");
  });

  test("a step reads as a verb and what it was done to; old rows without a step still read by their label", () => {
    expect(stepVerb("Bash")).toBe("Ran");
    expect(stepVerb("Grep")).toBe("Searched");
    expect(stepVerb("mcp_thing")).toBe("Used mcp thing");
    expect(stepVerb("Read signups.csv")).toBe("Read signups.csv");
    expect(stepTarget({ role: "tool", text: "Read · app/src/x.ts" })).toBe("app/src/x.ts");
    expect(stepTarget({ role: "tool", text: "Bash" })).toBeNull();
    expect(stepVerb("background_run")).toBe("Started in background");
    expect(stepVerb("subagent_status")).toBe("Checked an agent");
    expect(stepVerb("subagent_stop")).toBe("Stopped an agent");
    expect(stepIcon("subagent_status")).toBe("bot");
    expect(stepIcon("subagent_stop")).toBe("bot");
  });

  test("pi's shell tool reads as a command too, and a step's sheet is titled by its tool (plan 038)", () => {
    expect(stepVerb("bash")).toBe("Ran");
    expect(stepIcon("bash")).toBe("terminal");
    expect(stepTitle("bash")).toBe("Bash");
    expect(stepTitle("memory_read")).toBe("Memory read");
    expect(stepTitle("mcp__linear__list_issues")).toBe("linear.list_issues");
  });

  test("a background task reads by the description it was started with; its whole command rides along to be opened", () => {
    const notice: TranscriptRow = {
      role: "event",
      text: "background task bg-1 completed",
      summary: "Start the dev server",
      command: "cd /w && PORT=1 bun run dev",
    };
    expect(stepTarget(notice)).toBe("Start the dev server");
    expect(stepTarget({ ...notice, summary: "bun run dev" })).toBe("bun run dev");
  });

  test("a described command reads by its description; the command stays the step's input", () => {
    const step = toolStep("Bash", { command: "cd backend && grep -n x tests/*.py", description: "Find hard-coded names in tests" });
    expect(step).toMatchObject({ input: "cd backend && grep -n x tests/*.py", description: "Find hard-coded names in tests" });
    const row: TranscriptRow = { role: "tool", text: "Bash · cd backend && grep -n x tests/*.py", tool: step };
    expect(stepTarget(row)).toBe("Find hard-coded names in tests");
    expect(workSummary([row])).toBe("Find hard-coded names in tests");
    expect(workSummary([{ ...row, tool: { ...step, failed: true } }])).toBe("Find hard-coded names in tests · failed");
    expect(workSummary([row, row])).toBe("Ran 2 commands");
    expect(workSummary([row], true)).toBe("Working");
  });

  test("no description, or only a description so far: no second copy of it", () => {
    expect(toolStep("Bash", { command: "ls" }).description).toBeUndefined();
    const early = toolStep("Bash", { description: "List files" });
    expect(early.input).toBeUndefined();
    expect(early.description).toBe("List files");
    expect(toolStep("Bash", { command: "ls", description: "  two\nlines " }).description).toBe("two");
  });

  test("consecutive tool rows are one run; a message or a break ends it", () => {
    const rows: TranscriptRow[] = [{ role: "user", text: "go" }, bash(), read(), { role: "assistant", text: "ok" }, bash(), read(), read()];
    expect([...toolRuns(rows)]).toEqual([
      [1, 3],
      [4, 7],
    ]);
    expect([...toolRuns(rows, 0, (k) => k === 5)]).toEqual([
      [1, 3],
      [4, 5],
      [5, 7],
    ]);
    expect([...toolRuns(rows, 5)]).toEqual([[5, 7]]);
  });
});

describe("a step's title: the agent's description, else its command without the shell wrapping (plan 2026-11-23-1851)", () => {
  const wrapped = "cd /Users/x/worktrees/crm && env -i HOME=/h PATH=/p A=1 uv run pytest -q tests/a.py > /tmp/l 2>&1; result=$?; tail -12 /tmp/l; exit $result";

  test("a command loses its cd, env, assignments, read-back redirect and exit code, and nothing else", () => {
    expect(shellTitle(wrapped)).toBe("uv run pytest -q tests/a.py");
    expect(shellTitle("PATH=/p bun run build")).toBe("bun run build");
    expect(shellTitle("npm test")).toBe("npm test");
    expect(shellTitle("echo x > config.json")).toBe("echo x > config.json");
    expect(shellTitle("bun run build > /dev/null 2>&1")).toBe("bun run build");
    expect(shellTitle("cd /x")).toBe("cd /x");
    expect(shellTitle('echo "a && b"')).toBe('echo "a && b"');
    expect(shellTitle('cd /x && echo "a && b; exit 1" > /tmp/o; cat /tmp/o')).toBe('echo "a && b; exit 1"');
  });

  test("a row's label is its trimmed command, cut after trimming", () => {
    expect(toolLabel("bash", { command: wrapped })).toBe("bash · uv run pytest -q tests/a.py");
    expect(toolStep("bash", { command: wrapped }).input).toBe(wrapped);
  });

  test("a long path keeps its end, so the step's file name survives the cut; other long targets keep their start", () => {
    const deep = `/Users/someone/projects/${"deep/".repeat(12)}`;
    const label = toolLabel("read", { path: `${deep}docs/outline-guide.md` });
    expect(label.endsWith("/docs/outline-guide.md")).toBe(true);
    expect(label).toContain("read · …");
    expect(stepLine({ role: "tool", text: label, tool: { name: "read" } }).title).toBe("outline-guide.md");
    const skill = toolLabel("read", { path: `${deep}fmt-docs-writer/SKILL.md` });
    expect(stepLine({ role: "tool", text: skill, tool: { name: "read" } }).title).toBe("fmt-docs-writer");
    const query = "x".repeat(100);
    expect(toolLabel("web_search", { query })).toBe(`web_search · ${"x".repeat(77)}…`);
  });

  test("a ticket's description is its body, never its step's title", () => {
    const ticket = { account: "jira", project: "OPS", type: "Task", title: "Rotate the keys", description: "The keys expire on Friday.\nRotate both." };
    const step = toolStep("ticket_propose", ticket);
    expect(step.description).toBeUndefined();
    expect(step.input).toBe(JSON.stringify(ticket, null, 2));
    expect(toolLabel("ticket_propose", ticket)).toBe("ticket_propose · Rotate the keys");
    expect(toolStep("mcp__loki__ticket_propose", ticket).description).toBeUndefined();
  });

  test("an ACP agent's description still titles its row", () => {
    const step = toolStep("ls -la", { command: "ls -la", description: "List files" });
    expect(step).toMatchObject({ input: "ls -la", description: "List files" });
  });

  test("a described call's input is the rest of its arguments", () => {
    const watch = toolStep("background_watch", { task_id: "bg-1", description: "Wait for the build" });
    expect(watch).toMatchObject({ input: JSON.stringify({ task_id: "bg-1" }, null, 2), description: "Wait for the build" });
    const prs = { owner: "loki", repo: "app", description: "List open PRs" };
    const mcp = toolStep("mcp__github__list_prs", prs);
    expect(mcp).toMatchObject({ input: JSON.stringify({ owner: "loki", repo: "app" }, null, 2), description: "List open PRs" });
    expect(toolInput("mcp__github__list_prs", prs)).toBe(mcp.input);
    expect(toolLabel("mcp__github__list_prs", prs)).toBe("mcp__github__list_prs");
  });

  test("a tool's own multi-line description titles the step by its first line and stays whole in the input", () => {
    const issue = { title: "Checkout fails", teamId: "web", description: "Safari 17 drops the cart.\n\nSteps:\n- add an item\n- pay" };
    expect(toolStep("mcp__linear__create_issue", issue)).toMatchObject({
      input: JSON.stringify(issue, null, 2),
      description: "Safari 17 drops the cart.",
    });
  });

  test("a script reads by its description line", () => {
    expect(toolStep("codemode", { code: "// @description: Count open PRs\nreturn 1" }).description).toBe("Count open PRs");
    expect(toolStep("codemode", { code: '// @options: {"timeout_ms": 1000}\n// @description: Count open PRs\nreturn 1' }).description).toBe("Count open PRs");
    expect(toolStep("codemode", { code: "return 1" }).description).toBeUndefined();
  });
});

describe("loki's tools, and Claude Code's names for the same steps", () => {
  test("each reads the same under either name; loki's own old names are gone, saved chats renamed (plan 044)", () => {
    for (const [loki, claude, verb] of [
      ["background_watch", "Monitor", "Waited on a command"],
      ["subagent", "Agent", "Asked an agent"],
      ["skill", "Skill", "Read skill"],
      ["user_ask", "AskUserQuestion", "Asked you"],
    ] as const) {
      expect(stepVerb(loki), loki).toBe(verb);
      expect(stepVerb(claude), claude).toBe(verb);
      expect(stepIcon(loki), loki).toBe(stepIcon(claude));
    }
    expect(stepVerb("background_run")).toBe("Started in background");
    expect(stepVerb("subagent_status")).toBe("Checked an agent");
    expect(stepVerb("subagent_stop")).toBe("Stopped an agent");
    expect(stepIcon("subagent_status")).toBe("bot");
    expect(stepIcon("subagent_stop")).toBe("bot");
    expect(stepVerb("TaskOutput")).toBe("Read a command's output");
    expect(stepVerb("TaskStop")).toBe("Stopped a command");
    expect(stepVerb("background_output")).toBe("Used background output");
    expect(stepVerb("bash_background")).toBe("Used bash background");
    expect(stepVerb("ask_user")).toBe("Used ask user");
  });

  test("the question card's tool shows its whole input, the questions with their options", () => {
    const input = { questions: [{ question: "Which colour?", options: [{ label: "Red" }], multi_select: false }] };
    expect(toolInput("user_ask", input)).toBe(JSON.stringify(input, null, 2));
  });
});

describe("tool inputs and outputs are kept", () => {
  test("the input a reader recognises in full, else the whole input; outputs as text, capped", () => {
    expect(toolInput("Bash", { command: "ls -la\nwc -l x" })).toBe("ls -la\nwc -l x");
    expect(toolInput("Custom", '{"a":1}')).toBe('{\n  "a": 1\n}');
    expect(toolInput("Bash", '{"comm')).toBeUndefined();
    expect(
      toolOutput([
        { type: "text", text: "one" },
        { type: "text", text: "two" },
      ]),
    ).toBe("one\ntwo");
    const long = must(toolOutput("x".repeat(TOOL_TEXT_MAX + 10)), "the tool's output");
    expect(long.startsWith("x".repeat(TOOL_TEXT_MAX))).toBe(true);
    expect(long.endsWith("10 more characters")).toBe(true);
    expect(toolOutput(long)).toBe(long);
    expect(toolOutput(toolOutput("y".repeat(TOOL_TEXT_MAX * 3)))).toBe(toolOutput("y".repeat(TOOL_TEXT_MAX * 3)));
  });
});

describe("what leaves the daemon of a tool (plan 035)", () => {
  const big = "z".repeat(100_000);
  test("a result is its text, capped; a picture in it leaves nothing", () => {
    const raw = [
      { type: "image", data: "iVBORw0KGgo".repeat(50_000), mimeType: "image/png" },
      { type: "text", text: big },
    ];
    const step = shownStep({ kind: "result", id: "t1", output: raw, failed: false });
    expect(step).toEqual({ kind: "result", id: "t1", output: toolOutput(raw), failed: false });
    expect(JSON.stringify(step).length).toBeLessThan(TOOL_TEXT_MAX + 200);
    expect(withResult({ name: "Read" }, step.kind === "result" ? step.output : null, false)).toEqual(withResult({ name: "Read" }, raw, false));
  });
  test("a call's long strings are cut, nested ones too, and it reads the same", () => {
    const args = { path: "notes.md", content: big, edits: [{ old_text: big, new_text: "short" }] };
    const step = shownStep({ kind: "call", name: "write", args, id: "c1", at: null });
    const cut = step.kind === "call" ? (step.args as typeof args) : args;
    expect(cut.content.length).toBe(TOOL_TEXT_MAX);
    expect(cut.edits[0].old_text.length).toBe(TOOL_TEXT_MAX);
    expect(cut.edits[0].new_text).toBe("short");
    expect(cut.path).toBe("notes.md");
    expect(toolStep("write", cut, "c1")).toEqual(toolStep("write", args, "c1"));
    expect(toolLabel("write", cut)).toBe(toolLabel("write", args));
    const streaming = shownStep({ kind: "call", name: "write", args: `{"content":"${big}`, id: "c1", at: null });
    expect(streaming.kind === "call" && streaming.args).toBe(`{"content":"${big}`);
  });
  test("words and messages pass as they are", () => {
    const words = { kind: "assistant" as const, text: big, at: null };
    expect(shownStep(words)).toBe(words);
  });
});

describe("a stretch of work", () => {
  const at = (m: number) => new Date(Date.UTC(2026, 8, 30, 16, m)).toISOString();
  const bg = (name: string, m: number, failed = false): TranscriptRow => ({
    role: "event",
    text: `background task exec_${m} ${failed ? "failed" : "completed"}`,
    summary: name,
    detail: failed ? "tasks failed ELB health checks" : "ok",
    at: at(m),
  });
  const tool = (name: string, m: number): TranscriptRow => ({ role: "tool", text: `${name} · x`, tool: { name }, at: at(m) });
  const skill: TranscriptRow = { role: "event", text: "skill loaded", summary: "fmt-data-analyst", detail: "# skill", at: at(1) };
  const rows = [
    bg("Revalidate approved dev deployment targets", 0),
    tool("Read", 1),
    skill,
    tool("Grep", 2),
    tool("Read", 2),
    bg("Create scoped Dealshield task security group", 5),
    tool("Bash", 6),
    bg("Deploy approved Dealshield image and ECS routing", 14, true),
    tool("Read", 14),
  ];

  test("background tasks and skills are part of it; canvas activity and compactions are not", () => {
    expect(rows.every(isWorkRow)).toBe(true);
    expect(isWorkRow({ role: "event", text: "canvas activity" })).toBe(false);
    expect(isWorkRow({ role: "event", text: "context compacted" })).toBe(false);
    expect([...toolRuns([{ role: "user", text: "go" }, ...rows, { role: "assistant", text: "done" }])]).toEqual([[1, 10]]);
  });

  test("one line: how long, what ran, what failed; the failure is found without opening it", () => {
    expect(workSummary(rows)).toBe("Worked 14 min · 3 background tasks, a command, 5 tools · 1 failed");
    expect(workSummary(rows, true)).toBe("Working · 14 min");
    expect(stepFailed(rows[7])).toBe(true);
    expect(lastFailure(rows)).toBe(7);
    expect(stepTarget(rows[7])).toBe("Deploy approved Dealshield image and ECS routing");
    expect(stepVerb("Background task")).toBe("Ran in background");
  });

  test("opened: every step in one flat list; background tasks, commands and failures in full, the rest quieter", () => {
    expect(rows.map(isNamedStep)).toEqual([true, false, false, false, false, true, true, true, false]);
  });
});

describe("Codex-style tools", () => {
  test("exec_command is a command, its `command` the command shown; patches are edits; web_search searches", async () => {
    const { toolStep, toolLabel } = await import("../core/harness.ts");
    const args = { command: "git fetch origin prod && git log --oneline -5 origin/prod", description: "Fetch prod and inspect new commits" };
    const step = toolStep("exec_command", args);
    expect(step.input).toBe(args.command);
    expect(step.description).toBe(args.description);
    expect(toolLabel("exec_command", args)).toBe(`exec_command · ${args.command}`);
    const row: TranscriptRow = { role: "tool", text: toolLabel("exec_command", args), tool: step };
    expect(isNamedStep(row)).toBe(true);
    expect(workSummary([row])).toBe("Fetch prod and inspect new commits");
    expect(stepVerb("exec_command")).toBe("Ran");
    expect(stepVerb("ApplyPatch")).toBe("Edited");
    expect(stepVerb("memory_apply_patch")).toBe("Updated memory");
    expect(stepVerb("web_search")).toBe("Searched the web");
    expect(isNamedStep({ role: "tool", text: "ApplyPatch", tool: { name: "ApplyPatch" } })).toBe(false);
  });
});

describe("skills are read steps (plan 2026-11-24-1736, R4)", () => {
  test("Claude Code's skill call, loki's read of a SKILL.md and an old Skill call each read as the skill", () => {
    expect(line(tool("Load skill: ce-plan", ""))).toEqual(["ce-plan", "Skill", "skill"]);
    expect(line(tool("read", "/Users/me/.agents/skills/apple-hig/SKILL.md"))).toEqual(["apple-hig", "Skill", "skill"]);
    expect(line(tool("Read", "C:\\skills\\unslop\\SKILL.md"))).toEqual(["unslop", "Skill", "skill"]);
    expect(line(tool("Skill", "ce-plan"))).toEqual(["ce-plan", "Skill", "skill"]);
    expect(line(tool("read", "/a/b/README.md"))).toEqual(["README.md", "Read", "file"]);
  });

  test("a lone skill step sums up as reading that skill", () => {
    expect(workSummary([tool("Load skill: ce-plan", "")])).toBe("Read skill ce-plan");
    expect(workSummary([tool("read", "/x/skills/apple-hig/SKILL.md")])).toBe("Read skill apple-hig");
  });
});

describe("a described step's line and what opens under it (plan 2026-11-23-1851, U6)", () => {
  const described = (name: string, description: string, failed = false): TranscriptRow => ({
    role: "tool",
    text: `${name} · x`,
    tool: { name, description, ...(failed ? { failed: true } : {}) },
  });
  const times = (out: string, text: string) => out.split(text).length - 1;

  test("a one-step stretch reads as the step's description, of any kind of step", () => {
    expect(workSummary([described("background_run", "Start the dev server")])).toBe("Start the dev server");
    expect(workSummary([described("codemode", "Count open PRs", true)])).toBe("Count open PRs · failed");
    expect(workSummary([described("mcp__github__list_prs", "List open PRs")])).toBe("List open PRs");
    expect(workSummary([bash()])).toBe("Ran a command");
  });

  test("on the phone, a background notice opens on its whole command, once, then what it said", () => {
    const row: TranscriptRow = {
      role: "event",
      text: "background task bg-1 completed",
      summary: "uv run pytest -q tests/a.py",
      command: "env -i HOME=/h uv run pytest -q tests/a.py",
      detail: "42 passed",
    };
    const out = renderToStaticMarkup(createElement(StepDetail, { row }));
    expect(out).toContain('<h3 class="loki-steps-heading">Command</h3><pre class="loki-steps-code">env -i HOME=/h uv run pytest -q tests/a.py</pre>');
    expect(times(out, "env -i HOME=/h uv run pytest -q tests/a.py")).toBe(1);
    expect(out.indexOf(">Command<")).toBeLessThan(out.indexOf(">Result<"));
    expect(out).toContain("42 passed");
  });

  test("on the phone, a sub-agent's step shows the prompt it was given, once, under Asked", () => {
    const prompt = "Open Safari, sign in twice and say where the cookie goes.";
    const row: TranscriptRow = {
      role: "tool",
      text: "subagent · Reproduce the login loop",
      tool: { name: "subagent", description: "Reproduce the login loop", input: prompt, output: "Reproduced." },
    };
    const out = renderToStaticMarkup(createElement(StepDetail, { row }));
    expect(out).toContain(`<h3 class="loki-steps-heading">Asked</h3><pre class="loki-steps-code">${prompt}</pre>`);
    expect(times(out, prompt)).toBe(1);
    expect(out.indexOf(">Asked<")).toBeLessThan(out.indexOf(">Output<"));
  });

  test("on the phone, the failure under a closed stretch keeps failed beside its cut title", () => {
    const steps = createElement(ToolSteps, { rows: [bash(), described("Bash", "Run the CRM tests", true)], running: false });
    const out = renderToStaticMarkup(createElement(StepsTouch.Provider, { value: true }, steps));
    expect(out).toContain('<span class="loki-truncate">Run the CRM tests</span><span>failed</span>');
  });

  test("on the desktop, no failure is named under a closed stretch; the line counts it (plan 2026-11-24-1701)", () => {
    const out = renderToStaticMarkup(createElement(ToolSteps, { rows: [bash(), described("Bash", "Run the CRM tests", true)], running: false }));
    expect(out).toContain("· 1 failed");
    expect(out).not.toContain("loki-steps-failure");
  });
});

const tool = (name: string, label: string, more: Partial<NonNullable<TranscriptRow["tool"]>> = {}): TranscriptRow => ({
  role: "tool",
  text: label ? `${name} · ${label}` : name,
  tool: { name, ...more },
});
const line = (row: TranscriptRow) => {
  const { title, tag, icon } = stepLine(row);
  return [title, tag, icon];
};

describe("one line for every step: title, tag, icon", () => {
  test("loki's own tools", () => {
    expect(line(tool("bash", "uv run pytest"))).toEqual(["uv run pytest", "Ran", "terminal"]);
    expect(line(tool("read", "/tmp/crm/test_seed.py"))).toEqual(["test_seed.py", "Read", "file"]);
    expect(line(tool("write", "/tmp/crm/out.json"))).toEqual(["out.json", "Wrote", "file"]);
    expect(line(tool("edit", "/tmp/crm/a.ts"))).toEqual(["a.ts", "Edited", "pencil"]);
    expect(line(tool("ls", "/Users/x/loki/app/"))).toEqual(["app", "Listed", "folder"]);
    expect(line(tool("grep", "TODO"))).toEqual(["TODO", "Searched", "search"]);
    expect(line(tool("find", "*.md"))).toEqual(["*.md", "Found", "search"]);
    expect(line(tool("memory_read", "reference/farmart/crm.md"))).toEqual(["crm.md", "Memory", "file"]);
    expect(line(tool("memory_edit", "reference/farmart/crm.md"))).toEqual(["crm.md", "Memory", "pencil"]);
    expect(line(tool("web_search", "bun 1.3 release"))).toEqual(["bun 1.3 release", "Web", "globe"]);
    expect(line(tool("subagent", "", { description: "Fix the forecast helper" }))).toEqual(["Fix the forecast helper", "Agent", "bot"]);
    expect(line(tool("user_ask", "Which branch?"))).toEqual(["Which branch?", "Asked you", "question"]);
    expect(line(tool("codemode", ""))).toEqual(["A script", "Script", "code"]);
    expect(line(tool("codemode", "", { description: "Count open PRs" }))).toEqual(["Count open PRs", "Script", "code"]);
    expect(line(tool("background_run", "bun run dev"))).toEqual(["bun run dev", "Started", "terminal"]);
    expect(line(tool("background_watch", ""))).toEqual(["A command", "Waited", "terminal"]);
    expect(line(tool("suggestion_create", "Review the CRM plan"))).toEqual(["Review the CRM plan", "Suggested", "learn"]);
    expect(line(tool("chat_message", "The tests pass now"))).toEqual(["The tests pass now", "Message", "desk"]);
    expect(line(tool("reply_propose", "Thanks, merged"))).toEqual(["Thanks, merged", "Draft", "mail"]);
    expect(line(tool("ticket_propose", "Fix login"))).toEqual(["Fix login", "Ticket", "ticket"]);
  });

  test("Claude Code's and Codex's tools", () => {
    expect(line(tool("Read", "/a/b/c.ts"))).toEqual(["c.ts", "Read", "file"]);
    expect(line(tool("MultiEdit", "/a/b/c.ts"))).toEqual(["c.ts", "Edited", "pencil"]);
    expect(line(tool("Glob", "**/*.ts"))).toEqual(["**/*.ts", "Found", "search"]);
    expect(line(tool("WebFetch", "https://bun.sh/docs/"))).toEqual(["bun.sh/docs", "Fetched", "globe"]);
    expect(line(tool("exec_command", "npm test"))).toEqual(["npm test", "Ran", "terminal"]);
    expect(line(tool("apply_patch", "src/app.ts"))).toEqual(["app.ts", "Edited", "pencil"]);
    expect(line(tool("Skill", "ce-plan"))).toEqual(["ce-plan", "Skill", "skill"]);
  });

  test("MCP tools read as words with their server as the tag, and unknown tools as words", () => {
    expect(line(tool("mcp__github__list_pull_requests", ""))).toEqual(["List pull requests", "Github", "wrench"]);
    expect(line(tool("frobnicate_widget", ""))).toEqual(["Frobnicate widget", "Tool", "wrench"]);
  });

  test("an ACP agent's step keeps its own title and takes its icon and tag from the kind it gave", () => {
    expect(line(tool("Read signups.csv", "/a/signups.csv", { acp_kind: "read" }))).toEqual(["signups.csv", "Read", "file"]);
    expect(line(tool("Run tests", "npm test", { acp_kind: "execute" }))).toEqual(["npm test", "Ran", "terminal"]);
    expect(line(tool("Look around", ""))).toEqual(["Look around", "Tool", "wrench"]);
  });

  test("a failed step's tag says so, in place of its usual one", () => {
    expect(line(tool("read", "/a/b.ts", { failed: true }))).toEqual(["b.ts", "Failed", "close"]);
  });

  test("a file name shared by two steps shows its folder; the whole path stays for hover", () => {
    const lines = stepLines([tool("memory_edit", "a/x.md"), tool("memory_edit", "b/x.md"), tool("read", "/c/y.md"), tool("read", "/c/y.md")]);
    expect(lines.map((l) => l.title)).toEqual(["a/x.md", "b/x.md", "y.md", "y.md"]);
    expect(lines[0].full).toBe("a/x.md");
    expect(stepLine(tool("read", "C:\\work\\loki\\notes.md")).title).toBe("notes.md");
  });

  test("a described step keeps its description whole, not cut to a file name", () => {
    expect(stepLine(tool("edit", "/a/b.ts", { description: "Fix the parser/lexer bug" })).title).toBe("Fix the parser/lexer bug");
  });
});

describe("core titles the tools whose few words live in their own argument", () => {
  test("by text, title, subject, message or a patch's first file", () => {
    expect(toolLabel("suggestion_create", { title: "Review the plan", text: "…", agent_id: "a" })).toBe("suggestion_create · Review the plan");
    expect(toolLabel("message_propose", { account: "x", subject: "Lunch", text: "Hi" })).toBe("message_propose · Lunch");
    expect(toolLabel("memory_apply_patch", { patch: "*** Begin Patch\n*** Update File: people/ada.md\n@@" })).toBe("memory_apply_patch · people/ada.md");
    expect(toolLabel("mcp__loki__suggestion_create", { title: "Check ACP", text: "…" })).toBe("mcp__loki__suggestion_create · Check ACP");
    expect(line(tool("mcp__loki__script", ""))).toEqual(["A script", "Script", "code"]);
    expect(toolLabel("mcp__loki__ticket_propose", { title: "Fix login" })).toBe("mcp__loki__ticket_propose · Fix login");
    expect(toolLabel("mcp__loki__script", { code: "// @description: List unread\nreturn 1" })).toBe("mcp__loki__script");
    expect(stepLine({ role: "tool", text: "mcp__loki__script", tool: { name: "mcp__loki__script", description: "List unread" } }).title).toBe("List unread");
  });
});

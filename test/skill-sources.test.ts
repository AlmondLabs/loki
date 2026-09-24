import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backendName } from "../core/desk-core.ts";
import { memorySkills } from "../mod/agents.ts";
import { INSTALL_RE, SkillSources, compareTrees, parseSource, readLock, reconcilePrompt } from "../mod/skill-sources.ts";

/**
 * mod/skill-sources.ts: which of an agent's skills are its own and which came from elsewhere, and what
 * refresh does to the latter — replace an untouched copy, stage upstream for an edited one, or say it
 * is current. Real git repos in a temp dir; no network (the "github" kind is only parsed here).
 */

const AGENT = "agent-local-skills-test";
let root: string;
let backend: string;
let memory: string;
let global: string;
let checkout: string;
let sources: SkillSources;

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false", ...args], { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString();
const skill = (dir: string, name: string, body: string, extra: Record<string, string> = {}) => {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} does things\n---\n\n${body}\n`);
  for (const [p, text] of Object.entries(extra)) {
    mkdirSync(join(dir, name, p, ".."), { recursive: true });
    writeFileSync(join(dir, name, p), text);
  }
};

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "loki-skill-sources-"));
  backend = join(root, "backend");
  mkdirSync(join(backend, "agents"), { recursive: true });
  writeFileSync(join(backend, "agents", `${backendName(AGENT)}.json`), JSON.stringify({ id: AGENT, name: "tester" }));
  memory = join(backend, "memfs", AGENT, "memory");
  mkdirSync(join(memory, "skills"), { recursive: true });
  git(memory, "init", "-q", "-b", "main");

  // The team checkout, with two skills; the global folder links one of them.
  checkout = join(root, "team-skills");
  mkdirSync(checkout, { recursive: true });
  git(checkout, "init", "-q", "-b", "main");
  skill(checkout, "fmt-linked", "v1 of the linked skill", { "references/a.md": "ref a" });
  skill(checkout, "fmt-typed", "v1 of the typed skill");
  git(checkout, "add", "-A");
  git(checkout, "commit", "-q", "-m", "skills v1");
  global = join(root, "global");
  mkdirSync(global);
  // a junction on Windows (no privilege needed); the type is ignored elsewhere
  symlinkSync(join(checkout, "fmt-linked"), join(global, "fmt-linked"), "junction");
  skill(global, "copied-in", "a global copy from a lock file");

  // Memory: an installed copy (SKILL.md only, as Letta's old installer left them), an installed-then-edited
  // copy, a self-written skill, and one installed with no known source.
  skill(join(memory, "skills"), "fmt-linked", "v1 of the linked skill");
  git(memory, "add", "-A");
  git(memory, "commit", "-q", "-m", "Install skill: fmt-linked");
  skill(join(memory, "skills"), "fmt-typed", "v1 of the typed skill");
  git(memory, "add", "-A");
  git(memory, "commit", "-q", "-m", "chore(skills): install fmt-typed");
  writeFileSync(join(memory, "skills", "fmt-typed", "SKILL.md"), readFileSync(join(memory, "skills", "fmt-typed", "SKILL.md"), "utf8") + "\nWhat I learned: always check twice.\n");
  git(memory, "add", "-A");
  git(memory, "commit", "-q", "-m", "feat(reflection): extend fmt-typed with a lesson");
  skill(join(memory, "skills"), "my-own", "I wrote this myself");
  git(memory, "add", "-A");
  git(memory, "commit", "-q", "-m", "feat(reflection): create my-own skill");
  skill(join(memory, "skills"), "mystery", "installed from somewhere");
  git(memory, "add", "-A");
  git(memory, "commit", "-q", "-m", "Install skill: mystery");

  const lock = join(root, ".skill-lock.json");
  writeFileSync(lock, JSON.stringify({ version: 3, skills: [{ name: "copied-in", source: "someone/skills", sourceType: "github", sourceUrl: "https://github.com/someone/skills.git", skillPath: "skills/copied-in/SKILL.md" }] }));
  sources = new SkillSources({ backendDir: backend, globalDir: global, lockFile: lock, sourcesFile: join(root, "state", "skill-sources.json"), stagingDir: join(root, "state", "upstream") });
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("origin: self or other", () => {
  test("install commits make a skill other; the agent's own creation is self; edits after an install are noted", async () => {
    const info = await sources.annotate(AGENT, memorySkills(AGENT, backend));
    const by = Object.fromEntries(info.map((s) => [s.name, s]));
    expect(by["fmt-linked"].origin).toBe("other");
    expect(by["fmt-linked"].edited).toBe(false);
    expect(by["fmt-typed"].origin).toBe("other");
    expect(by["fmt-typed"].edited).toBe(true);
    expect(by["my-own"].origin).toBe("self");
    expect(by["my-own"].source).toBeNull();
    expect(by["mystery"].origin).toBe("other");
    expect(by["mystery"].source).toBeNull(); // nobody said where it came from
  });
  test("the source: a global symlink into a checkout; a lock-file entry for a copied folder; nothing otherwise", async () => {
    const info = await sources.annotate(AGENT, memorySkills(AGENT, backend));
    const linked = info.find((s) => s.name === "fmt-linked")!.source!;
    expect(linked.kind).toBe("checkout");
    if (linked.kind === "checkout") {
      expect(linked.repo).toBe(checkout);
      expect(linked.rel).toBe("fmt-linked");
    }
    expect(sources.sourceOf(AGENT, "copied-in")).toEqual({ kind: "github", url: "https://github.com/someone/skills.git", path: "skills/copied-in", ref: null, label: "someone/skills" });
    expect(sources.sourceOf(AGENT, "fmt-typed")).toBeNull();
  });
  test("the install pattern is Letta's two installers and our refresh", () => {
    expect(INSTALL_RE.test("Install skill: gog")).toBe(true);
    expect(INSTALL_RE.test("chore(skills): install stocks")).toBe(true);
    expect(INSTALL_RE.test("chore(skills): refresh fmt-x from team checkout")).toBe(true);
    expect(INSTALL_RE.test("feat: add skill loki-test")).toBe(false);
    expect(INSTALL_RE.test("fix(doctor): repair skill frontmatter")).toBe(false);
  });
});

describe("refresh", () => {
  test("nothing changed upstream: current", async () => {
    // Memory has SKILL.md only; the checkout has references/a.md too — so it is *not* current. Make an exact twin first.
    skill(join(memory, "skills"), "twin", "same everywhere");
    git(memory, "add", "-A");
    git(memory, "commit", "-q", "-m", "Install skill: twin");
    skill(checkout, "twin", "same everywhere");
    git(checkout, "add", "-A");
    git(checkout, "commit", "-q", "-m", "twin");
    const r = await sources.refresh(AGENT, "twin", join(checkout, "twin"));
    expect(r.outcome).toBe("current");
    expect(r.label).toBe("team-skills checkout");
  });
  test("an untouched copy is replaced and committed as the agent; the missing references/ arrive", async () => {
    const r = await sources.refresh(AGENT, "fmt-linked");
    expect(r.outcome).toBe("replaced");
    if (r.outcome !== "replaced") return;
    expect(r.changed).toEqual(["references/a.md"]);
    expect(existsSync(join(memory, "skills", "fmt-linked", "references", "a.md"))).toBe(true);
    expect(git(memory, "log", "-1", "--format=%an <%ae> %s")).toContain(`tester <${AGENT}@letta.com> chore(skills): refresh fmt-linked from team-skills checkout`);
    expect(git(memory, "status", "--short").trim()).toBe("");
    // And now it is current, still other, still unedited.
    expect((await sources.refresh(AGENT, "fmt-linked")).outcome).toBe("current");
    const info = await sources.annotate(AGENT, memorySkills(AGENT, backend));
    expect(info.find((s) => s.name === "fmt-linked")).toMatchObject({ origin: "other", edited: false });
  }, 20_000); // several git invocations; a busy machine took this past bun's 5 s default once
  test("an edited copy is not overwritten: upstream is staged and the agent is asked to reconcile", async () => {
    // Upstream moves on.
    writeFileSync(join(checkout, "fmt-typed", "SKILL.md"), readFileSync(join(checkout, "fmt-typed", "SKILL.md"), "utf8").replace("v1", "v2"));
    git(checkout, "add", "-A");
    git(checkout, "commit", "-q", "-m", "fmt-typed v2");
    // The source is typed once (a folder inside the checkout) and remembered.
    const r = await sources.refresh(AGENT, "fmt-typed", join(checkout, "fmt-typed"));
    expect(r.outcome).toBe("reconcile");
    if (r.outcome !== "reconcile") return;
    expect(r.changed).toEqual(["SKILL.md"]);
    expect(r.upstreamPath).toBe(join(root, "state", "upstream", AGENT, "fmt-typed"));
    expect(readFileSync(join(r.upstreamPath, "SKILL.md"), "utf8")).toContain("v2");
    expect(readFileSync(join(memory, "skills", "fmt-typed", "SKILL.md"), "utf8")).toContain("always check twice"); // untouched
    expect(r.prompt).toBe(reconcilePrompt("fmt-typed", "team-skills checkout", r.upstreamPath, ["SKILL.md"]));
    expect(r.prompt).toContain("keep what you learned");
    expect(JSON.parse(readFileSync(join(root, "state", "skill-sources.json"), "utf8"))).toMatchObject({ [`${AGENT}/fmt-typed`]: join(checkout, "fmt-typed") });
    expect(sources.sourceOf(AGENT, "fmt-typed")?.kind).toBe("checkout");
  });
  test("no source and none given: a clear error; a bad name or a skill not in memory too", async () => {
    await expect(sources.refresh(AGENT, "mystery")).rejects.toThrow(/no known source for mystery/);
    await expect(sources.refresh(AGENT, "../etc")).rejects.toThrow(/not a skill name/);
    await expect(sources.refresh(AGENT, "nope")).rejects.toThrow(/not in this agent's memory/);
    await expect(sources.refresh(AGENT, "mystery", "not a source at all!")).rejects.toThrow(/a source is/);
  });
});

describe("sources and trees", () => {
  test("parseSource: GitHub URLs with a tree path, owner/repo/path shorthand, folders; junk is null", () => {
    expect(parseSource("https://github.com/anthropics/skills/tree/main/skills/pptx")).toEqual({ kind: "github", url: "https://github.com/anthropics/skills.git", path: "skills/pptx", ref: "main", label: "anthropics/skills/skills/pptx" });
    expect(parseSource("https://github.com/anthropics/skills")).toEqual({ kind: "github", url: "https://github.com/anthropics/skills.git", path: ".", ref: null, label: "anthropics/skills" });
    expect(parseSource("mattpocock/skills/skills/productivity/grill-me")).toMatchObject({ kind: "github", path: "skills/productivity/grill-me" });
    expect(parseSource(join(checkout, "fmt-linked"))).toMatchObject({ kind: "checkout", rel: "fmt-linked" });
    expect(parseSource(join(global, "copied-in"))).toMatchObject({ kind: "folder" });
    expect(parseSource("")).toBeNull();
    expect(parseSource("two words")).toBeNull();
    expect(parseSource("/definitely/not/here")).toBeNull();
    expect(parseSource("example.com/x")).toBeNull(); // a host, not owner/repo
  });
  test("readLock reads the CLI's object-by-name form and an array form, keeping well-formed entries only", () => {
    const f = join(root, "lock2.json");
    writeFileSync(f, JSON.stringify({ skills: [{ name: "ok", source: "a/b", sourceUrl: "https://github.com/a/b.git", skillPath: "skills/ok/SKILL.md" }, { name: 3 }, "x"] }));
    expect(readLock(f).map((e) => e.name)).toEqual(["ok"]);
    // What the `skills` CLI actually writes (version 3): keyed by name.
    writeFileSync(f, JSON.stringify({ version: 3, skills: { pptx: { source: "anthropics/skills", sourceType: "github", sourceUrl: "https://github.com/anthropics/skills.git", skillPath: "skills/pptx/SKILL.md" }, broken: { source: "x" }, junk: 4 } }));
    expect(readLock(f)).toEqual([{ name: "pptx", source: "anthropics/skills", sourceType: "github", sourceUrl: "https://github.com/anthropics/skills.git", skillPath: "skills/pptx/SKILL.md" } as never]);
    expect(readLock(join(root, "missing.json"))).toEqual([]);
  });
  test("compareTrees lists added, removed and changed files, ignoring .git and .DS_Store", () => {
    const a = join(root, "cmp-a");
    const b = join(root, "cmp-b");
    mkdirSync(join(a, "sub"), { recursive: true });
    mkdirSync(join(b, ".git"), { recursive: true });
    writeFileSync(join(a, "same.md"), "s");
    writeFileSync(join(b, "same.md"), "s");
    writeFileSync(join(a, "changed.md"), "1");
    writeFileSync(join(b, "changed.md"), "2");
    writeFileSync(join(a, "sub", "only-a.md"), "a");
    writeFileSync(join(b, "only-b.md"), "b");
    writeFileSync(join(b, ".DS_Store"), "junk");
    writeFileSync(join(b, ".git", "HEAD"), "ref");
    expect(compareTrees(a, b)).toEqual(["changed.md", "only-b.md", "sub/only-a.md"]);
    expect(compareTrees(a, a)).toEqual([]);
  });
});

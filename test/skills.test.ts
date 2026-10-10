import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installSkill, listGlobalSkills, skillDescription, skillOrigin, validSkillSource } from "../mod/skills.ts";

describe("global skills", () => {
  test("lists folders and links that hold a SKILL.md, with a description", () => {
    const root = mkdtempSync(join(tmpdir(), "loki-skills-"));
    const dir = join(root, "skills");
    mkdirSync(join(dir, "plain"), { recursive: true });
    writeFileSync(join(dir, "plain", "SKILL.md"), "---\nname: plain\ndescription: \"Does a thing\"\n---\n# plain\n");
    mkdirSync(join(root, "elsewhere", "linked"), { recursive: true });
    writeFileSync(join(root, "elsewhere", "linked", "SKILL.md"), "# Linked skill\ntext\n");
    // a junction on Windows (no privilege needed); the type is ignored elsewhere
    symlinkSync(join(root, "elsewhere", "linked"), join(dir, "linked"), "junction");
    mkdirSync(join(dir, "empty"));
    writeFileSync(join(dir, ".DS_Store"), "");
    const skills = listGlobalSkills(dir);
    expect(skills.map((s) => s.name)).toEqual(["linked", "plain"]);
    expect(skills[0]).toMatchObject({ isLink: true, path: join(root, "elsewhere", "linked"), description: "Linked skill" });
    expect(skills[1]).toMatchObject({ isLink: false, description: "Does a thing" });
  });
  test("missing dir is an empty list", () => {
    expect(listGlobalSkills("/definitely/not/here")).toEqual([]);
  });
  test("skillDescription prefers frontmatter", () => {
    expect(skillDescription("---\ndescription: from fm\n---\n# heading")).toBe("from fm");
    expect(skillDescription("# heading only")).toBe("heading only");
    expect(skillDescription("no structure")).toBeNull();
  });
});

describe("skill install", () => {
  test("a source names a folder here, a GitHub path or URL (at a branch, down to a folder), or any git URL", () => {
    expect(skillOrigin("owner/repo/skills/pdf")).toEqual({ kind: "git", url: "https://github.com/owner/repo.git", ref: null, path: "skills/pdf" });
    expect(skillOrigin("owner/repo")).toEqual({ kind: "git", url: "https://github.com/owner/repo.git", ref: null, path: "" });
    expect(skillOrigin("https://github.com/owner/repo/tree/main/skills/pdf")).toEqual({ kind: "git", url: "https://github.com/owner/repo.git", ref: "main", path: "skills/pdf" });
    expect(skillOrigin("https://github.com/owner/repo/blob/v2/skills/pdf/SKILL.md")).toMatchObject({ ref: "v2", path: "skills/pdf" });
    expect(skillOrigin("git@example.com:team/skills.git")).toEqual({ kind: "git", url: "git@example.com:team/skills.git", ref: null, path: "" });
    expect(skillOrigin("~/skills/mine", "/home/x")).toEqual({ kind: "folder", path: "/home/x/skills/mine" });
    expect(() => skillOrigin("justaname")).toThrow("GitHub path");
  });

  test("rejects bad sources before running anything", async () => {
    expect(validSkillSource("")).toMatch(/required/);
    expect(validSkillSource("a b")).toMatch(/spaces/);
    expect(validSkillSource("--force")).toMatch(/cannot start/);
    let ran = false;
    await expect(installSkill("", "a1", { run: async () => ((ran = true), "") })).rejects.toThrow(/required/);
    expect(ran).toBe(false);
  });

  test("a folder's skill lands in the agent's memory as skills/<name>, committed; again only with force", async () => {
    const root = mkdtempSync(join(tmpdir(), "loki-install-"));
    const memory = join(root, "memory");
    mkdirSync(memory);
    execFileSync("git", ["init", "--quiet"], { cwd: memory });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "--allow-empty", "-m", "Begin memory"], { cwd: memory });
    const skill = join(root, "pdf");
    mkdirSync(join(skill, "scripts"), { recursive: true });
    writeFileSync(join(skill, "SKILL.md"), "---\ndescription: PDFs\n---\n");
    writeFileSync(join(skill, "scripts", "split.py"), "print(1)\n");
    const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
    const run = (program: string, args: string[], cwd?: string) => Promise.resolve(execFileSync(program, args, { cwd, env, encoding: "utf8" }));
    expect(await installSkill(skill, "a1", { run, memory })).toBe(`installed pdf from ${skill}`);
    expect(readFileSync(join(memory, "skills", "pdf", "scripts", "split.py"), "utf8")).toBe("print(1)\n");
    expect(execFileSync("git", ["log", "--format=%s", "-1"], { cwd: memory, encoding: "utf8" }).trim()).toBe("Install skill: pdf");
    await expect(installSkill(skill, "a1", { run, memory })).rejects.toThrow("already has a skill named pdf");
    expect(await installSkill(skill, "a1", { run, memory, force: true })).toBe(`pdf is already installed as it is at ${skill}`);
    writeFileSync(join(skill, "SKILL.md"), "---\ndescription: PDFs, better\n---\n");
    expect(await installSkill(skill, "a1", { run, memory, force: true })).toBe(`installed pdf from ${skill}`);
    await expect(installSkill(root, "a1", { run, memory })).rejects.toThrow("no SKILL.md");
  });
});

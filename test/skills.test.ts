import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installArgs, installSkill, listGlobalSkills, skillDescription, validSkillSource } from "../mod/skills.ts";

describe("global skills", () => {
  test("lists folders and links that hold a SKILL.md, with a description", () => {
    const root = mkdtempSync(join(tmpdir(), "loki-skills-"));
    const dir = join(root, "skills");
    mkdirSync(join(dir, "plain"), { recursive: true });
    writeFileSync(join(dir, "plain", "SKILL.md"), "---\nname: plain\ndescription: \"Does a thing\"\n---\n# plain\n");
    mkdirSync(join(root, "elsewhere", "linked"), { recursive: true });
    writeFileSync(join(root, "elsewhere", "linked", "SKILL.md"), "# Linked skill\ntext\n");
    symlinkSync(join(root, "elsewhere", "linked"), join(dir, "linked"));
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
  test("argument shape", () => {
    expect(installArgs("owner/repo/path", "a1")).toEqual(["install", "owner/repo/path", "--agent", "a1"]);
    expect(installArgs(" official/finance/stocks ", "a1", { force: true })).toEqual(["install", "official/finance/stocks", "--agent", "a1", "--force"]);
  });
  test("rejects bad sources before running anything", async () => {
    expect(validSkillSource("")).toMatch(/required/);
    expect(validSkillSource("a b")).toMatch(/spaces/);
    expect(validSkillSource("--force")).toMatch(/cannot start/);
    let ran = false;
    await expect(installSkill("", "a1", { run: async () => ((ran = true), "") })).rejects.toThrow(/required/);
    expect(ran).toBe(false);
  });
  test("runs through the injected runner", async () => {
    const seen: string[][] = [];
    const out = await installSkill("clawhub/x", "a1", { run: async (args) => (seen.push(args), "installed") });
    expect(out).toBe("installed");
    expect(seen).toEqual([["install", "clawhub/x", "--agent", "a1"]]);
  });
});

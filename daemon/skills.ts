import { defineExtension, defineTool, section, type Extension } from "@earendil-works/pi-durable";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { listGlobalSkills, skillDescription } from "../mod/skills.ts";
import { AgentInfoDoc } from "./kernel/index.ts";
import { memoryRoot } from "./memory.ts";

/**
 * Skills and project instructions on loki's daemon (plan 017, U10, KTD19). The agent's prompt lists every skill it
 * has, its own (in its memory, `skills/<name>/SKILL.md`) and the global ones (mod/skills.ts), by name and description;
 * the Skill tool hands it a skill's whole text when it needs it, as Letta's did (`<skill_content>`). The chat's folder
 * brings its AGENTS.md (or CLAUDE.md) as a section of its own.
 */

type Skill = { name: string; description: string | null; file: string };

/** An agent's skills, its own before the global ones of the same name. */
export function skillsOf(backendDir: string, agentId: string | undefined, globalDir?: string): Skill[] {
  const out = new Map<string, Skill>();
  if (agentId) {
    const dir = join(memoryRoot(backendDir, agentId), "skills");
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      // no skills of its own
    }
    for (const name of names.sort()) {
      const file = join(dir, name, "SKILL.md");
      if (!existsSync(file)) continue;
      out.set(name, { name, description: skillDescription(readFileSync(file, "utf8")), file });
    }
  }
  for (const g of listGlobalSkills(globalDir)) if (!out.has(g.name)) out.set(g.name, { name: g.name, description: g.description, file: join(g.path, "SKILL.md") });
  return [...out.values()];
}

const PROJECT_FILES = ["AGENTS.md", "CLAUDE.md"];
const PROJECT_LIMIT = 32 * 1024;

export function skillsExtension(backendDir: string, globalDir?: string): Extension {
  return defineExtension({
    name: "loki.skills",
    sections: [
      section("skills", async (input, context) => {
        const agent = await input.read.snapshot(AgentInfoDoc, context);
        const skills = skillsOf(backendDir, agent?.id, globalDir);
        if (!skills.length) return undefined;
        return `Skills you have. Before doing the kind of work one describes, load its instructions with the Skill tool.\n${skills.map((s) => `- ${s.name}${s.description ? `: ${s.description}` : ""}`).join("\n")}`;
      }),
      section("project", (input) => {
        const cwd = input.agent.cwd;
        if (!cwd) return undefined;
        for (const name of PROJECT_FILES) {
          const file = join(cwd, name);
          if (existsSync(file)) return `Instructions for work in ${cwd}, from its ${name}:\n\n${readFileSync(file, "utf8").slice(0, PROJECT_LIMIT).trimEnd()}`;
        }
        return undefined;
      }),
    ],
    tools: [
      defineTool({
        name: "Skill",
        description: "Load a skill's full instructions by its name, from the skills listed in your prompt.",
        parameters: { type: "object", properties: { skill: { type: "string" } }, required: ["skill"] } as never,
        execute: async (args, api, context) => {
          const name = (args as { skill: string }).skill;
          const agent = await api.snapshot(AgentInfoDoc, context);
          const skill = skillsOf(backendDir, agent?.id, globalDir).find((s) => s.name === name);
          if (!skill) throw new Error(`no skill named ${name}`);
          return { content: [{ type: "text", text: `<skill_content name="${name}">\n${readFileSync(skill.file, "utf8")}\n</skill_content>` }] };
        },
      }),
    ],
  });
}

import { defineExtension, section, type Extension } from "@earendil-works/pi-durable";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { briefDescription, globalSkillsDir, listGlobalSkills, skillDescription } from "../mod/skills.ts";
import { AgentInfoDoc } from "./kernel/index.ts";
import { memoryRoot } from "./memory.ts";
import { sections } from "./section-cache.ts";

/**
 * Skills and project instructions on loki's daemon (plan 017, U10, KTD19). The agent's prompt lists every skill it
 * has, its own (in its memory, `skills/<name>/SKILL.md`) and the global ones (mod/skills.ts), by name and description,
 * and says which folder each group is in; the agent reads a skill's whole text with `read` when it needs it (plan 094).
 * The chat's folder brings its AGENTS.md (or CLAUDE.md) as a section of its own.
 */

interface Skill {
  name: string;
  description: string | null;
  file: string;
  /** Whether it is the agent's own, in its memory, rather than a global one. */
  own: boolean;
}

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
      out.set(name, { name, description: skillDescription(readFileSync(file, "utf8")), file, own: true });
    }
  }
  for (const g of listGlobalSkills(globalDir))
    if (!out.has(g.name)) out.set(g.name, { name: g.name, description: g.description, file: join(g.path, "SKILL.md"), own: false });
  return [...out.values()];
}

const PROJECT_FILES = ["AGENTS.md", "CLAUDE.md"];
const PROJECT_LIMIT = 32 * 1024;

/**
 * The skills section's text: each group of skills under the folder it is in, so a skill's file is named once per
 * folder rather than once per skill (plan 094, KTD4). Undefined when the agent has none.
 */
function skillsText(skills: readonly Skill[], ownDir: string, globalDir: string): string | undefined {
  if (!skills.length) return undefined;
  const line = (s: Skill) => `- ${s.name}${s.description ? `: ${briefDescription(s.description)}` : ""}`;
  const group = (own: boolean, dir: string, title: string) => {
    const mine = skills.filter((s) => s.own === own);
    return mine.length ? `${title}, each at ${join(dir, "<name>", "SKILL.md")}:\n${mine.map(line).join("\n")}` : null;
  };
  return [
    "Skills you have. Before doing the kind of work one describes, read its SKILL.md with `read`.",
    group(true, ownDir, "Your own"),
    group(false, globalDir, "Global"),
  ]
    .filter(Boolean)
    .join("\n");
}

/** The `skills` and `project` sections, as an extension over the agents in `backendDir`; `globalDir` stands in for the global skills folder (tests). A project file is cut to its first PROJECT_LIMIT characters. */
export function skillsExtension(backendDir: string, globalDir?: string): Extension {
  return defineExtension({
    name: "loki.skills",
    sections: [
      section("skills", async (input, context) => {
        const agent = await input.read.snapshot(AgentInfoDoc, context);
        const id = agent?.id ?? "";
        return sections.get(`skills\u0000${backendDir}\u0000${id}\u0000${globalDir ?? ""}`, () =>
          skillsText(skillsOf(backendDir, agent?.id, globalDir), join(memoryRoot(backendDir, id), "skills"), globalDir ?? globalSkillsDir()),
        );
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
  });
}

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backendName } from "../core/desk-core.ts";
import { isAgentId, isSubagent, memoryRoot, memorySkills, memoryTree, parseGitLog, profilePath, readLocalAgent, readMemoryFile } from "../mod/agents.ts";

const AGENT = "agent-local-test-1234";
let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "loki-agents-"));
  mkdirSync(join(dir, "agents"), { recursive: true });
  writeFileSync(
    join(dir, "agents", `${backendName(AGENT)}.json`),
    JSON.stringify({ id: AGENT, name: " ira ", description: "The memory-first agent", model: "anthropic/claude-fable-5", model_settings: { provider_type: "anthropic", effort: "high" }, tags: ["favorite:user:local", "origin:letta-code"], system: "You are a Letta Code agent.\nMore." }),
  );
  const mem = join(dir, "memfs", AGENT, "memory");
  mkdirSync(join(mem, "system"), { recursive: true });
  mkdirSync(join(mem, "reference", "life"), { recursive: true });
  mkdirSync(join(mem, "skills", "show-me"), { recursive: true });
  mkdirSync(join(mem, ".git", "objects"), { recursive: true });
  writeFileSync(join(mem, "system", "persona.md"), "# persona\nI am ira.");
  writeFileSync(join(mem, "system", "human.md"), "# human\nDeepak.");
  writeFileSync(join(mem, "reference", "life", "notes.md"), "notes");
  writeFileSync(join(mem, "skills", "show-me", "SKILL.md"), '---\nname: show-me\ndescription: "Put it on the desk"\n---\n# show-me\n');
  writeFileSync(join(mem, ".git", "HEAD"), "ref: refs/heads/main");
  writeFileSync(join(mem, "profile.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("agents: the record", () => {
  test("reads name, description, model, settings, tags, favourite, system head", () => {
    const a = readLocalAgent(AGENT, dir)!;
    expect(a.name).toBe("ira");
    expect(a.description).toBe("The memory-first agent");
    expect(a.model).toBe("anthropic/claude-fable-5");
    expect(a.modelSettings.effort).toBe("high");
    expect(a.favourite).toBe(true);
    expect(a.systemHead).toBe("You are a Letta Code agent.");
  });
  test("agent ids are path segments: traversal shapes are refused everywhere", () => {
    expect(isAgentId("default-agent-local-45b66c51-fe5b-44e8-b36c-696adc14ee28")).toBe(true);
    expect(isAgentId("agent_1.v2")).toBe(true);
    for (const bad of ["../../etc", "..", "a/b", ".hidden", "", "a b", 42, null, "x".repeat(201)]) expect(isAgentId(bad)).toBe(false);
    expect(readLocalAgent("../" + AGENT, dir)).toBeNull();
    expect(profilePath("../../" + AGENT, dir)).toBeNull();
    expect(() => memoryRoot("../x", dir)).toThrow("invalid agent id");
    expect(() => memoryTree("../x", dir)).toThrow("invalid agent id");
  });

  test("a role:subagent record is Letta's helper, not the user's agent", () => {
    const helper = "agent-local-helper-0001";
    writeFileSync(join(dir, "agents", `${backendName(helper)}.json`), JSON.stringify({ id: helper, name: "Letta Code", tags: ["origin:letta-code", "role:subagent", "type:general-purpose", `parent:${AGENT}`] }));
    expect(isSubagent(helper, dir)).toBe(true);
    expect(isSubagent(AGENT, dir)).toBe(false);
    expect(isSubagent("agent-local-nobody", dir)).toBe(false);
  });

  test("unknown agent is null", () => {
    expect(readLocalAgent("agent-local-nope", dir)).toBeNull();
  });
});

describe("agents: memory", () => {
  test("tree skips .git, orders system → reference → skills → rest", () => {
    const paths = memoryTree(AGENT, dir).map((f) => f.path);
    expect(paths).toEqual(["system/human.md", "system/persona.md", "reference/life/notes.md", "skills/show-me/SKILL.md", "profile.png"]);
  });
  test("skills come with their frontmatter description", () => {
    expect(memorySkills(AGENT, dir)).toEqual([{ name: "show-me", path: "skills/show-me/SKILL.md", description: "Put it on the desk" }]);
  });
  test("reads a file, refuses escapes and binaries", () => {
    expect(readMemoryFile(AGENT, "system/persona.md", dir)).toBe("# persona\nI am ira.");
    expect(readMemoryFile(AGENT, "../../agents/x.json", dir)).toBeNull();
    expect(readMemoryFile(AGENT, "/etc/passwd", dir)).toBeNull();
    expect(readMemoryFile(AGENT, "profile.png", dir)).toBeNull();
    expect(readMemoryFile(AGENT, "system", dir)).toBeNull();
  });
  test("profile image path", () => {
    expect(profilePath(AGENT, dir)).toEndWith("profile.png");
    expect(profilePath("agent-local-nope", dir)).toBeNull();
  });
  test("git log parsing keeps message, time and touched files", () => {
    const out = "\x1eabc123\x1fmemory: learned a thing\x1f2026-09-06T10:00:00+05:30\nsystem/human.md\nreference/life/notes.md\n\x1edef456\x1ffix: typo\x1f2026-09-05T09:00:00+05:30\nsystem/persona.md\n";
    const log = parseGitLog(out);
    expect(log).toHaveLength(2);
    expect(log[0]).toEqual({ sha: "abc123", message: "memory: learned a thing", at: "2026-09-06T10:00:00+05:30", files: ["system/human.md", "reference/life/notes.md"] });
    expect(log[1].files).toEqual(["system/persona.md"]);
  });
});

describe("agents: permission modes", () => {
  test("reads the persisted map; missing means the default (unrestricted); main chats key by agent", async () => {
    const { permissionModeKey, permissionModeOf, readPermissionModes } = await import("../mod/agents.ts");
    const f = join(dir, "remote-settings.json");
    writeFileSync(f, JSON.stringify({ permissionModeMap: { "conversation:c1": { mode: "standard" }, "agent:a1::conversation:default": { mode: "acceptEdits" }, "conversation:bad": { mode: "bypassPermissions" } } }));
    expect(readPermissionModes(f)).toEqual({ "conversation:c1": "standard", "agent:a1::conversation:default": "acceptEdits" });
    expect(permissionModeOf("a1", "c1", f)).toBe("standard");
    expect(permissionModeOf("a1", "default", f)).toBe("acceptEdits");
    expect(permissionModeOf("a1", "c-unknown", f)).toBe("unrestricted");
    expect(permissionModeKey(null, "default")).toBe("agent:__unknown__::conversation:default");
    expect(readPermissionModes(join(dir, "nope.json"))).toEqual({});
  });
});

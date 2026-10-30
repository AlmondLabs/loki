import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { readAcpAgents, type AcpAgentConfig } from "../daemon/acp/agents.ts";
import { AcpCatalog } from "../daemon/acp/catalog.ts";

const FAKE: AcpAgentConfig = { id: "fake", name: "Fake", command: process.execPath, args: [] };
const MISSING: AcpAgentConfig = { id: "gone", name: "Gone", command: "loki-no-such-command", args: [] };

/** A catalog over its own folder, its agents read from the agents file as the daemon reads them. */
function catalog(agents: AcpAgentConfig[] = [FAKE]) {
  const dir = mkdtempSync(join(tmpdir(), "loki-catalog-"));
  const configFile = join(dir, "acp.json");
  const cacheFile = join(dir, "acp-offered.json");
  let list = agents;
  const make = () => new AcpCatalog({ agents: () => list, configFile, cacheFile });
  return { dir, configFile, cacheFile, make, set: (next: AcpAgentConfig[]) => (list = next), done: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("the ACP agents loki knows (plan 060)", () => {
  test("what a session offered is kept across a restart, and the picker lists it with the agent's default featured", () => {
    const c = catalog();
    try {
      c.make().offer("fake", {
        models: [{ value: "sonnet", name: "Sonnet", description: null }],
        modes: [],
        commands: [],
        efforts: { sonnet: ["low", "high", "default"] },
      });
      const again = c.make(); // a new daemon reads the cache
      expect(again.offeredBy("fake")?.models.map((m) => m.value)).toEqual(["sonnet"]);
      expect(again.models().map((m) => [m.id, m.is_featured ?? false])).toEqual([
        ["acp:fake/default", true],
        ["acp:fake/sonnet@low", false],
        ["acp:fake/sonnet@high", false],
      ]);
    } finally {
      c.done();
    }
  });

  test("an agent that is not installed and never ran is no quick pick, and Settings says why", () => {
    const c = catalog([FAKE, MISSING]);
    try {
      const cat = c.make();
      expect(cat.models().some((m) => m.id.startsWith("acp:gone/"))).toBe(false);
      expect(cat.engines().engines.find((e) => e.id === "gone")).toMatchObject({ status: "not_found" });
    } finally {
      c.done();
    }
  });

  test("a sign-in failure reads as signed out; changing the agent forgets how it went", () => {
    const c = catalog();
    try {
      const cat = c.make();
      cat.went("fake", { status: "failed", detail: "Authentication required" });
      expect(cat.engines().engines[0]).toMatchObject({ status: "signed_out", detail: "sign in to Fake, then send again" });
      cat.set({ ...FAKE, args: ["--fast"] });
      expect(readAcpAgents(c.configFile).find((a) => a.id === "fake")?.args).toEqual(["--fast"]);
      expect(cat.healthOf("fake")).toBeUndefined();
    } finally {
      c.done();
    }
  });

  test("an offer that changes nothing writes nothing", () => {
    const c = catalog();
    try {
      const cat = c.make();
      const offer = { models: [], modes: [], commands: [{ name: "plan", description: "plan first", hint: null }] };
      cat.offer("fake", offer);
      const written = readFileSync(c.cacheFile, "utf8");
      rmSync(c.cacheFile);
      cat.offer("fake", { ...offer });
      expect(() => readFileSync(c.cacheFile, "utf8")).toThrow();
      expect(JSON.parse(written)).toEqual({ fake: offer });
    } finally {
      c.done();
    }
  });
});

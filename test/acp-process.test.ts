import { describe, expect, test } from "vitest";
import { join } from "node:path";
import { AcpProcess } from "../daemon/acp/process.ts";
import type { AcpAgentConfig } from "../daemon/acp/agents.ts";

const FAKE: AcpAgentConfig = { id: "fake", name: "Fake", command: process.execPath, args: [join(import.meta.dirname, "fixtures", "fake-acp.mjs")] };

const handlers = {
  update: () => {},
  permission: () => Promise.reject(new Error("not asked")),
  elicit: () => Promise.reject(new Error("not asked")),
};

describe("an ACP agent's process", () => {
  test("a process made anew (the agent edited in Settings) never starts at an epoch an old one had", async () => {
    const before = new AcpProcess(FAKE, handlers);
    const after = new AcpProcess(FAKE, handlers);
    try {
      await before.capabilities();
      await after.capabilities();
      // A session opened on the first process must not pass for one on the second.
      expect(after.epoch()).not.toBe(before.epoch());
    } finally {
      await before.close();
      await after.close();
    }
  });
});

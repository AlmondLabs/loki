import { describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AcpProcess } from "../daemon/acp/process.ts";
import { commandPath, type AcpAgentConfig } from "../daemon/acp/agents.ts";

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
      expect(after.epoch()).not.toBe(before.epoch());
    } finally {
      await before.close();
      await after.close();
    }
  });

  test("each process has its own epoch from the moment it is made, before it has started", () => {
    expect(new AcpProcess(FAKE, handlers).epoch()).not.toBe(new AcpProcess(FAKE, handlers).epoch());
  });

  test("closing a process and starting it again each give it an epoch it never had", async () => {
    const proc = new AcpProcess(FAKE, handlers);
    try {
      const made = proc.epoch();
      await proc.capabilities();
      const started = proc.epoch();
      await proc.close();
      const closed = proc.epoch();
      await proc.capabilities();
      const again = proc.epoch();
      expect(new Set([made, started, closed, again]).size).toBe(4);
    } finally {
      await proc.close();
    }
  });

  test("an agent that never answers initialize is stopped by close, and gives up after its start time", async () => {
    const silent: AcpAgentConfig = { id: "silent", name: "Silent", command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"] };
    const closed = new AcpProcess(silent, handlers);
    const starting = closed.capabilities();
    await closed.close();
    await expect(starting).rejects.toThrow();
    const slow = new AcpProcess(silent, handlers, 200);
    await expect(slow.capabilities()).rejects.toThrow(/did not start within/);
    await slow.close();
  });

  test.runIf(process.platform === "win32")("on Windows a command is found as the shim Windows runs, not npm's extensionless script", () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-path-"));
    try {
      writeFileSync(join(dir, "npx"), "#!/bin/sh\n");
      writeFileSync(join(dir, "npx.cmd"), "@echo off\r\n");
      expect(commandPath("npx", { PATH: dir, PATHEXT: ".EXE;.CMD" })).toBe(join(dir, "npx.cmd"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

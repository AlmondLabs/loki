import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeRecord } from "../daemon/store/agents.ts";
import { missingFor } from "../mod/requirements.ts";

const dirs: string[] = [];
afterEach(() => {
  delete process.env.LOKI_BACKEND_DIR;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A backend with Friday on an OpenAI model, and a Mac whose providers and MCP servers are as given. */
function mac(opts: { signedIn: boolean; mcp?: Array<{ name: string; state: "connected" | "signin" | "down"; error?: string; off_for?: string[] }> }) {
  const dir = mkdtempSync(join(tmpdir(), "loki-requirements-"));
  dirs.push(dir);
  process.env.LOKI_BACKEND_DIR = dir;
  writeRecord(dir, "agent-friday", { id: "agent-friday", name: "Friday", model: "openai/gpt-6.1-sol" });
  return {
    providers: () =>
      Promise.resolve([
        {
          id: "openai",
          display_name: "OpenAI",
          provider_type: "openai",
          provider_name: "openai",
          requires_api_key: true,
          connected: { is_connected: opts.signedIn },
        },
      ]),
    mcp: () =>
      Promise.resolve({
        servers: (opts.mcp ?? []).map((s) => ({ ...s, error: s.error ?? null, off_for: s.off_for ?? [] })),
        problems: [],
        config_path: "",
      }),
  };
}

describe("what a Mac lacks for an agent's chat", () => {
  test("no sign-in there for the agent's model provider is named (AE5)", async () => {
    expect(await missingFor(mac({ signedIn: false }) as never, "agent-friday")).toEqual(["a sign-in for OpenAI: Settings › Providers"]);
    expect(await missingFor(mac({ signedIn: true }) as never, "agent-friday")).toEqual([]);
  });

  test("an MCP server needing a sign-in, or down, is named; one switched off for the agent is not", async () => {
    const m = mac({
      signedIn: true,
      mcp: [
        { name: "notion", state: "signin" },
        { name: "fs", state: "down", error: "fs-mcp not found" },
        { name: "outline", state: "down", off_for: ["agent-friday"] },
        { name: "ok", state: "connected" },
      ],
    });
    expect(await missingFor(m as never, "agent-friday")).toEqual([
      "a sign-in for the MCP server notion: Settings › MCP",
      "the MCP server fs, which is not running: fs-mcp not found",
    ]);
  });
});

import { describe, expect, test } from "bun:test";
import { shouldServe } from "../mod/gate.ts";

describe("which harness serves the desk", () => {
  const listener = { tools: true, commands: true, events: { lifecycle: false, tools: true, turns: true } }; // letta server, Desktop, the gateway
  const tui = { tools: true, commands: true, events: { lifecycle: true, tools: true, turns: true } }; // an interactive terminal session
  const headless = { tools: true, commands: false, events: { lifecycle: true, tools: true, turns: true } }; // letta -p

  test("the listener that hosts the app-server serves; sessions stand down", () => {
    expect(shouldServe(listener, {}).serve).toBe(true);
    expect(shouldServe(tui, {}).serve).toBe(false);
    expect(shouldServe(headless, {}).serve).toBe(false);
    expect(shouldServe(tui, {}).reason).toContain("session");
  });

  test("odd shapes serve: a boolean events flag, no capabilities at all", () => {
    expect(shouldServe({ events: true }, {}).serve).toBe(true);
    expect(shouldServe(undefined, {}).serve).toBe(true);
  });

  test("LOKI_MOD_SERVE overrides both ways", () => {
    expect(shouldServe(tui, { LOKI_MOD_SERVE: "1" }).serve).toBe(true);
    expect(shouldServe(listener, { LOKI_MOD_SERVE: "0" }).serve).toBe(false);
  });
});

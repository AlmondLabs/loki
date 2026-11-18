import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LAN_STATE, SEED, pairLink, parseArgs, previewEnv, pushWaiter } from "../scripts/phone-preview.ts";

const fixture = readFileSync(join(import.meta.dirname, "fixtures", "fake-acp.mjs"), "utf8");
const FIXTURE_WORDS = [...fixture.matchAll(/\.includes\("([^"]+)"\)/g)].map((m) => m[1]);

describe("the phone preview's daemon (plan 2026-11-18-2327, U1)", () => {
  const scratch = join("/tmp", "loki-phone-preview-x");
  const env = previewEnv(
    {
      PATH: "/usr/bin",
      HOME: "/Users/someone",
      ANTHROPIC_API_KEY: "k",
      OPENAI_API_KEY: "k",
      AWS_SECRET_ACCESS_KEY: "k",
      GITHUB_TOKEN: "t",
      LOKI_PINS_FILE: "/Users/someone/.loki/pins.json",
      LOKI_STATE_DIR: "/Users/someone/.loki/state",
    },
    scratch,
    { port: 50100, lanPort: 50101 },
  );

  test("runs on the scratch folder, its own ports, no keychain, and rebuilds the page on an app edit", () => {
    expect(env.HOME).toBe(scratch);
    expect(env.USERPROFILE).toBe(scratch);
    expect(env.LOKI_DIR).toBe(join(scratch, ".loki"));
    expect(env.LOKI_SKILLS_DIR).toBe(join(scratch, "skills"));
    expect(env.LOKI_KEYCHAIN).toBe("0");
    expect(env.LOKI_ANALYTICS).toBe("0");
    expect(env.LOKI_BUILT_PAGE).toBe("1");
    expect(env.LOKI_PORT).toBe("50100");
    expect(env.LOKI_LAN_PORT).toBe("50101");
    expect(env.PATH).toBe("/usr/bin");
    expect(Object.values(env).join("\n")).not.toContain("/Users/someone");
  });

  test("never hands the daemon a provider credential, so nothing reaches a real model", () => {
    for (const name of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "AWS_SECRET_ACCESS_KEY", "GITHUB_TOKEN"]) expect(env).not.toHaveProperty(name);
  });

  test("switches the phone listener on for the Wi-Fi, never Tailscale", () => {
    expect(JSON.parse(LAN_STATE)).toEqual({ enabled: true, via: "lan" });
  });

  test("drops every inherited LOKI_ setting, so none points the daemon back at the real ~/.loki", () => {
    expect(env).not.toHaveProperty("LOKI_PINS_FILE");
    expect(env).not.toHaveProperty("LOKI_STATE_DIR");
  });

  test("knows the made-up agent's words from the fixture itself", () => {
    expect(FIXTURE_WORDS).toEqual(expect.arrayContaining(["edit", "long story", "wait", "plan"]));
  });

  test("takes --keep and refuses anything else by name", () => {
    expect(parseArgs([])).toEqual({ keep: false });
    expect(parseArgs(["--keep"])).toEqual({ keep: true });
    expect(() => parseArgs(["--dir", "x"])).toThrow(/--dir/);
  });
});

describe("the phone preview's made-up data (U2)", () => {
  const chats = SEED.flatMap((a) => a.chats);

  test("three agents, each with at least two chats, a long one and one waiting on an approval", () => {
    expect(SEED).toHaveLength(3);
    for (const a of SEED) expect(a.chats.length).toBeGreaterThanOrEqual(2);
    expect(chats.filter((c) => c.ends === "long")).toHaveLength(1);
    expect(chats.filter((c) => c.ends === "approval").length).toBeGreaterThanOrEqual(1);
  });

  test("each message reaches the made-up agent's branch it is meant for, and no other", () => {
    for (const c of chats) {
      const hits = FIXTURE_WORDS.filter((w) => c.text.includes(w));
      if (c.ends === "approval") expect(hits).toEqual(["edit"]);
      else if (c.ends === "long") expect(hits).toEqual(["long story"]);
      else expect(hits).toEqual([]);
    }
  });

  test("a waiter resolves on its own chat's push without a request id, and ignores other chats", async () => {
    const waiter = pushWaiter();
    const seen = waiter.wait((m) => m.type === "chat_event" && m.conversation_id === "c1", 1000);
    waiter.push({ type: "chat_event", conversation_id: "c2", events: [] });
    waiter.push({ type: "chat_event", conversation_id: "c1", events: [{ kind: "turn_end" }] });
    await expect(seen).resolves.toMatchObject({ conversation_id: "c1" });
  });

  test("a waiter that hears nothing fails after its time, naming what it waited for", async () => {
    await expect(pushWaiter().wait(() => false, 5, "the pairing code")).rejects.toThrow(/the pairing code/);
  });
});

describe("the phone preview's pair link (U3)", () => {
  test("points at localhost and the phone listener's port, whatever host the daemon named", () => {
    expect(pairLink("AB12CD", 50123)).toBe("http://localhost:50123/?code=AB12CD");
  });
});

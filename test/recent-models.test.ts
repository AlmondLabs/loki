import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addRecentModel, mergeRecent, readRecentModels, RECENT_MODELS_MAX } from "../mod/models.ts";
import { bridgeOf } from "./fixtures/frames.ts";
import { PHONE_FRAMES } from "../core/frames.ts";
import { DeskStore } from "../mod/desk-store.ts";
import { GestureLog } from "../mod/gestures.ts";
import type { WidgetsWatcher } from "../mod/widgets-fs.ts";
import type { Client } from "../mod/server.ts";

const files = () => {
  const dir = mkdtempSync(join(tmpdir(), "loki-models-"));
  return { mine: join(dir, "state", "recent-models.json"), letta: join(dir, "settings.json") };
};

describe("recent models (mod/models.ts)", () => {
  test("loki's picks come first, then Letta Code's own recent models, each once, at most five", () => {
    expect(mergeRecent(["a", "b"], ["b", "c", "d", "e", "f"])).toEqual(["a", "b", "c", "d", "e"]);
    expect(RECENT_MODELS_MAX).toBe(5);
  });

  test("with no files there are none; Letta's settings are read, never written", () => {
    const f = files();
    expect(readRecentModels(f.mine, f.letta)).toEqual([]);
    writeFileSync(f.letta, JSON.stringify({ recentModels: ["anthropic/opus", "openai/gpt"], other: 1 }));
    expect(readRecentModels(f.mine, f.letta)).toEqual(["anthropic/opus", "openai/gpt"]);
    const before = readFileSync(f.letta, "utf8");
    expect(addRecentModel("letta/x", f.mine, f.letta)).toEqual(["letta/x", "anthropic/opus", "openai/gpt"]);
    expect(readFileSync(f.letta, "utf8")).toBe(before);
  });

  test("a model picked again moves to the front of loki's list", () => {
    const f = files();
    addRecentModel("a", f.mine, f.letta);
    addRecentModel("b", f.mine, f.letta);
    expect(addRecentModel("a", f.mine, f.letta)).toEqual(["a", "b"]);
    expect(JSON.parse(readFileSync(f.mine, "utf8")).recent).toEqual(["a", "b"]);
  });

  test("a broken file reads as none", () => {
    const f = files();
    writeFileSync(f.letta, "{not json");
    expect(readRecentModels(f.mine, f.letta)).toEqual([]);
  });
});

describe("recent models over the bridge", () => {
  const widgets = { entries: () => [], list: () => [], onChange: () => () => {} } as unknown as WidgetsWatcher;
  const client = (deviceId?: string): Client & { sent: Array<Record<string, unknown>> } => {
    const sent: Array<Record<string, unknown>> = [];
    return { scope: "shared", sent, send: (m) => sent.push(m as Record<string, unknown>), ...(deviceId ? { deviceId } : {}) } as Client & { sent: Array<Record<string, unknown>> };
  };

  test("every connection gets the list; a pick, from the Mac or a phone, is kept and broadcast to all", () => {
    let recent = ["anthropic/opus"];
    const broadcasts: Array<Record<string, unknown>> = [];
    const bridge = bridgeOf({
      store: new DeskStore(),
      widgets,
      gestures: new GestureLog(),
      broadcast: (m) => broadcasts.push(m as Record<string, unknown>),
      listDesks: () => [],
      recentModels: { read: () => recent, add: (h) => (recent = [h, ...recent.filter((x) => x !== h)]) },
    });
    const mac = client();
    bridge.onConnect(mac);
    expect(mac.sent.find((m) => m.type === "models_recent")).toEqual({ type: "models_recent", recent: ["anthropic/opus"] });
    expect(PHONE_FRAMES.has("models_recent_add")).toBe(true);
    const phone = client("d1");
    bridge.onMessage(phone, { type: "models_recent_add", handle: "openai/gpt" });
    expect(broadcasts.at(-1)).toEqual({ type: "models_recent", recent: ["openai/gpt", "anthropic/opus"] });
    // nothing to add: nothing kept, nothing said
    bridge.onMessage(mac, { type: "models_recent_add", handle: "" });
    expect(broadcasts.length).toBe(1);
  });
});

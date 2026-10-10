import { describe, expect, test } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addRecentModel, readRecentModels, RECENT_MODELS_MAX } from "../mod/models.ts";
import { bridgeOf } from "./fixtures/frames.ts";
import { PHONE_FRAMES } from "../core/frames.ts";
import { DeskStore } from "../mod/desk-store.ts";
import { GestureLog } from "../mod/gestures.ts";
import type { WidgetsWatcher } from "../mod/widgets-fs.ts";
import type { Client } from "../mod/server.ts";

const file = () => join(mkdtempSync(join(tmpdir(), "loki-models-")), "state", "recent-models.json");

describe("recent models (mod/models.ts)", () => {
  test("with no file there are none; a model picked moves to the front, each once, at most five", () => {
    const f = file();
    expect(readRecentModels(f)).toEqual([]);
    for (const h of ["a", "b", "c", "d", "e", "f"]) addRecentModel(h, f);
    expect(readRecentModels(f)).toEqual(["f", "e", "d", "c", "b"]);
    expect(addRecentModel("c", f)).toEqual(["c", "f", "e", "d", "b"]);
    expect(JSON.parse(readFileSync(f, "utf8")).recent).toEqual(["c", "f", "e", "d", "b"]);
    expect(RECENT_MODELS_MAX).toBe(5);
  });

  test("a broken file reads as none", () => {
    const f = file();
    addRecentModel("a", f);
    writeFileSync(f, "{not json");
    expect(readRecentModels(f)).toEqual([]);
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

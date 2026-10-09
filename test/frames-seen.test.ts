import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SeenStore } from "../mod/seen.ts";
import { seenFrame } from "../mod/frames/seen.ts";
import { bridgeWith, client } from "./fixtures/frames.ts";

describe("the seen push", () => {
  test("the turn-start mark pushes the same frame seen_list answers, focus included", () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-seen-"));
    try {
      const seen = new SeenStore(join(dir, "attention.json"), { debounceMs: 0 });
      seen.mark("a", "c1");
      seen.engage("a", "c1", "message");
      const { bridge } = bridgeWith({ seen, appServerAvailable: () => true });
      const c = client("d1");
      bridge.onMessage(c, { type: "seen_list" });
      expect(seenFrame({ seen, appServerAvailable: () => true })).toEqual(c.sent.at(-1) as never);
      expect(Object.keys((c.sent.at(-1) as { focus: object }).focus)).toEqual(["a/c1"]);
      seen.flush();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

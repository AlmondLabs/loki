import { beforeEach, describe, expect, test, vi } from "vitest";
import { readCachedDesks, readCachedThread, writeCachedDesks, writeCachedThread } from "../app/src/desk/boot-cache.ts";
import type { TranscriptRow } from "../app/src/chat/transcript.ts";
import type { DeskSummary } from "../core/frame-types.ts";

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k) => map.get(k) ?? null,
    key: (i) => [...map.keys()][i] ?? null,
    removeItem: (k) => void map.delete(k),
    setItem: (k, v) => void map.set(k, v),
  };
}

describe("boot cache", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", memoryStorage());
  });

  test("round-trips desks and thread rows and caps retained threads", () => {
    expect(readCachedDesks()).toBeNull();
    const desks = [{ scope: "ada", title: "Ada" } as DeskSummary];
    writeCachedDesks(desks);
    expect(readCachedDesks()).toEqual(desks);

    for (let i = 0; i < 15; i++) {
      const rows = Array.from({ length: 90 }, (_, n): TranscriptRow => ({ role: "user", text: `m${i}-${n}`, at: "2026-11-26T00:00:00Z" }));
      writeCachedThread("ada", `c${i}`, rows);
    }
    expect(readCachedThread("ada", "c0")).toBeNull();
    const latest = readCachedThread("ada", "c14");
    expect(latest).toHaveLength(80);
    expect(latest?.[0]?.text).toBe("m14-10");
  });
});

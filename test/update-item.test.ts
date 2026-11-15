import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { menuSpec } from "../app/src/shell/keymap.ts";
import { offeredVersion, readSkipped, saveSkipped, updateItemLabel } from "../app/src/shell/use-loki-update.ts";

// Plan 2026-11-15-1035, U7 (R15): a newer loki is offered from the loki menu and the ☰ menu, not the toolbar.
// Settings › loki's Skip This Version puts a version off until a newer one.

/** A stand-in for localStorage, so the test never touches a real one. */
function memoryStorage(): Pick<Storage, "getItem" | "setItem"> {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) };
}

const stable = { channel: "stable" as const };

describe("the update item", () => {
  test("with no newer loki, or before GitHub answers, the item is the plain check (AE5)", () => {
    expect(offeredVersion({ ...stable, newer: false, latest: "1.4.0" }, null)).toBeNull();
    expect(offeredVersion({ ...stable, newer: true, latest: null }, null)).toBeNull();
    expect(updateItemLabel(null)).toBe("Check for Updates…");
  });

  test("a newer stable version retitles the item until skipped, which holds until the next version (AE5)", () => {
    const storage = memoryStorage();
    expect(updateItemLabel(offeredVersion({ ...stable, newer: true, latest: "1.4.0" }, readSkipped(storage)))).toBe("Update to 1.4.0…");
    saveSkipped("1.4.0", storage);
    expect(offeredVersion({ ...stable, newer: true, latest: "1.4.0" }, readSkipped(storage))).toBeNull();
    expect(offeredVersion({ ...stable, newer: true, latest: "1.5.0" }, readSkipped(storage))).toBe("1.5.0");
  });

  test("a nightly build never reads as having an update waiting", () => {
    expect(offeredVersion({ channel: "nightly", newer: true, latest: "2026.11.16-nightly" }, null)).toBeNull();
  });

  test("blocked storage keeps no skip and throws nothing", () => {
    const blocked = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readSkipped(blocked)).toBeNull();
    expect(() => saveSkipped("1.4.0", blocked)).not.toThrow();
  });

  test("the loki menu holds Settings… and the update item, first in the list the Mac and ☰ both build from", () => {
    const [first] = menuSpec(undefined, "macos", { "app.update": "Update to 1.4.0…" });
    expect(first.title).toBe("loki");
    expect(first.items.filter((it) => "id" in it).map((it) => ("label" in it ? it.label : null))).toEqual(["Settings…", "Update to 1.4.0…"]);
  });

  test("the toolbar no longer carries an Update button", () => {
    const shell = readFileSync(join(import.meta.dirname, "..", "app", "src", "shell", "shell.tsx"), "utf8");
    expect(shell).not.toContain("<UpdateButton");
  });
});

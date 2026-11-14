import { describe, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { UpdateButton, offeredVersion, readLater, saveLater } from "../app/src/shell/update-button.tsx";

// Plan 2026-11-14-1330, U4 (R18): a newer loki is an Update button at the detail toolbar's trailing edge, not a notice
// over the content. Later hides it until the next version.

/** A stand-in for localStorage, so the test never touches a real one. */
function memoryStorage(): Pick<Storage, "getItem" | "setItem"> {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) };
}

describe("the Update button", () => {
  test("with no newer loki, or before GitHub answers, there is no button", () => {
    expect(offeredVersion({ newer: false, latest: "1.4.0" }, null)).toBeNull();
    expect(offeredVersion({ newer: false, latest: null }, null)).toBeNull();
    expect(offeredVersion({ newer: true, latest: null }, null)).toBeNull();
  });

  test("a newer version shows the button until Later, which hides it until the next version", () => {
    const storage = memoryStorage();
    expect(offeredVersion({ newer: true, latest: "1.4.0" }, readLater(storage))).toBe("1.4.0");
    saveLater("1.4.0", storage);
    expect(readLater(storage)).toBe("1.4.0");
    expect(offeredVersion({ newer: true, latest: "1.4.0" }, readLater(storage))).toBeNull();
    expect(offeredVersion({ newer: true, latest: "1.5.0" }, readLater(storage))).toBe("1.5.0");
  });

  test("blocked storage shows the button and keeps no Later", () => {
    const blocked = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readLater(blocked)).toBeNull();
    expect(() => saveLater("1.4.0", blocked)).not.toThrow();
  });

  test("it is a toolbar group: Update… with the version in its tooltip, and a menu button holding Later", () => {
    const html = renderToStaticMarkup(createElement(UpdateButton, { version: "1.4.0", onUpdate: () => {}, onLater: () => {} }));
    expect(html).toMatch(/^<div class="loki-update-slot"><span class="loki-toolbar-group" role="group" aria-label="Update">/);
    expect(html).toContain(">Update…</button>");
    expect(html).toContain('title="loki 1.4.0 is available"');
    expect(html).toMatch(/aria-label="Update Options"[^>]*aria-haspopup="menu"|aria-haspopup="menu"[^>]*aria-label="Update Options"/);
  });

  test("the shell shows it over the detail's top right, and no longer says it as a notice", () => {
    const shell = readFileSync(join(import.meta.dirname, "..", "app", "src", "shell", "shell.tsx"), "utf8");
    expect(shell).toContain("<UpdateButton");
    expect(shell).not.toContain("is available`");
    expect(shell).not.toContain("announceOnce");
  });
});

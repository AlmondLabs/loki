import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Plan 2026-11-15-1035, U8 (R13, R14): Learn's deck shows no key legend, Show Answer is the default button, and Delete is
// the destructive one, apart from Edit and Open the Chat. Each key stays in its button's tooltip (Button `kbd`).

const RECALL = join(import.meta.dirname, "..", "app", "src", "recall");
const deck = readFileSync(join(RECALL, "recall.tsx"), "utf8");
const parts = readFileSync(join(RECALL, "recall-parts.tsx"), "utf8");

describe("Learn's deck", () => {
  test("no strip of keys under the deck", () => {
    expect(parts).not.toContain("RecallKeys");
    expect(deck).not.toContain("RecallKeys");
    expect(deck + parts).not.toContain("show the answer ·");
  });

  test("Show Answer is the default button and keeps Space in its tooltip", () => {
    expect(deck).toMatch(/<Button size="md" tone="positive" onClick=\{onReveal\} kbd="space">\s*Show Answer/);
  });

  test("Delete is destructive, last, and pushed to the trailing edge, with X in its tooltip", () => {
    const row = deck.slice(deck.indexOf("Edit\n"), deck.indexOf("Delete\n") + 10);
    expect(row.indexOf("Open the Chat")).toBeGreaterThan(-1);
    expect(deck).toMatch(/<Button size="sm" tone="negative" className="ml-auto" onClick=\{onDelete\} kbd="X"/);
  });
});

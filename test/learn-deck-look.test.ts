import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const RECALL = join(import.meta.dirname, "..", "app", "src", "learn");
const deck = readFileSync(join(RECALL, "learn.tsx"), "utf8");
const parts = readFileSync(join(RECALL, "learn-parts.tsx"), "utf8");

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

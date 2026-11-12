import { describe, expect, test } from "vitest";
import { createElement } from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { Workbench } from "../app/src/dev/workbench.tsx";
import { LookProvider } from "../app/src/theme.tsx";

// Plan 2026-11-12-1505, U2: the Liquid Glass workbench, where the foundation is approved by looking.

describe("the workbench", () => {
  test("draws every section, with glass only on the floating layer", () => {
    const out = renderToStaticMarkup(createElement(LookProvider, { look: "glass" }, createElement(Workbench)));
    for (const section of ["Glass over content", "Roles", "Type", "Controls", "A turn", "Plan", "Flow&#x27;s cards", "Moves under the box"])
      expect(out).toContain(`>${section}</h2>`);
    expect(out).toMatch(/class="[^"]*\bglass-strong\b/);
    expect(out).toContain('data-proposal="approval"');
    // The workbench shows Liquid Glass whatever the device chose: Apple's words, the question, no key chips.
    expect(out).toContain(">Mark as Read</button>");
    expect(out).toContain("Allow the agent to run “Edit notes.txt”?");
  });

  test("is mounted only by the development server, never by a production build", () => {
    const main = readFileSync(join(import.meta.dirname, "..", "app", "src", "main.tsx"), "utf8");
    expect(main).toMatch(
      /if \(import\.meta\.env\.DEV && new URLSearchParams\(location\.search\)\.has\("workbench"\)\) await import\("\.\/dev\/mount-workbench"\);/,
    );
  });
});

import { describe, expect, test, afterAll } from "bun:test";
import { readFileSync, rmSync, existsSync } from "node:fs";
import { authorWidget, widgetsDir } from "../src/author";

const made: string[] = [];
function cleanup(id: string) {
  made.push(id);
}
afterAll(() => {
  for (const id of made) {
    rmSync(`${widgetsDir()}/${id}.tsx`, { force: true });
    rmSync(`${widgetsDir()}/${id}.js`, { force: true });
  }
});

describe("authorWidget (real esbuild)", () => {
  test("bundles a valid module, keeps react/kit external", async () => {
    const id = "test-valid";
    cleanup(id);
    const source = `
      import { useState } from "react";
      import { Stat } from "@loci/kit";
      export default function W({ data }) {
        const [n] = useState(0);
        return <Stat data={{ value: n, label: data.label }} onSet={() => {}} />;
      }
    `;
    const result = await authorWidget(id, source);
    expect(result.ok).toBe(true);
    expect(result.url).toBe("/widgets/test-valid.js");
    const out = readFileSync(`${widgetsDir()}/${id}.js`, "utf8");
    // Externals must remain bare imports, resolved by the browser import map.
    expect(out).toContain('from "react"');
    expect(out).toContain('from "@loci/kit"');
  }, 20000);

  test("returns the esbuild error on a syntax error; no bundle written", async () => {
    const id = "test-broken";
    cleanup(id);
    const result = await authorWidget(id, "export default function( {{{ broken");
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
    expect(existsSync(`${widgetsDir()}/${id}.js`)).toBe(false);
  }, 20000);
});

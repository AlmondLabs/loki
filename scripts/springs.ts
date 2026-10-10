/**
 * Writes loki's springs (app/src/kit/spring.ts) into kit/tokens.css, between the spring markers, as the
 * `--spring-<name>` easings and their `--spring-<name>-ms` durations. Run after changing a preset:
 *   node --experimental-strip-types scripts/springs.ts
 * test/spring.test.ts fails while the stylesheet and the presets disagree.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { springTokens } from "../app/src/kit/spring.ts";

export const START = "  /* springs: written by scripts/springs.ts from kit/spring.ts — do not edit by hand */";
export const END = "  /* end springs */";

const path = join(import.meta.dirname, "..", "app", "src", "kit", "tokens.css");
const css = readFileSync(path, "utf8");
const a = css.indexOf(START);
const b = css.indexOf(END);
if (a < 0 || b < a) throw new Error("tokens.css has no spring markers inside :root");
writeFileSync(path, `${css.slice(0, a + START.length)}\n${springTokens()}\n${css.slice(b)}`);
console.log("kit/tokens.css: springs written");

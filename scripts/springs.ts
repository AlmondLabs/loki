import { readFileSync, writeFileSync } from "node:fs";
import { format, type FormatConfig } from "oxfmt";
import { join } from "node:path";
import { springTokens } from "../app/src/kit/spring.ts";

export const START = "  /* springs: written by scripts/springs.ts from kit/spring.ts — do not edit by hand */";
export const END = "  /* end springs */";

const path = join(import.meta.dirname, "..", "app", "src", "kit", "tokens.css");
const css = readFileSync(path, "utf8");
const a = css.indexOf(START);
const b = css.indexOf(END);
if (a < 0 || b < a) throw new Error("tokens.css has no spring markers inside :root");
const written = `${css.slice(0, a + START.length)}\n${springTokens()}\n${css.slice(b)}`;
const {
  ignorePatterns: _ignored,
  $schema: _schema,
  ...options
} = JSON.parse(readFileSync(join(import.meta.dirname, "..", ".oxfmtrc.json"), "utf8")) as FormatConfig & {
  ignorePatterns?: unknown;
  $schema?: unknown;
};
const out = await format(path, written, options);
if (out.errors.length > 0) throw new Error(`kit/tokens.css did not format: ${out.errors.map((e) => e.message).join("; ")}`);
writeFileSync(path, out.code);
console.log("kit/tokens.css: springs written");

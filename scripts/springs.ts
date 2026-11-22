import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { springTokens } from "../app/src/kit/spring.ts";

export const START = "  /* springs: written by scripts/springs.ts from kit/spring.ts — do not edit by hand */";
export const END = "  /* end springs */";

const root = join(import.meta.dirname, "..");
const relative = join("app", "src", "kit", "tokens.css");
const path = join(root, relative);
const css = readFileSync(path, "utf8");
const a = css.indexOf(START);
const b = css.indexOf(END);
if (a < 0 || b < a) throw new Error("tokens.css has no spring markers inside :root");
const written = `${css.slice(0, a + START.length)}\n${springTokens()}\n${css.slice(b)}`;
const bun = join(dirname(createRequire(import.meta.url).resolve("bun/package.json")), "bin", "bun.exe");
const formatted = execFileSync(bun, ["fmt", "--no-script", "--stdin-filepath", relative], { cwd: root, input: written, encoding: "utf8" });
writeFileSync(path, formatted);
console.log("kit/tokens.css: springs written");

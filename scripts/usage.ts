#!/usr/bin/env bun
/**
 * The usage report: `bun run usage [-- --days N]` (default 30). Reads ~/.letta/loki/logs/usage.jsonl and the rotated
 * .1 beside it, and prints what core/usage.ts counts. LOKI_USAGE_PATH points it at another file (a copy, a test).
 */
import { existsSync, readFileSync } from "node:fs";
import { formatUsageReport, parseUsage, usageReport } from "../core/usage.ts";
import { paths } from "../mod/paths.ts";

const args = process.argv.slice(2);
const at = args.indexOf("--days");
const days = at >= 0 ? Number(args[at + 1]) : 30;
if (!Number.isFinite(days) || days <= 0) {
  console.error("usage: bun run usage [-- --days N]");
  process.exit(2);
}
const path = process.env.LOKI_USAGE_PATH ?? paths.usage;
const files = [`${path}.1`, path].filter((f) => existsSync(f));
if (!files.length) {
  console.log(`no usage log yet at ${path} — it starts with the next thing you do in loki`);
  process.exit(0);
}
const lines = parseUsage(files.map((f) => readFileSync(f, "utf8")).join("\n"));
console.log(formatUsageReport(usageReport(lines, { now: Date.now(), days })));
console.log(`\n${path}`);

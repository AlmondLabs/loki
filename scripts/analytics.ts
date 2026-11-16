import { existsSync, readFileSync } from "node:fs";
import { analyticsReport, formatAnalyticsReport, parseEvents } from "../core/analytics.ts";
import { paths } from "../mod/paths.ts";

const args = process.argv.slice(2);
const at = args.indexOf("--days");
const days = at >= 0 ? Number(args[at + 1]) : 30;
if (!Number.isFinite(days) || days <= 0) {
  console.error("usage: npm run analytics -- [--days N]");
  process.exit(2);
}
const path = process.env.LOKI_EVENTS_PATH ?? paths.events;
const files = [`${path}.1`, path].filter((f) => existsSync(f));
if (!files.length) {
  console.log(`no events yet at ${path} — they start with the next thing you do in loki`);
  process.exit(0);
}
const events = parseEvents(files.map((f) => readFileSync(f, "utf8")).join("\n"));
console.log(formatAnalyticsReport(analyticsReport(events, { now: Date.now(), days })));
console.log(`\n${path}`);

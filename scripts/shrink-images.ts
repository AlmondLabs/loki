/**
 * Shrink the pictures already in the chat stores (plan 032): `npm run shrink-images` reports what it would save,
 * `npm run shrink-images -- --apply` does it, each store copied whole into stores/backup-<date>/ first. Quit loki
 * first: this takes the daemon's lock, and stops when loki holds it. `--dir` names a loki folder other than ~/.loki.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { acquire } from "../daemon/lock.ts";
import { shrinkStoreImages, type StoreImagesReport } from "../daemon/store-images.ts";
import { lokiDir } from "../mod/paths.ts";

const { values: args } = parseArgs({ options: { apply: { type: "boolean" }, dir: { type: "string" } } });
const dir = args.dir ?? lokiDir();
const stores = join(dir, "stores");
const apply = args.apply === true;

if (process.platform !== "darwin") {
  console.log("Pictures are shrunk with macOS's sips; on this system there is nothing this can do.");
  process.exit(0);
}
if (!existsSync(stores)) {
  console.log(`No chat stores in ${stores}.`);
  process.exit(0);
}
const taken = acquire(join(dir, "daemon.lock"));
if (!("release" in taken)) {
  console.error(`loki is running (pid ${taken.heldBy}) and has the stores open. Quit loki, then run this again.`);
  process.exit(1);
}

const mb = (n: number) => `${(n / 1e6).toFixed(1)} MB`;
const backupDir = join(stores, `backup-${new Date().toISOString().slice(0, 10)}`);
const reports: StoreImagesReport[] = [];
try {
  for (const name of readdirSync(stores).filter((n) => n.endsWith(".sqlite"))) {
    const report = await shrinkStoreImages(join(stores, name), { apply, backupDir });
    reports.push(report);
    console.log(
      report.pictures
        ? `${name}: ${report.pictures} pictures, ${mb(report.before)} → ${mb(report.after)}${report.backup ? ` (was copied to ${report.backup})` : ""}`
        : `${name}: nothing to shrink`,
    );
  }
} finally {
  taken.release();
}
const saved = reports.reduce((n, r) => n + r.before - r.after, 0);
if (!saved) console.log("Nothing to shrink.");
else if (apply) console.log(`Saved ${mb(saved)}. The copies stay in ${backupDir} until you delete them.`);
else console.log(`Would save ${mb(saved)}. Quit loki, then run npm run shrink-images -- --apply to do it.`);

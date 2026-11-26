import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { messageOf } from "../core/errors.ts";

export const MANAGED_MARKER = ".managed-by-loki";
export const BUNDLE_STAMP = ".bundle-stamp";
const MARKER_TEXT = "files here are written by the loki app on launch\n";

export type InstallState = "installed" | "updated" | "current" | "custom" | "skipped" | "linked" | "error";

export interface InstallReport {
  mod: InstallState;
  mod_path: string;
  skill: InstallState;
  skill_path: string;
  app: InstallState;
  app_path: string;
  error: string | null;
}

export const skillDir = (home: string): string => join(home, ".agents", "skills", "loki");

export function skippedReport(home: string): InstallReport {
  return { mod: "skipped", mod_path: "", skill: "skipped", skill_path: skillDir(home), app: "skipped", app_path: "", error: null };
}

const isFile = (path: string) => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

const linkStat = (path: string) => {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
};

const joinErrors = (previous: string | null, next: string) => (previous ? `${previous}; ${next}` : next);

export function sameDir(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

export function linkDir(target: string, dst: string): void {
  symlinkSync(target, dst, "junction");
}

export function linkCheckout(checkout: string, home: string): InstallReport {
  const report = skippedReport(home);
  const boot = join(checkout, "mod", "boot.ts");
  report.mod_path = boot;
  if (!isFile(boot)) {
    report.mod = "error";
    report.error = `${checkout} is not a checkout: no mod/boot.ts`;
    return report;
  }
  report.mod = "linked";
  const skills = join(checkout, "skills", "loki");
  const dst = skillDir(home);
  const stat = linkStat(dst);
  if (stat?.isSymbolicLink()) {
    let target = "";
    try {
      target = resolve(dirname(dst), readlinkSync(dst));
    } catch {}
    report.skill = target === skills || sameDir(dst, skills) ? "linked" : "custom";
  } else if (stat) {
    report.skill = existsSync(join(dst, MANAGED_MARKER)) ? "skipped" : "custom";
  } else {
    try {
      mkdirSync(dirname(dst), { recursive: true });
      linkDir(skills, dst);
      report.skill = "linked";
    } catch (error) {
      report.error = joinErrors(report.error, `could not link ${dst}: ${messageOf(error)}`);
      report.skill = "error";
    }
  }
  return report;
}

export function findResources(resourceDir: string): string | null {
  return [join(resourceDir, "resources"), resourceDir].find((d) => isFile(join(d, "mod", "loki-mod.mjs"))) ?? null;
}

function writeIfChanged(path: string, bytes: Buffer): "installed" | "updated" | "current" {
  mkdirSync(dirname(path), { recursive: true });
  let existing: Buffer | null = null;
  try {
    existing = readFileSync(path);
  } catch {}
  if (existing?.equals(bytes)) return "current";
  writeFileSync(path, bytes);
  return existing ? "updated" : "installed";
}

function walk(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? join(prefix, entry.name) : entry.name;
    if (entry.isDirectory()) out.push(...walk(join(dir, entry.name), rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

function installMod(resources: string, dataDir: string): { state: InstallState; path: string } {
  let bundle: Buffer;
  try {
    bundle = readFileSync(join(resources, "mod", "loki-mod.mjs"));
  } catch (error) {
    throw new Error(`bundled mod unreadable: ${messageOf(error)}`, { cause: error });
  }
  const path = join(dataDir, "mod", "loki-mod.mjs");
  try {
    return { state: writeIfChanged(path, bundle), path };
  } catch (error) {
    throw new Error(`could not write ${path}: ${messageOf(error)}`, { cause: error });
  }
}

function installDaemon(resources: string, dataDir: string): InstallState {
  const src = join(resources, "daemon");
  if (!isFile(join(src, "daemon.mjs"))) return "skipped";
  let files: string[];
  try {
    files = walk(src);
  } catch (error) {
    throw new Error(`bundled daemon unreadable: ${messageOf(error)}`, { cause: error });
  }
  let state: InstallState = "current";
  for (const rel of files) {
    const bytes = readFileSync(join(src, rel));
    try {
      if (writeIfChanged(join(dataDir, "daemon", rel), bytes) !== "current") state = "updated";
    } catch (error) {
      throw new Error(`could not write ${rel}: ${messageOf(error)}`, { cause: error });
    }
  }
  return state;
}

function installSkill(resources: string, home: string): { state: InstallState; path: string } {
  const src = join(resources, "skills", "loki");
  const dst = skillDir(home);
  const stat = linkStat(dst);
  if (stat && (stat.isSymbolicLink() || !existsSync(join(dst, MANAGED_MARKER)))) return { state: "custom", path: dst };
  const fresh = stat === null;
  let state: InstallState = fresh ? "installed" : "current";
  let entries;
  try {
    entries = readdirSync(src, { withFileTypes: true });
  } catch (error) {
    throw new Error(`bundled skill unreadable: ${messageOf(error)}`, { cause: error });
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const bytes = readFileSync(join(src, entry.name));
    let written;
    try {
      written = writeIfChanged(join(dst, entry.name), bytes);
    } catch (error) {
      throw new Error(`could not write skill: ${messageOf(error)}`, { cause: error });
    }
    if (!fresh && written === "updated") state = "updated";
  }
  mkdirSync(dst, { recursive: true });
  writeFileSync(join(dst, MANAGED_MARKER), MARKER_TEXT);
  return { state, path: dst };
}

function installApp(resources: string, dataDir: string): { state: InstallState; path: string } {
  const src = join(resources, "app");
  const dst = join(dataDir, "app");
  if (!isFile(join(src, "index.html"))) return { state: "skipped", path: dst };
  const stat = linkStat(dst);
  if (stat && (stat.isSymbolicLink() || !existsSync(join(dst, MANAGED_MARKER)))) return { state: "custom", path: dst };
  const fresh = stat === null;
  let state: InstallState = fresh ? "installed" : "current";
  let files: string[];
  try {
    files = walk(src);
  } catch (error) {
    throw new Error(`bundled app unreadable: ${messageOf(error)}`, { cause: error });
  }
  if (fresh) {
    mkdirSync(dst, { recursive: true });
    writeFileSync(join(dst, MANAGED_MARKER), MARKER_TEXT);
  }
  for (const rel of files) {
    let written;
    try {
      written = writeIfChanged(join(dst, rel), readFileSync(join(src, rel)));
    } catch (error) {
      throw new Error(`could not write app: ${messageOf(error)}`, { cause: error });
    }
    if (!fresh && written !== "current") state = "updated";
  }
  const shipped = new Set(files);
  for (const rel of walk(dst)) {
    if (rel === MANAGED_MARKER || shipped.has(rel)) continue;
    try {
      rmSync(join(dst, rel));
    } catch (error) {
      throw new Error(`could not remove stale ${rel}: ${messageOf(error)}`, { cause: error });
    }
    if (!fresh) state = "updated";
  }
  writeFileSync(join(dst, MANAGED_MARKER), MARKER_TEXT);
  return { state, path: dst };
}

function readStamp(dir: string): string | null {
  try {
    return readFileSync(join(dir, BUNDLE_STAMP), "utf8");
  } catch {
    return null;
  }
}

function bundlesCurrent(resources: string, dataDir: string, stamp: string): boolean {
  if (readStamp(dataDir) !== stamp) return false;
  if (!isFile(join(dataDir, "mod", "loki-mod.mjs"))) return false;
  if (isFile(join(resources, "daemon", "daemon.mjs")) && !isFile(join(dataDir, "daemon", "daemon.mjs"))) return false;
  if (isFile(join(resources, "app", "index.html")) && !isFile(join(dataDir, "app", "index.html"))) return false;
  return true;
}

export function installBundles(resources: string, dataDir: string, home: string): InstallReport {
  const report = skippedReport(home);
  const stamp = readStamp(resources);
  if (stamp !== null && bundlesCurrent(resources, dataDir, stamp)) {
    const hasApp = isFile(join(resources, "app", "index.html"));
    report.app = hasApp ? "current" : "skipped";
    report.app_path = join(dataDir, "app");
    report.mod = "current";
    report.mod_path = join(dataDir, "mod", "loki-mod.mjs");
  } else {
    try {
      const app = installApp(resources, dataDir);
      report.app = app.state;
      report.app_path = app.path;
    } catch (error) {
      report.app = "error";
      report.error = messageOf(error);
    }
    try {
      const mod = installMod(resources, dataDir);
      report.mod = mod.state;
      report.mod_path = mod.path;
    } catch (error) {
      report.mod = "error";
      report.error = joinErrors(report.error, messageOf(error));
    }
    try {
      installDaemon(resources, dataDir);
    } catch (error) {
      report.error = joinErrors(report.error, messageOf(error));
    }
    if (stamp !== null && report.mod !== "error" && report.app !== "error") {
      try {
        mkdirSync(dataDir, { recursive: true });
        writeFileSync(join(dataDir, BUNDLE_STAMP), stamp);
      } catch (error) {
        report.error = joinErrors(report.error, messageOf(error));
      }
    }
  }
  try {
    const skill = installSkill(resources, home);
    report.skill = skill.state;
    report.skill_path = skill.path;
  } catch (error) {
    report.skill = "error";
    report.error = joinErrors(report.error, messageOf(error));
  }
  return report;
}

export function installWanted(packaged: boolean, env: NodeJS.ProcessEnv): boolean {
  if (env.LOKI_NO_INSTALL !== undefined) return false;
  return packaged || env.LOKI_INSTALL !== undefined;
}

export function devCheckout(packaged: boolean, env: NodeJS.ProcessEnv, checkout: string): string | null {
  return packaged || env.LOKI_NO_INSTALL !== undefined ? null : checkout;
}

export function launchInstall(opts: {
  packaged: boolean;
  env: NodeJS.ProcessEnv;
  resourceDir: string;
  checkout: string;
  dataDir: string;
  home: string;
}): InstallReport {
  if (installWanted(opts.packaged, opts.env)) {
    const resources = findResources(opts.resourceDir);
    return resources
      ? installBundles(resources, opts.dataDir, opts.home)
      : { ...skippedReport(opts.home), mod: "error", error: "bundled mod not found in the app's resources" };
  }
  const checkout = devCheckout(opts.packaged, opts.env, opts.checkout);
  return checkout ? linkCheckout(checkout, opts.home) : skippedReport(opts.home);
}

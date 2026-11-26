import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  BUNDLE_STAMP,
  devCheckout,
  findResources,
  installBundles,
  installWanted,
  launchInstall,
  linkCheckout,
  linkDir,
  MANAGED_MARKER,
  sameDir,
  skillDir,
} from "../desktop/install.ts";

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function write(file: string, text: string) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "loki-install-"));
  temps.push(root);
  const resources = join(root, "res");
  write(join(resources, "daemon", "daemon.mjs"), "export default () => 1;\n");
  write(join(resources, "skills", "loki", "SKILL.md"), "# loki\n");
  return { root, resources, data: join(root, "data"), home: join(root, "home") };
}

function withApp(resources: string) {
  write(join(resources, "app", "index.html"), "<html></html>");
  write(join(resources, "app", "assets", "index-abc.js"), "1");
}

function checkout(root: string) {
  const c = join(root, "checkout");
  write(join(c, "daemon", "main.ts"), "export {};\n");
  write(join(c, "skills", "loki", "SKILL.md"), "# loki\n");
  return c;
}

describe("installing the bundles at launch", () => {
  test("installs, then is current, then updates", () => {
    const { resources, data, home } = fixture();
    let r = installBundles(resources, data, home);
    expect([r.mod, r.skill]).toEqual(["installed", "installed"]);
    expect(r.mod_path).toBe(join(data, "daemon", "daemon.mjs"));
    expect(existsSync(join(skillDir(home), "SKILL.md"))).toBe(true);
    expect(existsSync(join(skillDir(home), MANAGED_MARKER))).toBe(true);
    r = installBundles(resources, data, home);
    expect([r.mod, r.skill]).toEqual(["current", "current"]);
    write(join(resources, "daemon", "daemon.mjs"), "export default () => 2;\n");
    write(join(resources, "skills", "loki", "SKILL.md"), "# loki v2\n");
    r = installBundles(resources, data, home);
    expect([r.mod, r.skill]).toEqual(["updated", "updated"]);
    expect(r.error).toBeNull();
  });

  test("the daemon bundle is installed beside its native deps", () => {
    const { resources, data, home } = fixture();
    write(join(resources, "daemon", "node_modules", "@napi-rs", "keyring", "index.js"), "// keyring\n");
    const r = installBundles(resources, data, home);
    expect(readFileSync(join(data, "daemon", "daemon.mjs"), "utf8")).toBe("export default () => 1;\n");
    expect(readFileSync(join(data, "daemon", "node_modules", "@napi-rs", "keyring", "index.js"), "utf8")).toBe("// keyring\n");
    expect(r.error).toBeNull();
  });

  test("an unmarked skill folder is someone else's: custom, and left alone", () => {
    const { resources, data, home } = fixture();
    write(join(skillDir(home), "SKILL.md"), "mine");
    const r = installBundles(resources, data, home);
    expect(r.skill).toBe("custom");
    expect(r.mod).toBe("installed");
    expect(readFileSync(join(skillDir(home), "SKILL.md"), "utf8")).toBe("mine");
  });

  test("leaves a developer's linked skill alone", () => {
    const { resources, data, home } = fixture();
    mkdirSync(dirname(skillDir(home)), { recursive: true });
    linkDir(resources, skillDir(home));
    const r = installBundles(resources, data, home);
    expect(r.mod).toBe("installed");
    expect(r.skill).toBe("custom");
    expect(r.error).toBeNull();
  });

  test("the phone canvas is optional and installs beside the mod, its stale files removed", () => {
    const { resources, data, home } = fixture();
    let r = installBundles(resources, data, home);
    expect(r.app).toBe("skipped");
    expect(existsSync(join(data, "app"))).toBe(false);
    withApp(resources);
    r = installBundles(resources, data, home);
    expect(r.app).toBe("installed");
    expect(r.app_path).toBe(join(data, "app"));
    expect(existsSync(join(data, "app", "assets", "index-abc.js"))).toBe(true);
    expect(existsSync(join(data, "app", MANAGED_MARKER))).toBe(true);
    expect(installBundles(resources, data, home).app).toBe("current");
    rmSync(join(resources, "app", "assets", "index-abc.js"));
    write(join(resources, "app", "assets", "index-def.js"), "2");
    r = installBundles(resources, data, home);
    expect(r.app).toBe("updated");
    expect(existsSync(join(data, "app", "assets", "index-abc.js"))).toBe(false);
    expect(existsSync(join(data, "app", "assets", "index-def.js"))).toBe(true);
    expect(r.error).toBeNull();
  });

  test("leaves an app folder it did not write alone", () => {
    const { resources, data, home } = fixture();
    withApp(resources);
    write(join(data, "app", "index.html"), "mine");
    const r = installBundles(resources, data, home);
    expect(r.app).toBe("custom");
    expect(readFileSync(join(data, "app", "index.html"), "utf8")).toBe("mine");
  });

  test("reports missing resources", () => {
    const { root, data, home } = fixture();
    const r = installBundles(join(root, "nowhere"), data, home);
    expect(r.mod).toBe("error");
    expect(r.error).not.toBeNull();
  });

  test("finds the resources in both layouts", () => {
    const { root, resources } = fixture();
    expect(findResources(resources)).toBe(resources);
    expect(findResources(root)).toBeNull();
    const nested = join(root, "bundle");
    write(join(nested, "resources", "daemon", "daemon.mjs"), "x");
    expect(findResources(nested)).toBe(join(nested, "resources"));
  });
});

describe("a development build", () => {
  test("links a fresh Mac to the checkout and never overwrites", () => {
    const { root, resources, data, home } = fixture();
    const c = checkout(root);
    let r = linkCheckout(c, home);
    expect([r.mod, r.skill]).toEqual(["linked", "linked"]);
    expect(r.error).toBeNull();
    expect(r.mod_path).toBe(join(c, "daemon", "main.ts"));
    const link = resolve(dirname(skillDir(home)), readlinkSync(skillDir(home)));
    expect(sameDir(link, join(c, "skills", "loki"))).toBe(true);
    expect(existsSync(join(skillDir(home), "SKILL.md"))).toBe(true);
    r = linkCheckout(c, home);
    expect([r.mod, r.skill]).toEqual(["linked", "linked"]);
    r = installBundles(resources, data, home);
    expect(r.skill).toBe("custom");
    expect(lstatSync(skillDir(home)).isSymbolicLink()).toBe(true);
  });

  test("leaves the app's skill and a stranger's alone", () => {
    const { root, resources, data, home } = fixture();
    const c = checkout(root);
    installBundles(resources, data, home);
    let r = linkCheckout(c, home);
    expect([r.mod, r.skill]).toEqual(["linked", "skipped"]);
    rmSync(join(skillDir(home), MANAGED_MARKER));
    r = linkCheckout(c, home);
    expect(r.skill).toBe("custom");
    const other = fixture();
    r = linkCheckout(join(root, "nowhere"), other.home);
    expect(r.mod).toBe("error");
    expect(existsSync(skillDir(other.home))).toBe(false);
  });

  test("installs only when packaged or asked to, and runs the checkout otherwise", () => {
    expect(installWanted(true, {})).toBe(true);
    expect(installWanted(true, { LOKI_NO_INSTALL: "1" })).toBe(false);
    expect(installWanted(false, {})).toBe(false);
    expect(installWanted(false, { LOKI_INSTALL: "1" })).toBe(true);
    expect(devCheckout(false, {}, "/src/loki")).toBe("/src/loki");
    expect(devCheckout(false, { LOKI_NO_INSTALL: "1" }, "/src/loki")).toBeNull();
    expect(devCheckout(true, {}, "/src/loki")).toBeNull();
    const { root, resources, data, home } = fixture();
    const c = checkout(root);
    expect(launchInstall({ packaged: true, env: {}, resourceDir: resources, checkout: c, dataDir: data, home }).mod).toBe("installed");
    expect(launchInstall({ packaged: true, env: {}, resourceDir: join(root, "nowhere"), checkout: c, dataDir: data, home })).toMatchObject({
      mod: "error",
      error: "bundled daemon not found in the app's resources",
    });
    expect(launchInstall({ packaged: false, env: {}, resourceDir: resources, checkout: c, dataDir: data, home }).mod).toBe("linked");
    expect(launchInstall({ packaged: false, env: { LOKI_NO_INSTALL: "1" }, resourceDir: resources, checkout: c, dataDir: data, home }).mod).toBe("skipped");
  });

  test("a matching .bundle-stamp skips reading unchanged bundles; a changed stamp updates them", () => {
    const { resources, data, home } = fixture();
    withApp(resources);
    write(join(resources, "daemon", "daemon.mjs"), "// d1\n");
    write(join(resources, BUNDLE_STAMP), "stamp-1\n");
    let r = installBundles(resources, data, home);
    expect([r.app, r.mod]).toEqual(["installed", "installed"]);
    expect(readFileSync(join(data, BUNDLE_STAMP), "utf8")).toBe("stamp-1\n");

    write(join(resources, "daemon", "daemon.mjs"), "// d2\n");
    r = installBundles(resources, data, home);
    expect([r.app, r.mod]).toEqual(["current", "current"]);
    expect(readFileSync(join(data, "daemon", "daemon.mjs"), "utf8")).toBe("// d1\n");

    write(join(resources, BUNDLE_STAMP), "stamp-2\n");
    r = installBundles(resources, data, home);
    expect([r.app, r.mod]).toEqual(["current", "updated"]);
    expect(readFileSync(join(data, "daemon", "daemon.mjs"), "utf8")).toBe("// d2\n");
    expect(readFileSync(join(data, BUNDLE_STAMP), "utf8")).toBe("stamp-2\n");
  });
});

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { BUNDLE_STAMP, devCheckout, findResources, installBundles, installWanted, launchInstall, linkCheckout, MANAGED_MARKER } from "../desktop/install.ts";

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
  return { root, resources, data: join(root, "data") };
}

function withApp(resources: string) {
  write(join(resources, "app", "index.html"), "<html></html>");
  write(join(resources, "app", "assets", "index-abc.js"), "1");
}

function checkout(root: string) {
  const c = join(root, "checkout");
  write(join(c, "daemon", "main.ts"), "export {};\n");
  return c;
}

describe("installing the bundles at launch", () => {
  test("installs, then is current, then updates", () => {
    const { resources, data } = fixture();
    let r = installBundles(resources, data);
    expect(r.mod).toBe("installed");
    expect(r.mod_path).toBe(join(data, "daemon", "daemon.mjs"));
    r = installBundles(resources, data);
    expect(r.mod).toBe("current");
    write(join(resources, "daemon", "daemon.mjs"), "export default () => 2;\n");
    r = installBundles(resources, data);
    expect(r.mod).toBe("updated");
    expect(r.error).toBeNull();
  });

  test("the daemon bundle is installed beside its native deps", () => {
    const { resources, data } = fixture();
    write(join(resources, "daemon", "node_modules", "@napi-rs", "keyring", "index.js"), "// keyring\n");
    const r = installBundles(resources, data);
    expect(readFileSync(join(data, "daemon", "daemon.mjs"), "utf8")).toBe("export default () => 1;\n");
    expect(readFileSync(join(data, "daemon", "node_modules", "@napi-rs", "keyring", "index.js"), "utf8")).toBe("// keyring\n");
    expect(r.error).toBeNull();
  });

  test("the web app is optional and installs beside the mod, its stale files removed", () => {
    const { resources, data } = fixture();
    let r = installBundles(resources, data);
    expect(r.app).toBe("skipped");
    expect(existsSync(join(data, "app"))).toBe(false);
    withApp(resources);
    r = installBundles(resources, data);
    expect(r.app).toBe("installed");
    expect(r.app_path).toBe(join(data, "app"));
    expect(existsSync(join(data, "app", "assets", "index-abc.js"))).toBe(true);
    expect(existsSync(join(data, "app", MANAGED_MARKER))).toBe(true);
    expect(installBundles(resources, data).app).toBe("current");
    rmSync(join(resources, "app", "assets", "index-abc.js"));
    write(join(resources, "app", "assets", "index-def.js"), "2");
    r = installBundles(resources, data);
    expect(r.app).toBe("updated");
    expect(existsSync(join(data, "app", "assets", "index-abc.js"))).toBe(false);
    expect(existsSync(join(data, "app", "assets", "index-def.js"))).toBe(true);
    expect(r.error).toBeNull();
  });

  test("leaves an app folder it did not write alone", () => {
    const { resources, data } = fixture();
    withApp(resources);
    write(join(data, "app", "index.html"), "mine");
    const r = installBundles(resources, data);
    expect(r.app).toBe("custom");
    expect(readFileSync(join(data, "app", "index.html"), "utf8")).toBe("mine");
  });

  test("reports missing resources", () => {
    const { root, data } = fixture();
    const r = installBundles(join(root, "nowhere"), data);
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
  test("links to the checkout and reports missing checkout", () => {
    const { root } = fixture();
    const c = checkout(root);
    const r = linkCheckout(c);
    expect(r.mod).toBe("linked");
    expect(r.error).toBeNull();
    expect(r.mod_path).toBe(join(c, "daemon", "main.ts"));
    const bad = linkCheckout(join(root, "nowhere"));
    expect(bad.mod).toBe("error");
  });

  test("installs only when packaged or asked to, and runs the checkout otherwise", () => {
    expect(installWanted(true, {})).toBe(true);
    expect(installWanted(true, { LOKI_NO_INSTALL: "1" })).toBe(false);
    expect(installWanted(false, {})).toBe(false);
    expect(installWanted(false, { LOKI_INSTALL: "1" })).toBe(true);
    expect(devCheckout(false, {}, "/src/loki")).toBe("/src/loki");
    expect(devCheckout(false, { LOKI_NO_INSTALL: "1" }, "/src/loki")).toBeNull();
    expect(devCheckout(true, {}, "/src/loki")).toBeNull();
    const { root, resources, data } = fixture();
    const c = checkout(root);
    expect(launchInstall({ packaged: true, env: {}, resourceDir: resources, checkout: c, dataDir: data }).mod).toBe("installed");
    expect(launchInstall({ packaged: true, env: {}, resourceDir: join(root, "nowhere"), checkout: c, dataDir: data })).toMatchObject({
      mod: "error",
      error: "bundled daemon not found in the app's resources",
    });
    expect(launchInstall({ packaged: false, env: {}, resourceDir: resources, checkout: c, dataDir: data }).mod).toBe("linked");
    expect(launchInstall({ packaged: false, env: { LOKI_NO_INSTALL: "1" }, resourceDir: resources, checkout: c, dataDir: data }).mod).toBe("skipped");
  });

  test("a matching .bundle-stamp skips reading unchanged bundles; a changed stamp updates them", () => {
    const { resources, data } = fixture();
    withApp(resources);
    write(join(resources, "daemon", "daemon.mjs"), "// d1\n");
    write(join(resources, BUNDLE_STAMP), "stamp-1\n");
    let r = installBundles(resources, data);
    expect([r.app, r.mod]).toEqual(["installed", "installed"]);
    expect(readFileSync(join(data, BUNDLE_STAMP), "utf8")).toBe("stamp-1\n");

    write(join(resources, "daemon", "daemon.mjs"), "// d2\n");
    r = installBundles(resources, data);
    expect([r.app, r.mod]).toEqual(["current", "current"]);
    expect(readFileSync(join(data, "daemon", "daemon.mjs"), "utf8")).toBe("// d1\n");

    write(join(resources, BUNDLE_STAMP), "stamp-2\n");
    r = installBundles(resources, data);
    expect([r.app, r.mod]).toEqual(["current", "updated"]);
    expect(readFileSync(join(data, "daemon", "daemon.mjs"), "utf8")).toBe("// d2\n");
    expect(readFileSync(join(data, BUNDLE_STAMP), "utf8")).toBe("stamp-2\n");
  });
});

import { expect, test } from "bun:test";
import { isNewerVersion, parseVersion } from "../core/version.ts";
import { dateVersion, nightlyVersion } from "../scripts/release.ts";

test("release tags and plain versions parse alike", () => {
  expect(parseVersion("v0.3.0")).toEqual([0, 3, 0]);
  expect(parseVersion("0.3.0")).toEqual([0, 3, 0]);
  expect(parseVersion("nightly")).toBeNull();
});

test("newer means strictly after, per component", () => {
  expect(isNewerVersion("0.3.0", "v0.3.1")).toBe(true);
  expect(isNewerVersion("0.3.0", "0.4.0")).toBe(true);
  expect(isNewerVersion("0.3.0", "1.0.0")).toBe(true);
  expect(isNewerVersion("0.3.0", "0.3.0")).toBe(false);
  expect(isNewerVersion("0.3.1", "0.3.0")).toBe(false);
  expect(isNewerVersion("0.3.0", "garbage")).toBe(false);
});

/**
 * Windows (plan 014 U10): only stables are built for Windows (the Windows and Linux PR), but a nightly's number would do too.
 * Tauri's NSIS bundler takes the app version as is. It parses it as semver, drops the
 * pre-release, and writes `VIProductVersion "M.m.p.B"` with B the build metadata when numeric, else 0; each part
 * is a 16-bit word in the Windows version resource (tauri-bundler windows/nsis/mod.rs try_add_numeric_build_number,
 * tauri-build's to_winres_version). Only the MSI bundler rejects a non-numeric pre-release, and loki builds no MSI.
 * So no version needs a Windows-only number, as long as the versions keep to this shape.
 */
test("stable and nightly versions build an NSIS installer as is: semver, no build metadata, parts within 16 bits", () => {
  const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
  const productVersion = (v: string) => {
    const m = semver.exec(v);
    if (!m) throw new Error(`not semver: ${v}`);
    const parts = [m[1], m[2], m[3]].map(Number);
    if (parts.some((p) => p > 0xffff)) throw new Error(`a part above 65535: ${v}`);
    return `${parts.join(".")}.0`;
  };
  const days = [new Date("2026-09-24T12:00:00Z"), new Date("2026-12-31T23:59:00Z"), new Date("2099-01-01T00:00:00Z")];
  for (const d of days) {
    expect(productVersion(dateVersion(d))).toBe(`${dateVersion(d)}.0`);
    expect(productVersion(nightlyVersion(d, "abc1234def"))).toBe(`${dateVersion(d)}.0`);
    expect(nightlyVersion(d, "abc1234def")).not.toContain("+");
  }
  expect(productVersion("2026.9.24-nightly.abc1234")).toBe("2026.9.24.0");
});

import { expect, test } from "vitest";
import { compareVersions, parseVersion } from "../core/version.ts";
import { byVersion, nightlyVersion, stableVersion } from "../scripts/release.ts";

function newer(current: string, candidate: string): boolean {
  const order = compareVersions(current, candidate);
  if (order === null) throw new Error(`not versions: ${current}, ${candidate}`);
  return order < 0;
}

test("release tags and plain versions parse alike", () => {
  expect(parseVersion("v0.3.0")).toEqual([0, 3, 0]);
  expect(parseVersion("0.3.0")).toEqual([0, 3, 0]);
  expect(parseVersion("nightly")).toBeNull();
});

test("newer means strictly after, per component", () => {
  expect(newer("0.3.0", "v0.3.1")).toBe(true);
  expect(newer("0.3.0", "0.4.0")).toBe(true);
  expect(newer("0.3.0", "1.0.0")).toBe(true);
  expect(newer("0.3.0", "0.3.0")).toBe(false);
  expect(newer("0.3.1", "0.3.0")).toBe(false);
});

test("YYYY.MMDD.N stables come after every YYYY.M.D one, and in order through months, years and same-day releases", () => {
  expect(newer("2026.10.11", "2026.1011.0")).toBe(true);
  expect(newer("2026.12.31", "2026.1011.0")).toBe(true);
  expect(newer("2026.1011.0", "2026.10.31")).toBe(false);
  const inOrder = [
    "2026.1011.0",
    "2026.1011.1",
    "2026.1011.10",
    "2026.1012.0",
    "2026.1031.0",
    "2026.1101.0",
    "2026.1231.3",
    "2027.101.0",
    "2027.131.0",
    "2027.201.0",
  ];
  for (let i = 1; i < inOrder.length; i++) {
    expect(newer(inOrder[i - 1], inOrder[i])).toBe(true);
    expect(newer(inOrder[i], inOrder[i - 1])).toBe(false);
  }
});

test("a stable is newer than the nightlies that led up to it, and no older stable is (AE4)", () => {
  expect(newer("2026.1120.0-nightly.4821", "2026.1120.0")).toBe(true);
  expect(newer("2026.1120.0-nightly.4821", "2026.1119.2")).toBe(false);
  expect(newer("2026.1120.0", "2026.1120.0-nightly.4821")).toBe(false);
});

test("nightlies of one stable order by run number, as numbers", () => {
  expect(newer("2026.1120.0-nightly.4821", "2026.1120.0-nightly.4822")).toBe(true);
  expect(newer("2026.1120.0-nightly.9999", "2026.1120.0-nightly.10000")).toBe(true);
  expect(newer("2026.1120.0-nightly.10000", "2026.1120.0-nightly.9999")).toBe(false);
  expect(newer("2026.1120.0-nightly.4821", "2026.1120.0-nightly.4821")).toBe(false);
});

test("prerelease ties break by semver: words above numbers, longer above shorter, build metadata ignored", () => {
  expect(compareVersions("2026.1011.1-nightly.a96ee85", "2026.1011.1-nightly.4821")).toBeGreaterThan(0);
  expect(compareVersions("1.0.0-nightly", "1.0.0-nightly.1")).toBeLessThan(0);
  expect(compareVersions("1.0.0+a", "1.0.0+b")).toBe(0);
  expect(compareVersions("1.0.0", "not a version")).toBeNull();
});

test("a nightly of the next stable is newer than the current stable", () => {
  expect(newer("2026.1120.0", "2026.1121.0-nightly.4900")).toBe(true);
  expect(newer("2026.1121.0-nightly.4900", "2026.1120.0")).toBe(false);
});

test("stables and nightlies sort together by precedence", () => {
  const shuffled = ["2026.1121.0-nightly.4900", "2026.1120.0", "2026.1120.0-nightly.10000", "2026.1119.2", "2026.1120.0-nightly.4821", "2026.1121.0"];
  expect([...shuffled].sort(byVersion)).toEqual([
    "2026.1119.2",
    "2026.1120.0-nightly.4821",
    "2026.1120.0-nightly.10000",
    "2026.1120.0",
    "2026.1121.0-nightly.4900",
    "2026.1121.0",
  ]);
});

// Outside (Windows): the NSIS installer's version resource is `VIProductVersion "M.m.p.B"`, written from the app's
// semver with the pre-release dropped, each part a 16-bit word; an MSI would reject a non-numeric pre-release, and
// loki builds no MSI.
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
    for (const n of [0, 1, 99]) expect(productVersion(stableVersion(d, n))).toBe(`${stableVersion(d, n)}.0`);
    for (const run of [1, 4821, 65536, 999999]) {
      expect(productVersion(nightlyVersion(stableVersion(d, 0), run))).toBe(`${stableVersion(d, 0)}.0`);
      expect(nightlyVersion(stableVersion(d, 0), run)).not.toContain("+");
    }
  }
  expect(productVersion("2026.1231.65535")).toBe("2026.1231.65535.0");
  expect(productVersion("2026.9.24-nightly.abc1234")).toBe("2026.9.24.0");
});

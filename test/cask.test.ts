import { describe, expect, test } from "vitest";
import { dmgName, renderCask } from "../scripts/cask.ts";
import { must } from "./fixtures/must.ts";

const sha = "a".repeat(64);

describe("homebrew cask", () => {
  test("points at the release's Apple silicon dmg and carries its checksum", () => {
    const rb = renderCask({ owner: "example", version: "2026.9.28", sha256: sha });
    expect(rb).toContain('cask "loki" do');
    expect(rb).toContain('version "2026.9.28"');
    expect(rb).toContain(`sha256 "${sha}"`);
    expect(rb).toContain('url "https://github.com/example/loki/releases/download/v#{version}/loki_#{version}_aarch64.dmg"');
    expect(rb).toContain('homepage "https://github.com/example/loki"');
    expect(rb).toContain('app "loki.app"');
    expect(rb).toContain("strategy :github_latest");
    expect(rb).toContain('conflicts_with cask: "example/loki/loki-nightly"');
    expect(dmgName("2026.9.28")).toBe("loki_2026.9.28_aarch64.dmg");
  });

  test("the nightly cask follows the rolling prerelease and conflicts with the stable one", () => {
    const rb = renderCask({ owner: "example", version: "2026.1011.1-nightly.4821", sha256: sha, channel: "nightly" });
    expect(rb).toContain('cask "loki-nightly" do');
    expect(rb).toContain('version "2026.1011.1-nightly.4821"');
    expect(rb).toContain('url "https://github.com/example/loki/releases/download/nightly/loki_#{version}_aarch64.dmg"');
    expect(rb).toContain('name "loki nightly"');
    expect(rb).toContain('conflicts_with cask: "example/loki/loki"');
    expect(rb).toContain("skip");
    expect(rb).not.toContain("github_latest");
    expect(rb).toContain('app "loki.app"');
    expect(rb).not.toContain("depends_on formula");
    expect(() => renderCask({ owner: "example", version: "2026.9.28", sha256: sha, channel: "nightly" })).toThrow(/nightly version/);
    expect(() => renderCask({ owner: "example", version: "2026.1011.1-nightly.4821", sha256: sha })).toThrow(/version/);
  });

  test("matches the app's floor and knows what loki leaves behind", () => {
    const rb = renderCask({ owner: "example", version: "2026.9.28", sha256: sha });
    expect(rb).toContain("depends_on arch: :arm64");
    expect(rb).toContain("depends_on macos: :ventura"); // tauri.conf.json: minimumSystemVersion 13.0; Homebrew 7 deprecates the ">= :ventura" string form
    expect(rb).not.toContain("depends_on formula");
    for (const p of ["~/.loki", "~/.agents/skills/loki"]) expect(rb).toContain(`"${p}"`);
    expect(rb).not.toContain(".letta");
    expect(rb).toContain("xattr -dr com.apple.quarantine /Applications/loki.app");
    expect(rb).not.toContain("--no-quarantine"); // gone from Homebrew 7: "invalid option"
  });

  test("both casks say the app updates itself, so brew upgrade leaves a running loki to its own updater (R19)", () => {
    for (const channel of ["stable", "nightly"] as const) {
      const rb = renderCask({ owner: "example", version: channel === "stable" ? "2026.1116.0" : "2026.1116.0-nightly.4900", sha256: sha, channel });
      expect(rb, channel).toContain("  auto_updates true\n");
      expect(rb, channel).toContain("xattr -dr com.apple.quarantine /Applications/loki.app");
      expect(rb.indexOf("auto_updates"), channel).toBeLessThan(rb.indexOf("conflicts_with")); // Homebrew's stanza order
    }
  });

  test("the nightly cask is deprecated toward the loki cask and the in-app Nightly channel; the stable one is not (R20)", () => {
    const rb = renderCask({ owner: "example", version: "2026.1116.0-nightly.4900", sha256: sha, channel: "nightly" });
    const line = must(
      rb.split("\n").find((l) => l.trimStart().startsWith("deprecate!")),
      "the deprecate! line",
    );
    expect(line).toMatch(/^ {2}deprecate! date: "2026-11-16", because: "[^"]+"$/);
    expect(line).toContain("loki cask");
    expect(line).toContain("Nightly");
    // after livecheck, before auto_updates: Homebrew's stanza order
    expect(rb.indexOf("livecheck do")).toBeLessThan(rb.indexOf("deprecate!"));
    expect(rb.indexOf("deprecate!")).toBeLessThan(rb.indexOf("auto_updates"));
    expect(renderCask({ owner: "example", version: "2026.1116.0", sha256: sha })).not.toContain("deprecate!");
  });

  test("refuses input that would render a broken cask", () => {
    expect(() => renderCask({ owner: "example", version: "v2026.9.28", sha256: sha })).toThrow(/version/);
    expect(() => renderCask({ owner: "example", version: "2026.9.28", sha256: "abc" })).toThrow(/sha256/);
    expect(() => renderCask({ owner: "bad owner", version: "2026.9.28", sha256: sha })).toThrow(/owner/);
  });
});

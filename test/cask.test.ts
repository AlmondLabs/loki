import { describe, expect, test } from "bun:test";
import { dmgName, renderCask } from "../scripts/cask.ts";

const sha = "a".repeat(64);

describe("homebrew cask", () => {
  test("points at the release's universal dmg and carries its checksum", () => {
    const rb = renderCask({ owner: "example", version: "2026.9.28", sha256: sha });
    expect(rb).toContain('cask "loki" do');
    expect(rb).toContain('version "2026.9.28"');
    expect(rb).toContain(`sha256 "${sha}"`);
    expect(rb).toContain('url "https://github.com/example/loki/releases/download/v#{version}/loki_#{version}_universal.dmg"');
    expect(rb).toContain('homepage "https://github.com/example/loki"');
    expect(rb).toContain('app "loki.app"');
    expect(rb).toContain("strategy :github_latest");
    expect(rb).toContain('conflicts_with cask: "example/loki/loki-nightly"');
    expect(dmgName("2026.9.28")).toBe("loki_2026.9.28_universal.dmg");
  });

  test("the nightly cask follows the rolling prerelease and conflicts with the stable one", () => {
    const rb = renderCask({ owner: "example", version: "2026.9.28-nightly.a96ee85", sha256: sha, channel: "nightly" });
    expect(rb).toContain('cask "loki-nightly" do');
    expect(rb).toContain('version "2026.9.28-nightly.a96ee85"');
    expect(rb).toContain('url "https://github.com/example/loki/releases/download/nightly/loki_#{version}_universal.dmg"');
    expect(rb).toContain('name "loki nightly"');
    expect(rb).toContain('conflicts_with cask: "example/loki/loki"');
    expect(rb).toContain("skip"); // no livecheck against a rolling tag
    expect(rb).not.toContain("github_latest");
    expect(rb).toContain('app "loki.app"'); // the same app, so the same zap list and caveat
    expect(() => renderCask({ owner: "example", version: "2026.9.28", sha256: sha, channel: "nightly" })).toThrow(/nightly version/);
    expect(() => renderCask({ owner: "example", version: "2026.9.28-nightly.a96ee85", sha256: sha })).toThrow(/version/);
  });

  test("matches the app's floor and knows what loki leaves behind", () => {
    const rb = renderCask({ owner: "example", version: "2026.9.28", sha256: sha });
    expect(rb).toContain("depends_on macos: :ventura"); // tauri.conf.json: minimumSystemVersion 13.0; Homebrew 7 deprecates the ">= :ventura" string form
    expect(rb).toContain('depends_on formula: "node"'); // npm for the Letta Code install on first launch; not bun (a dev tool), not letta-code (the formula lags npm)
    expect(rb).not.toContain("letta-code");
    for (const p of ["~/.letta/loki", "~/.letta/mods/loki.ts", "~/.agents/skills/loki"]) expect(rb).toContain(`"${p}"`);
    expect(rb).toContain("xattr -dr com.apple.quarantine /Applications/loki.app");
    expect(rb).not.toContain("--no-quarantine"); // gone from Homebrew 7: "invalid option"
  });

  test("refuses input that would render a broken cask", () => {
    expect(() => renderCask({ owner: "example", version: "v2026.9.28", sha256: sha })).toThrow(/version/);
    expect(() => renderCask({ owner: "example", version: "2026.9.28", sha256: "abc" })).toThrow(/sha256/);
    expect(() => renderCask({ owner: "bad owner", version: "2026.9.28", sha256: sha })).toThrow(/owner/);
  });
});

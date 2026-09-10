import { describe, expect, test } from "bun:test";
import { dmgName, renderCask } from "../scripts/cask.ts";

const sha = "a".repeat(64);

describe("homebrew cask", () => {
  test("points at the release's universal dmg and carries its checksum", () => {
    const rb = renderCask({ owner: "example", version: "0.3.0", sha256: sha });
    expect(rb).toContain('cask "loki" do');
    expect(rb).toContain('version "0.3.0"');
    expect(rb).toContain(`sha256 "${sha}"`);
    expect(rb).toContain('url "https://github.com/example/loki/releases/download/v#{version}/loki_#{version}_universal.dmg"');
    expect(rb).toContain('homepage "https://github.com/example/loki"');
    expect(rb).toContain('app "loki.app"');
    expect(dmgName("0.3.0")).toBe("loki_0.3.0_universal.dmg");
  });

  test("matches the app's floor and knows what loki leaves behind", () => {
    const rb = renderCask({ owner: "example", version: "0.3.0", sha256: sha });
    expect(rb).toContain('depends_on macos: ">= :ventura"'); // tauri.conf.json: minimumSystemVersion 13.0
    for (const p of ["~/.letta/loki", "~/.letta/mods/loki.ts", "~/.agents/skills/loki"]) expect(rb).toContain(`"${p}"`);
    expect(rb).toContain("--no-quarantine");
  });

  test("refuses input that would render a broken cask", () => {
    expect(() => renderCask({ owner: "example", version: "v0.3.0", sha256: sha })).toThrow(/version/);
    expect(() => renderCask({ owner: "example", version: "0.3.0", sha256: "abc" })).toThrow(/sha256/);
    expect(() => renderCask({ owner: "bad owner", version: "0.3.0", sha256: sha })).toThrow(/owner/);
  });
});

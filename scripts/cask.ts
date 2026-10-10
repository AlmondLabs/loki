// The Homebrew cask for a release: `npm run cask -- <owner> <version> <sha256> [stable|nightly]` prints
// Casks/loki.rb, or Casks/loki-nightly.rb for the rolling nightly. .github/workflows/release.yml runs it after
// each build and pushes the result to <owner>/homebrew-loki. The two casks conflict: loki shares its state
// (~/.loki), its daemon and the mod's ports between builds, so one loki is installed at a time.
// The app is not signed, and Homebrew 7 dropped --no-quarantine, so the caveat (and the README) give the one
// xattr line that lets macOS open it; Settings › Privacy & Security › Open Anyway is the other way.
// The cask depends on the `node` formula: loki's daemon runs on Node 22.19 or newer, so a Mac with nothing on it
// gets Node from Homebrew.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export type Channel = "stable" | "nightly";
export type CaskInput = { owner: string; version: string; sha256: string; channel?: Channel };

/** The dmg the release workflow attaches (tauri's `--target universal-apple-darwin`). */
export function dmgName(version: string): string {
  return `loki_${version}_universal.dmg`;
}

export function renderCask({ owner, version, sha256, channel = "stable" }: CaskInput): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(owner)) throw new Error(`not a GitHub owner: ${owner}`);
  if (channel === "stable" && !/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`not a version: ${version} (expected 2026.9.28, no v)`);
  if (channel === "nightly" && !/^\d+\.\d+\.\d+-nightly\.[0-9a-f]{7,40}$/.test(version)) throw new Error(`not a nightly version: ${version} (expected 2026.9.28-nightly.a96ee85)`);
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error(`not a sha256: ${sha256}`);
  const nightly = channel === "nightly";
  const tag = nightly ? "nightly" : "v#{version}";
  return `cask "${nightly ? "loki-nightly" : "loki"}" do
  version "${version}"
  sha256 "${sha256}"

  url "https://github.com/${owner}/loki/releases/download/${tag}/${dmgName("#{version}")}"
  name "${nightly ? "loki nightly" : "loki"}"
  desc "Agents with a canvas, an inbox, a board and recall cards${nightly ? " — built from every merge" : ""}"
  homepage "https://github.com/${owner}/loki"

${nightly
    ? `  livecheck do
    skip "a rolling prerelease; the cask is rewritten on every merge"
  end`
    : `  livecheck do
    url :url
    strategy :github_latest
  end`}

  # One loki at a time: both builds share ~/.loki and the mod's port.
  conflicts_with cask: "${owner}/loki/${nightly ? "loki" : "loki-nightly"}"

  depends_on macos: :ventura
  # loki's daemon runs on Node 22.19 or newer (docs/manual.md › Requirements).
  depends_on formula: "node"

  app "loki.app"

  zap trash: [
    "~/.agents/skills/loki",
    "~/.loki",
    "~/.letta/loki",
  ]

  caveats <<~EOS
    loki is not signed with an Apple Developer ID, so macOS will call the download "damaged" the
    first time. Clear the quarantine flag once and it opens:
      xattr -dr com.apple.quarantine /Applications/loki.app
    (or open it, dismiss the dialog, and allow it under System Settings › Privacy & Security).
  EOS
end
`;
}

// Run as a script, not imported by its test.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [owner, version, sha256, channel = "stable"] = process.argv.slice(2);
  if (!owner || !version || !sha256 || (channel !== "stable" && channel !== "nightly")) {
    console.error("usage: npm run cask -- <owner> <version> <sha256> [stable|nightly]");
    process.exit(2);
  }
  process.stdout.write(renderCask({ owner, version, sha256, channel }));
}

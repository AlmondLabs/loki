// The Homebrew cask for a release: `bun scripts/cask.ts <owner> <version> <sha256> [stable|nightly]` prints
// Casks/loki.rb, or Casks/loki-nightly.rb for the rolling nightly. .github/workflows/release.yml runs it after
// each build and pushes the result to <owner>/homebrew-loki. The two casks conflict: loki shares its state, its
// mod shim and its harness port between builds, so one loki is installed at a time.
// The app is not signed, and Homebrew 7 dropped --no-quarantine, so the caveat (and the README) give the one
// xattr line that lets macOS open it; Settings › Privacy & Security › Open Anyway is the other way.
// The cask depends on the `node` formula: loki installs Letta Code with `npm install -g` on first launch, so a
// Mac with nothing on it gets Node (and npm) from Homebrew and Letta Code from npm's newest release.

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
  desc "Desk, inbox, board and recall cards around Letta Code${nightly ? " — built from every merge" : ""}"
  homepage "https://github.com/${owner}/loki"

${nightly
    ? `  livecheck do
    skip "a rolling prerelease; the cask is rewritten on every merge"
  end`
    : `  livecheck do
    url :url
    strategy :github_latest
  end`}

  # One loki at a time: both builds share ~/.letta/loki, the mod shim and the harness port.
  conflicts_with cask: "${owner}/loki/${nightly ? "loki" : "loki-nightly"}"

  depends_on macos: :ventura
  # Letta Code is installed with npm on first launch (docs/manual.md › Requirements); Node brings npm.
  depends_on formula: "node"

  app "loki.app"

  zap trash: [
    "~/.agents/skills/loki",
    "~/.letta/loki",
    "~/.letta/mods/loki.ts",
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

if (import.meta.main) {
  const [owner, version, sha256, channel = "stable"] = process.argv.slice(2);
  if (!owner || !version || !sha256 || (channel !== "stable" && channel !== "nightly")) {
    console.error("usage: bun scripts/cask.ts <owner> <version> <sha256> [stable|nightly]");
    process.exit(2);
  }
  process.stdout.write(renderCask({ owner, version, sha256, channel }));
}

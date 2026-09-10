// The Homebrew cask for a release: `bun scripts/cask.ts <owner> <version> <sha256>` prints Casks/loki.rb.
// .github/workflows/cask.yml runs it when a release is published and pushes the result to <owner>/homebrew-loki.
// The app is not signed, so the cask's caveat and the README both say to install with --no-quarantine.

export type CaskInput = { owner: string; version: string; sha256: string };

/** The dmg the release workflow attaches (tauri's `--target universal-apple-darwin`). */
export function dmgName(version: string): string {
  return `loki_${version}_universal.dmg`;
}

export function renderCask({ owner, version, sha256 }: CaskInput): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(owner)) throw new Error(`not a GitHub owner: ${owner}`);
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`not a version: ${version} (expected 1.2.3, no v)`);
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error(`not a sha256: ${sha256}`);
  return `cask "loki" do
  version "${version}"
  sha256 "${sha256}"

  url "https://github.com/${owner}/loki/releases/download/v#{version}/${dmgName("#{version}")}"
  name "loki"
  desc "Desk, inbox, board and recall cards around Letta Code"
  homepage "https://github.com/${owner}/loki"

  livecheck do
    url :url
    strategy :github_latest
  end

  depends_on macos: ">= :ventura"

  app "loki.app"

  zap trash: [
    "~/.agents/skills/loki",
    "~/.letta/loki",
    "~/.letta/mods/loki.ts",
  ]

  caveats <<~EOS
    loki is not signed with an Apple Developer ID. If macOS says it is damaged, the download was
    quarantined: run \`xattr -dr com.apple.quarantine /Applications/loki.app\` once, or reinstall with
      brew reinstall --cask --no-quarantine loki
  EOS
end
`;
}

if (import.meta.main) {
  const [owner, version, sha256] = process.argv.slice(2);
  if (!owner || !version || !sha256) {
    console.error("usage: bun scripts/cask.ts <owner> <version> <sha256>");
    process.exit(2);
  }
  process.stdout.write(renderCask({ owner, version, sha256 }));
}

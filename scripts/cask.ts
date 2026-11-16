// The Homebrew cask for a release: `npm run cask -- <owner> <version> <sha256> [stable|nightly]` prints
// Casks/loki.rb, or Casks/loki-nightly.rb for the rolling nightly. .github/workflows/release.yml runs it after
// each build and pushes the result to <owner>/homebrew-loki. The two casks conflict: loki shares its state
// (~/.loki), its daemon and the mod's ports between builds, so one loki is installed at a time.
// The dmg is built for Apple silicon only, so both casks declare `depends_on arch: :arm64`.
// The app is not signed, and Homebrew 7 dropped --no-quarantine, so the caveat (and the README) give the one
// xattr line that lets macOS open it; System Settings › Privacy & Security › Open Anyway is the other way.
// Both casks declare `auto_updates`: loki replaces itself through its signed updater, so `brew upgrade` leaves a
// running loki alone, and it fetches the Node its daemon runs on, so neither depends on Homebrew's (plan
// 2026-11-15-2319, U6). One last `brew upgrade` brings a loki from before that to the self-updating version. The
// nightly cask is deprecated: the Nightly channel in loki's About replaces it, and it keeps being rendered only so that
// last upgrade reaches the people on it.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Which cask to write: loki for the stables, loki-nightly for the rolling nightly. */
export type Channel = "stable" | "nightly";
/** What a cask is made from: the GitHub owner of the loki repo, the version without its v, and the dmg's sha256. */
export interface CaskInput {
  owner: string;
  version: string;
  sha256: string;
  channel?: Channel;
}

/** The day the nightly cask was deprecated, fixed so every nightly renders the same stanza. */
export const NIGHTLY_DEPRECATED = "2026-11-16";

/** The dmg the release workflow attaches (tauri's `--target aarch64-apple-darwin`: loki ships for Apple silicon only). */
export function dmgName(version: string): string {
  return `loki_${version}_aarch64.dmg`;
}

/** The cask's Ruby, as Casks/loki.rb or Casks/loki-nightly.rb. Throws on an owner, version or sha256 that does not look right for the channel. */
export function renderCask({ owner, version, sha256, channel = "stable" }: CaskInput): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(owner)) throw new Error(`not a GitHub owner: ${owner}`);
  if (channel === "stable" && !/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`not a version: ${version} (expected 2026.1011.0, no v)`);
  if (channel === "nightly" && !/^\d+\.\d+\.\d+-nightly\.[1-9]\d*$/.test(version))
    throw new Error(`not a nightly version: ${version} (expected 2026.1011.1-nightly.4821)`);
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error(`not a sha256: ${sha256}`);
  const nightly = channel === "nightly";
  const tag = nightly ? "nightly" : "v#{version}";
  return `cask "${nightly ? "loki-nightly" : "loki"}" do
  version "${version}"
  sha256 "${sha256}"

  url "https://github.com/${owner}/loki/releases/download/${tag}/${dmgName("#{version}")}"
  name "${nightly ? "loki nightly" : "loki"}"
  desc "Agents with a canvas, an inbox, a task list and recall cards${nightly ? " — built from every merge" : ""}"
  homepage "https://github.com/${owner}/loki"

${
  nightly
    ? `  livecheck do
    skip "a rolling prerelease; the cask is rewritten on every merge"
  end`
    : `  livecheck do
    url :url
    strategy :github_latest
  end`
}
${
  nightly
    ? `
  # Homebrew finishes the sentence: "has been deprecated because it …".
  deprecate! date: "${NIGHTLY_DEPRECATED}", because: "is replaced by the loki cask and the Nightly channel in loki's About"
`
    : ""
}
  # loki replaces itself through its signed updater; brew upgrade leaves it to that.
  auto_updates true

  # One loki at a time: both builds share ~/.loki and the mod's port.
  conflicts_with cask: "${owner}/loki/${nightly ? "loki" : "loki-nightly"}"

  # Apple silicon only: Homebrew refuses an Intel Mac with its own message.
  depends_on arch: :arm64
  depends_on macos: :ventura

  app "loki.app"

  zap trash: [
    "~/.agents/skills/loki",
    "~/.loki",
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

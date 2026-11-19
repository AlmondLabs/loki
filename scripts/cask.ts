import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export type Channel = "stable" | "nightly";
export interface CaskInput {
  owner: string;
  version: string;
  sha256: string;
  channel?: Channel;
}

export const NIGHTLY_DEPRECATED = "2026-11-16";

export function dmgName(version: string): string {
  return `loki_${version}_aarch64.dmg`;
}

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

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [owner, version, sha256, channel = "stable"] = process.argv.slice(2);
  if (!owner || !version || !sha256 || (channel !== "stable" && channel !== "nightly")) {
    console.error("usage: bun run cask <owner> <version> <sha256> [stable|nightly]");
    process.exit(2);
  }
  process.stdout.write(renderCask({ owner, version, sha256, channel }));
}

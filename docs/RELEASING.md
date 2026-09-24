# Releasing loki

Nothing is tagged by hand. `.github/workflows/release.yml` runs on every push to `main` (and at midnight UTC,
and on request from the Actions tab) and `scripts/release.ts` decides what the run does. There are two channels
and one release PR.

## How a change ships

1. **Merge a PR into `main`.** About twenty minutes later there is a new **nightly**: the universal `.dmg`, the
   Windows installer and the Linux AppImage and `.deb` on the rolling `nightly` prerelease, and
   `Casks/loki-nightly.rb` in the tap. Anyone on
   `brew install --cask almondlabs/loki/loki-nightly` gets it with `brew upgrade`. Only the newest merge matters:
   a nightly build still running is cancelled when the next merge lands.
2. **The same merge creates or refreshes the release PR**, branch `release/next`, titled "release: 2026.9.28":
   one commit that bumps the version files and prepends the notes to `CHANGELOG.md`. Every further merge rebuilds
   it from `main`, so there is always exactly one, and its notes are everything since the last stable. Do not push
   to it; anything that should ship goes through an ordinary PR.
3. **Merge the release PR** when you want a stable. That merge builds once more, tags `v2026.9.28`, publishes the
   release (not a draft) with every system's files and the rendered cask attached, and pushes `Casks/loki.rb` to
   the tap.
   `brew upgrade --cask loki` follows. That merge produces no nightly; the stable is that build.

## What a release run builds

One run of `release.yml`, whatever the channel:

1. **plan** (`bun scripts/release.ts plan`) decides stable, nightly, repush or nothing, and the version.
2. **Three build jobs**, one per system, each stamping the version (`release.ts set`) and uploading its files as
   an artifact:

   | job | runner | how | files |
   |---|---|---|---|
   | macOS | `macos-14` | `tauri-apps/tauri-action@v0`, `--target universal-apple-darwin` | `loki_<v>_universal.dmg` |
   | Windows | `windows-latest` | `bun run tauri build --bundles nsis` | `loki_<v>_x64-setup.exe` |
   | Linux | `ubuntu-22.04` | the WebKitGTK apt packages, then `bun run tauri build --bundles appimage,deb` | `loki_<v>_amd64.AppImage`, `loki_<v>_amd64.deb` |

   Linux builds on the oldest supported Ubuntu so the files run on newer glibc too; the apt list is the same as
   `ci.yml`'s. A nightly's version builds the NSIS installer as it is: the installer's numeric product version
   drops the `-nightly.<sha>` part.
3. **publish** waits for all three (a release is never missing a system), downloads every artifact and calls
   `release.ts publish` once with all of them. It has to be once: a nightly deletes and recreates the rolling
   release, so a second upload from another job would race it. Then it renders the cask from the `.dmg`, attaches
   `cask.rb` to the release and pushes it to the tap.

Every set of notes starts with the preview line (`previewLine` in `scripts/release.ts`): Windows and Linux are
built and tested in CI, not yet tried on real machines, with the issues link. It lands in the release, the release
PR's body and `CHANGELOG.md`. Take it out of `previewLine` when people have confirmed the builds, and the README's
and Settings' preview notes with it. [preview-checklist.md](preview-checklist.md) is what to ask them to try.

## Versions

The calendar is the version. A stable is `YYYY.M.D` of the day its release PR is merged, in UTC, without leading
zeros: `2026.9.28`, then `2026.10.2`. A nightly is that day plus the merge it was built from:
`2026.9.28-nightly.a96ee85`. Both are three integers, so semver, macOS and Homebrew all order them, and the app's
own check for a newer release keeps working (`core/version.ts`).

- **Tags are the source of truth.** The newest `v*` tag is the current stable; `package.json`,
  `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` (and the lockfile) hold that same number between releases.
  Only the release PR changes them; a checkout therefore shows the last stable in Settings and stays quiet about
  updates. A nightly build gets its number stamped on the runner and nothing is committed.
- **One stable a day.** A version has three integer slots and the date uses all of them. A second release PR
  merged on the same day ships nothing: the workflow leaves the PR open proposing tomorrow's date, and the merge
  still made a nightly.
- **The number tracks the calendar.** The release PR's number goes stale at midnight, so the midnight run refreshes
  it. If a release PR is merged with yesterday's number anyway (a merge in the minute after midnight), the run does
  not tag: it force-pushes the PR with today's number and asks for one more merge. Nothing wrong ever ships.
- The version says nothing about compatibility. The release notes carry that; a `breaking` word in a PR title is
  the convention if you want one.

Before merging a release PR, retest against npm's newest Letta Code (`npm view @letta-ai/letta-code version`) and
move `TESTED_LETTA_CODE` in `core/compat.ts` in an ordinary PR if it has moved. That is the one step a machine
cannot do.

## The release PR and CI

The workflow pushes the release branch with its own token, and pushes made with that token do not start other
workflows, so `ci.yml` does not run on the release PR by default. Its content is version numbers and a changelog,
and the stable build compiles and bundles everything before anything is published. If you want CI on it anyway,
add a fine-grained token with *Contents* and *Pull requests* write access to this repository as the
**`RELEASE_TOKEN`** secret; the workflow prefers it when present.

Merging the release PR needs the same one approval as any PR (the `requires-pr` ruleset). The PR's author is the
Actions bot, so you can approve it yourself.

## Homebrew tap (one-time setup)

The app is not signed (next section), so Homebrew is the recommended install: `brew install --cask
almondlabs/loki/loki`, then `xattr -dr com.apple.quarantine /Applications/loki.app` once. Homebrew quarantines
cask downloads exactly like a browser would, and Homebrew 7 removed the `--no-quarantine` flag that used to skip
it, so the cask's caveat and the README both give the `xattr` line. The two casks conflict with each other: both
builds share `~/.letta/loki`, the mod shim and the harness port, so one loki is installed at a time and switching
channels is `brew uninstall --cask loki && brew install --cask almondlabs/loki/loki-nightly` (or back).

1. Create an empty public repository named **`homebrew-loki`** under the same owner as this repo (Homebrew
   resolves `<owner>/loki` to it). No files needed; the workflow adds `Casks/loki.rb` and `Casks/loki-nightly.rb`.
2. Create a token that can push to it: GitHub → Settings → Developer settings → Fine-grained tokens, repository
   access `homebrew-loki` only, permission *Contents: read and write*.
3. Add it to this repository's secrets as **`TAP_TOKEN`**.

Without the secret the workflow renders the cask, attaches it to the release, then fails at the push with a message
naming the secret; copy the file into the tap by hand and nothing else is lost. `scripts/cask.ts` is the template
(`bun scripts/cask.ts <owner> <version> <sha256> [stable|nightly]`), covered by `test/cask.test.ts`.

## Signing (one-time setup)

Without signing, macOS blocks the downloaded app as "damaged"; people must run
`xattr -dr com.apple.quarantine /Applications/loki.app` or allow it in System Settings › Privacy & Security
(right-click → Open no longer helps on macOS 14 and later, and Homebrew 7 has no `--no-quarantine`).
Signing needs an Apple Developer Program membership (paid, yearly).

The Windows and Linux files are unsigned too, and the workflow has no secrets for them: Windows' SmartScreen
asks for **More info → Run anyway** once, and the AppImage needs `chmod +x`. Code-signing either is deferred.

1. In Xcode or developer.apple.com, create a **Developer ID Application** certificate and export it with
   its private key as a `.p12` with a password.
2. Create an **app-specific password** for your Apple ID at appleid.apple.com (notarization logs in
   with it, never your real password).
3. Add these repository secrets (Settings → Secrets and variables → Actions):

   | secret | value |
   |---|---|
   | `APPLE_CERTIFICATE` | `base64 -i cert.p12 \| pbcopy` |
   | `APPLE_CERTIFICATE_PASSWORD` | the `.p12` password |
   | `APPLE_SIGNING_IDENTITY` | `Developer ID Application: Your Name (TEAMID)` |
   | `APPLE_ID` | the Apple ID email |
   | `APPLE_PASSWORD` | the app-specific password |
   | `APPLE_TEAM_ID` | the 10-character team id |

4. Change `identifier` in `src-tauri/tauri.conf.json` if you do not own the current reverse-DNS name;
   notarization ties the app to it, and changing it later resets the app's data directory.

The workflow exports the six as env vars only when `APPLE_CERTIFICATE` is set (a step before the build); Tauri
signs whenever that variable exists, even empty, so passing missing secrets straight through would fail the bundle
with "failed to import keychain certificate", as the first release attempt did. Without the secrets the build
succeeds unsigned. Both channels are signed the same way.

## Building locally

`bun run desktop:build` produces the `.app` and the `.dmg` under `src-tauri/target/release/bundle/`, at the version
the files hold (the last stable). The `.dmg` step drives Finder through AppleScript to lay out the window; from a
terminal without Automation permission for Finder (an SSH session, an agent's shell) it fails with `Finder got an
error: AppleEvent timed out`. The `.app` is complete at that point; make the image without the Finder pass:

```bash
cd src-tauri/target/release/bundle/macos
../dmg/bundle_dmg.sh --skip-jenkins --volname loki --icon loki.app 180 170 --app-drop-link 480 170 \
  --window-size 660 400 --hide-extension loki.app --volicon ../dmg/icon.icns \
  ../dmg/loki_2026.9.28_aarch64.dmg loki.app
```

On Windows or Linux, `bun run tauri build --bundles nsis` or `bun run tauri build --bundles appimage,deb` makes the
same files as the release, under `src-tauri/target/release/bundle/nsis/`, `appimage/` and `deb/` (the Linux build
needs the apt packages in `ci.yml`). Neither needs the Finder workaround.

`bun scripts/release.ts plan` says what the workflow would do for the checkout as it stands, and
`bun scripts/release.ts notes` prints the notes the release PR would carry. Neither writes anything.

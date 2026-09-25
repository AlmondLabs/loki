# Releasing loki

Nothing is tagged by hand. `.github/workflows/release.yml` runs on every push to `main` (and at midnight UTC,
and on request from the Actions tab) and `scripts/release.ts` decides what the run does. There are two channels,
nightly (the Mac's alone) and stable, and two PRs the workflow keeps for you, both for the same day's version: the
release PR, which ships the Mac's stable, and the Windows and Linux PR, which ships their files for that version.
Merge them in either order: the first creates the day's release, the second adds its files to it.

## How a change ships

1. **Merge a PR into `main`.** About twenty minutes later there is a new **nightly**: the universal `.dmg` on the
   rolling `nightly` prerelease, and `Casks/loki-nightly.rb` in the tap. Nightlies are Mac-only. Anyone on
   `brew install --cask almondlabs/loki/loki-nightly` gets it with `brew upgrade`. Only the newest merge matters:
   a nightly build still running is cancelled when the next merge lands.
2. **The same merge creates or refreshes both release PRs**, each one commit on top of `main`, rebuilt from `main`
   and force-pushed by every further merge and by the midnight run, so there is always exactly one of each and
   their number is today's date. Do not push to either; anything that should ship goes through an ordinary PR.
   1. **The release PR**, branch `release/next`, titled "release: 2026.9.28": it bumps the version files and
      prepends the notes to `CHANGELOG.md`; its notes are everything since the last stable.
   2. **The Windows and Linux PR**, branch `release/preview`, titled "release: Windows and Linux 2026.9.28": it
      writes `v2026.9.28` to `.github/preview.txt`. It is closed while that day's release already has its Windows
      and Linux files, and moves to the new date at midnight like the release PR.
3. **Merge the release PR** when you want the Mac's stable. That merge builds once more and publishes
   `v2026.9.28` with the `.dmg` and the rendered cask attached, marked latest, and pushes `Casks/loki.rb` to the tap.
   `brew upgrade --cask loki` follows. That merge produces no nightly; the stable is that build.
4. **Merge the Windows and Linux PR** when you want Windows and Linux. The merge builds `main` as it is at that
   merge on Windows and Linux, stamps `2026.9.28`, and puts the `-setup.exe`, the AppImage and the `.deb` on
   `v2026.9.28`, with the preview line (below) at the top of its notes. It makes no nightly and touches neither the
   `.dmg` nor the casks.

### Either order

The two merges share `v2026.9.28`, and their files come from whatever `main` was at each merge: if something
landed between the two, the Mac's and the Windows and Linux files are built from different commits. That is
accepted; the version is the day, not a commit.

1. **The Mac first.** Its merge creates the tag at the release PR's merge and the release, as it always has. The
   Windows and Linux PR stays open for the same day (the release PR moves to tomorrow, one stable a day). Merging it
   uploads its files to the existing release with `--clobber` and adds the preview line to the notes.
2. **Windows and Linux first.** Its merge creates the tag **at its own merge commit** and a release with the Windows
   and Linux files and the notes since the last stable, **not marked latest** (`--latest=false`): GitHub's latest is
   what the Mac's update check, the `.dmg` link and the cask's livecheck read, and this release has no `.dmg` yet.
   The release PR stays at the same day. Merging it builds the Mac's stable as usual, uploads the `.dmg` and
   `cask.rb` to the existing release with `--clobber`, marks it latest and replaces the notes with the full stable
   notes and the preview line. The tag is not moved: it stays at the Windows and Linux merge, so `git checkout
   v2026.9.28` is that commit, not the release PR's (the `.dmg`'s code is the release PR's merge on `main`), and the
   next stable's notes count from the tag, so commits merged between the two merges are listed in both days' notes.
3. **Only one of them.** The midnight run (when there is anything since the last stable) moves both to the new
   day. A day whose Windows and Linux PR was never merged keeps a Mac-only release; a day whose release PR was never
   merged keeps a Windows and Linux release that is never latest. Windows and Linux find their newest file either
   way (Settings › letta reads the releases list, not latest). With nothing merged since the Mac's stable, no run
   refreshes the PRs, so the Windows and Linux PR still names that day and its merge joins that day's release.

## What a release run builds

1. **plan** (`bun scripts/release.ts plan`) decides stable, nightly, repush, preview or nothing, and the versions.
   It asks GitHub which stables the Mac has shipped: releases with a `.dmg` (a tag alone may be Windows and Linux's).
   The Windows and Linux PR landing is recognised by the push itself changing `.github/preview.txt` (only on a push:
   the midnight and manual runs never rebuild a preview), and is a preview of that version whatever else the merge
   carries. A release PR landing is recognised by the version files naming a date the Mac has not shipped, whether or
   not Windows and Linux made its tag already. Commits titled `release: …`, the two PRs' own, do not count as
   something to ship, so a Windows and Linux merge alone never makes a nightly. A Windows and Linux PR merged with an
   older day's number whose release does not exist (a merge in the minutes after midnight) ships nothing: both PRs
   are refreshed to today, as a stale release PR is.
2. **A nightly or a stable** is the Mac's: one `macos-14` job builds the universal `.dmg` with
   `tauri-apps/tauri-action@v0` (`--target universal-apple-darwin`), publishes it with `release.ts publish`, renders
   the cask from it, attaches `cask.rb` to the release and pushes it to the tap. A nightly or a repush also runs
   **the release PR** and **the Windows and Linux PR** jobs (`release.ts release-pr`, `release.ts preview-pr`), both
   with the version `plan` gives: today's, except that the release PR moves to tomorrow once the Mac shipped today,
   while the Windows and Linux PR stays on today until that release has its files.
3. **A preview** is two build jobs, each checking out the merge, stamping the version (`release.ts set`) and
   uploading its files as an artifact, then **publish Windows and Linux**:

   | job | runner | how | files |
   |---|---|---|---|
   | Windows | `windows-latest` | `bun run tauri build --bundles nsis` | `loki_<v>_x64-setup.exe` |
   | Linux | `ubuntu-22.04` | the WebKitGTK apt packages, then `bun run tauri build --bundles appimage,deb` | `loki_<v>_amd64.AppImage`, `loki_<v>_amd64.deb` |

   Linux builds on the oldest supported Ubuntu so the files run on newer glibc too; the apt list is the same as
   `ci.yml`'s. The last job downloads whatever built and runs `release.ts attach v<v> <files…>`: with a release
   there, `gh release upload --clobber` (a re-run replaces rather than fails) and the preview line on top of the notes
   if they do not carry it yet; with none, `gh release create --target <merge> --latest=false`. It has its own queue
   (a shared one could drop a waiting Mac stable); if both merges find no release at once, the one whose create
   loses joins the release the other made. One system failing leaves only its files off, with a
   warning on the run. **Re-run its failed jobs** from the Actions tab to add them: the Windows and Linux PR does
   not reopen for a version `main` already records.

The preview line (`previewLine` in `scripts/release.ts`) says Windows and Linux are built and tested in CI, not
yet tried on real machines, with the issues link. It opens the Windows and Linux PR's body and the notes of a
release carrying their files; the release PR, `CHANGELOG.md` and the nightly do not carry it. Take it out of `previewLine` when
people have confirmed the builds, and the README's and Settings' preview notes with it.
[preview-checklist.md](preview-checklist.md) is what to ask them to try.

## Versions

The calendar is the version. A stable is `YYYY.M.D` of the day its release PR is merged, in UTC, without leading
zeros: `2026.9.28`, then `2026.10.2`. A nightly is that day plus the merge it was built from:
`2026.9.28-nightly.a96ee85`. Both are three integers, so semver, macOS and Homebrew all order them, and the app's
own check for a newer release keeps working (`core/version.ts`).

- **The releases are the source of truth.** The newest `v*` release with a `.dmg` is the current stable;
  `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` (and the lockfile) hold that same number
  between releases.
  Only the release PR changes them; a checkout therefore shows the last stable in Settings and stays quiet about
  updates. A nightly build gets its number stamped on the runner and nothing is committed.
- **One stable a day.** A version has three integer slots and the date uses all of them. A second release PR
  merged on the same day ships nothing: the workflow leaves the PR open proposing tomorrow's date, and the merge
  still made a nightly. The Windows and Linux PR closes once the day's release has its files and reopens for a later
  day on the next run that refreshes the release PR.
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
Actions bot, so you can approve it yourself. All of this holds for the Windows and Linux PR too.

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
`bun scripts/release.ts notes` prints the notes the release PR would carry. Neither writes anything; both ask
GitHub (`gh`, signed in) which releases carry a `.dmg`.

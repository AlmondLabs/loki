# Releasing loki

Nothing is tagged by hand. `.github/workflows/release.yml` runs on every push to `main` (and on request from the
Actions tab) and `scripts/release.ts` decides what the run does. There are two channels, nightly (the Mac's alone)
and stable, and two PRs the workflow keeps for you: the release PR, which ships the Mac's stable when it merges, and
the Windows and Linux PR, which puts their files on the newest stable. Neither carries a version number, so neither
goes stale, and nothing runs on a schedule.

## How a change ships

1. **Merge a PR into `main`.** About twenty minutes later there is a new **nightly**: the universal `.dmg` on the
   rolling `nightly` prerelease, and `Casks/loki-nightly.rb` in the tap. Nightlies are Mac-only. Anyone on
   `brew install --cask almondlabs/loki/loki-nightly` gets it with `brew upgrade`. Only the newest merge matters:
   a nightly build still running is cancelled when the next merge lands.
2. **The same merge creates or refreshes the release PR**, branch `release/next`, titled "release: the next
   stable": one commit on top of `main` that writes the `main` it was built from to `.github/release.txt`, and a body
   listing everything since the last stable and the number it would get if merged now. It is rebuilt from `main` and
   force-pushed by every further merge, and closed when nothing has merged since the last stable. Do not push to it;
   anything that should ship goes through an ordinary PR.
3. **Merge the release PR** whenever you want a stable, as often as you like. That merge builds once more, decides
   the number (below), and publishes `v2026.1011.0` with the `.dmg` and the rendered cask attached, marked latest,
   and pushes `Casks/loki.rb` to the tap. `brew upgrade --cask loki` follows. That merge produces no nightly; the
   stable is that build.
4. **The Windows and Linux PR** opens once the stable is out, branch `release/preview`, titled "release: Windows and
   Linux 2026.1011.0": it writes `v2026.1011.0` to `.github/preview.txt`. Merging it builds `main` as it is at that
   merge on Windows and Linux, stamps `2026.1011.0`, and puts the `-setup.exe`, the AppImage and the `.deb` on that
   release, with the preview line (below) at the top of its notes. It makes no nightly and touches neither the
   `.dmg` nor the casks. It is refreshed by every merge while that stable lacks the files, and closed once it has
   them. Anything merged between the stable and this PR is in the Windows and Linux files but not the `.dmg`; that is
   accepted, as it was before.

## What a release run builds

1. **plan** (`npm run release -- plan`) decides stable, nightly, preview or nothing. On a push, the release PR
   landing is recognised by the push itself changing `.github/release.txt`, and the Windows and Linux PR landing by
   it changing `.github/preview.txt` (a preview of the stable it names, when that release exists; nothing when it
   does not). Everything else with commits since the last stable is a nightly. Commits titled `release: …`, the two
   PRs' own, do not count as something to ship. A manual run only refreshes the two PRs.
2. **A nightly or a stable** is the Mac's: one `macos-14` job decides its number (`release.ts version`), stamps it
   (`release.ts set`), smoke-tests the bundle (`npm run smoke`: it starts and signs in, or nothing ships), builds the
   universal `.dmg` with `tauri-apps/tauri-action` (`--target universal-apple-darwin`),
   publishes it with `release.ts publish`, renders the cask from it, attaches `cask.rb` to the release and pushes it
   to the tap. A stable then offers **the Windows and Linux PR** for itself. A nightly runs **the release PRs** job
   (`release.ts release-pr`, then `release.ts preview-pr`) to refresh both. A merge of docs alone (`docs/**`, the
   root's `*.md`) starts no release run at all.
3. **A preview** is two build jobs, each checking out the merge, stamping the stable's version (`release.ts set`),
   smoke-testing the bundle and uploading its files as an artifact, then **publish Windows and Linux**:

   | job | runner | how | files |
   |---|---|---|---|
   | Windows | `windows-latest` | `npm run tauri -- build --bundles nsis` | `loki_<v>_x64-setup.exe` |
   | Linux | `ubuntu-22.04` | the WebKitGTK apt packages, then `npm run tauri -- build --bundles appimage,deb` | `loki_<v>_amd64.AppImage`, `loki_<v>_amd64.deb` |

   Linux builds on the oldest supported Ubuntu so the files run on newer glibc too; the apt list is the same as
   `ci.yml`'s. The last job downloads whatever built and runs `release.ts attach v<v> <files…>`:
   `gh release upload --clobber` (a re-run replaces rather than fails) and the preview line on top of the notes if
   they do not carry it yet. Windows and Linux never create a release. One system failing leaves only its files off,
   with a warning on the run. **Re-run its failed jobs** from the Actions tab to add them: the Windows and Linux PR does
   not reopen for a version `main` already records.

The preview line (`previewLine` in `scripts/release.ts`) says Windows and Linux are built and tested in CI, not
yet tried on real machines, with the issues link. It opens the Windows and Linux PR's body and the notes of a
release carrying their files; the release PR and the nightly do not carry it. Take it out of `previewLine` when
people have confirmed the builds, and the README's and Settings' preview notes with it.
[preview-checklist.md](preview-checklist.md) is what to ask them to try.

## Versions

A stable is `YYYY.MMDD.N`: the UTC year, then the month and the two-digit day (October 11 is `1011`, January 1 is
`101`), then that day's release count from 0. `2026.1011.0`, then `2026.1011.1` the same day, then `2026.1012.0`.
A nightly is the number of the stable it leads up to plus the merge it was built from: `2026.1011.1-nightly.a96ee85`.

- **The number is decided when the stable is built**, from the date and the stable tags, not written into the PR:
  the build job counts today's `vYYYY.MMDD.*` tags and takes the next. Stable builds run one at a time in their own
  queue, so a stable queued behind another sees its tag and takes the next number. GitHub keeps one waiting run per
  queue: of three release merges within a few minutes the middle one may be dropped, and the third, built from a
  later `main`, carries its changes. A stable never joins an existing release: if its number is somehow taken, the
  publish fails and a re-run numbers it again.
- **It sorts after everything before it.** All three parts are integers, so semver, Cargo, macOS bundle versions,
  Homebrew and the app's own update check (`core/version.ts`) order it, and Windows installers' limit of 65535 per
  part is never reached. A month and day (101 to 1231) outnumber a month (1 to 12), so `2026.1011.0` is newer than
  every `YYYY.M.D` stable shipped before October 2026 (the last was `2026.10.11`), and upgrades just work.
- **The tags are the truth.** `main` takes changes through PRs alone (the `requires-pr` ruleset), so nothing commits
  the number back: `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` (and the lockfile) keep the
  last number committed before releases moved to merges, and every build stamps its own on the runner. A checkout
  therefore shows that old number in Settings and may say a newer release exists; that is expected.
- **`CHANGELOG.md` is frozen at 2026.10.11.** Its headings would need the final number on `main`; each release's
  notes are on its GitHub release instead.
- The version says nothing about compatibility. The release notes carry that; a `breaking` word in a PR title is
  the convention if you want one.

## The release PR and CI

The workflow pushes the release branch with its own token, and pushes made with that token do not start other
workflows, so `ci.yml` does not run on the release PR by default, and it skips a PR whose only change is the release
PRs' marker files anyway. Its content is one marker file on top of `main`, which `ci` checked on each PR, and the stable build compiles and bundles everything before anything is published. If you want CI on it anyway,
add a fine-grained token with *Contents* and *Pull requests* write access to this repository as the
**`RELEASE_TOKEN`** secret; the workflow prefers it when present.

Merging the release PR needs the same one approval as any PR (the `requires-pr` ruleset). The PR's author is the
Actions bot, so you can approve it yourself. All of this holds for the Windows and Linux PR too.

## Homebrew tap (one-time setup)

The app is not signed (next section), so Homebrew is the recommended install: `brew install --cask
almondlabs/loki/loki`, then `xattr -dr com.apple.quarantine /Applications/loki.app` once. Homebrew quarantines
cask downloads exactly like a browser would, and Homebrew 7 removed the `--no-quarantine` flag that used to skip
it, so the cask's caveat and the README both give the `xattr` line. The two casks conflict with each other: both
builds share `~/.loki`, the daemon and the mod's ports, so one loki is installed at a time and switching
channels is `brew uninstall --cask loki && brew install --cask almondlabs/loki/loki-nightly` (or back).

1. Create an empty public repository named **`homebrew-loki`** under the same owner as this repo (Homebrew
   resolves `<owner>/loki` to it). No files needed; the workflow adds `Casks/loki.rb` and `Casks/loki-nightly.rb`.
2. Create a token that can push to it: GitHub → Settings → Developer settings → Fine-grained tokens, repository
   access `homebrew-loki` only, permission *Contents: read and write*.
3. Add it to this repository's secrets as **`TAP_TOKEN`**.

Without the secret the workflow renders the cask, attaches it to the release, then fails at the push with a message
naming the secret; copy the file into the tap by hand and nothing else is lost. `scripts/cask.ts` is the template
(`npm run cask -- <owner> <version> <sha256> [stable|nightly]`), covered by `test/cask.test.ts`.

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

`npm run desktop:build` produces the `.app` and the `.dmg` under `src-tauri/target/release/bundle/`, at the version
the files hold (not a release's: see Versions). The `.dmg` step drives Finder through AppleScript to lay out the window; from a
terminal without Automation permission for Finder (an SSH session, an agent's shell) it fails with `Finder got an
error: AppleEvent timed out`. The `.app` is complete at that point; make the image without the Finder pass:

```bash
cd src-tauri/target/release/bundle/macos
../dmg/bundle_dmg.sh --skip-jenkins --volname loki --icon loki.app 180 170 --app-drop-link 480 170 \
  --window-size 660 400 --hide-extension loki.app --volicon ../dmg/icon.icns \
  ../dmg/loki_local_aarch64.dmg loki.app
```

On Windows or Linux, `npm run tauri -- build --bundles nsis` or `npm run tauri -- build --bundles appimage,deb` makes the
same files as the release, under `src-tauri/target/release/bundle/nsis/`, `appimage/` and `deb/` (the Linux build
needs the apt packages in `ci.yml`). Neither needs the Finder workaround.

`npm run release -- plan` says what the workflow would do for the checkout as it stands,
`npm run release -- version stable` the number a stable built now would get, and `npm run release -- notes` the notes
the release PR would carry. None of them writes anything; `plan` and `notes` ask GitHub (`gh`, signed in) which
releases carry a `.dmg`.

# Releasing loki

Nothing is tagged by hand. `.github/workflows/release.yml` runs on every push to `main` (and on request from the
Actions tab) and `scripts/release.ts` decides what the run does. There are two channels, nightly and stable, and one
PR the workflow keeps for you: the release PR, which ships a stable when it merges. Every release, stable or nightly,
is built for the Mac, Windows and Linux in one run and carries the signed update files every loki installs from. The
release PR carries no version number, so it never goes stale. Nothing runs on a schedule.

## How a change ships

1. **Merge a PR into `main`.** About twenty minutes later there is a new **nightly**: the rolling `nightly` prerelease
   with every system's files (below) and its `latest.json`, and `Casks/loki-nightly.rb` in the tap. A loki on the
   Nightly channel (About) updates itself to it. Only the newest merge matters: a nightly still building or publishing
   is cancelled when the next merge's nightly reaches the same job.
2. **The same merge creates or refreshes the release PR**, branch `release/next`, titled "chore(release): the
   next stable": one commit on top of `main` that writes the `main` it was built from to `.github/release.txt`, and a body
   listing everything since the last stable and the number it would get if merged now. It is rebuilt from `main` and
   force-pushed by every further merge, and closed when nothing has merged since the last stable. Do not push to it;
   anything that should ship goes through an ordinary PR.
3. **Merge the release PR** whenever you want a stable, as often as you like. That merge builds once more, decides
   the number (below), and publishes `v2026.1011.0` with every system's files and the rendered cask attached, marked
   latest, and pushes `Casks/loki.rb` to the tap. Every loki on the Stable channel updates itself to it. That merge
   produces no nightly; the stable is that build.

The Windows and Linux PR (branch `release/preview`, which put those files on a stable after the Mac's) is retired:
every stable now carries all three. Its branch can be deleted, and its marker, `.github/preview.txt`, is gone.

## What a release run builds

1. **plan** (`npm run release -- plan`) decides stable, nightly or nothing. On a push, the release PR landing is
   recognised by the push itself changing `.github/release.txt`. Everything else with commits since the last stable
   is a nightly. Commits titled `chore(release): …` (or `release: …`, before October 2026), the release PR's own, do
   not count as something to ship. A merge of docs alone (`docs/**`, the root's `*.md`) starts no release run at all.
   A nightly also runs **the release PR** job (`release.ts release-pr`) to refresh it.
2. **version** decides the number once (`release.ts version`), in a queue that runs one at a time per kind (below).
   For a stable it then drafts the release at that number straight away (`release.ts draft`): a draft has no tag
   yet, but it counts as taken, so a stable queued behind it takes the next number.
3. **Three builds**, for a stable and a nightly alike, each checking out the merge, stamping the number on the runner
   (`release.ts set`), smoke-testing the bundle (`npm run smoke`: it starts and signs in, or nothing ships), building
   with the update key, checking every `.sig` against the compiled-in key (`scripts/check-update-key.ts`) and handing
   its files to publish as an artifact:

   | job     | runner           | how                                                                              | files                                                          |
   | ------- | ---------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------- |
   | macOS   | `macos-15`       | `tauri-apps/tauri-action`, `--target universal-apple-darwin`                     | `loki_<v>_universal.dmg`, `loki.app.tar.gz` and its `.sig`     |
   | Windows | `windows-latest` | `npm run tauri -- build --bundles nsis`                                          | `loki_<v>_x64-setup.exe` and its `.sig`                        |
   | Linux   | `ubuntu-22.04`   | the WebKitGTK apt packages, then `npm run tauri -- build --bundles appimage,deb` | `loki_<v>_amd64.AppImage` and its `.sig`, `loki_<v>_amd64.deb` |

   Linux builds on the oldest supported Ubuntu so the files run on newer glibc too; the apt list is the same as
   `shell.yml`'s. The Windows installer and the AppImage are their systems' update files themselves; the Mac's is the
   `.app` in a `.tar.gz`.
4. **publish** runs only when all three builds succeeded, and only for a push to `main`: a run by hand, from `main`
   or a branch, builds all three and keeps the files as the run's artifacts, and never touches a release or the
   `nightly` tag. `release.ts publish` writes `latest.json` from the builds' `.sig` files (it fails, naming the
   platform, when one is missing), then uploads in this order:
   1. the versioned files: the `.dmg`, `loki_<v>_universal.app.tar.gz` (the Mac's update archive, renamed so it carries
      the version), the `-setup.exe`, the AppImage, each update file's `.sig`, and the `.deb`;
   2. `latest.json` and the install scripts' unversioned copies, replaced with `--clobber`:
      `loki-macos-universal.app.tar.gz` (the Mac's update archive), `loki-windows-x64-setup.exe` and
      `loki-linux-x86_64.AppImage`.

   It then renders the cask from the `.dmg`, attaches `cask.rb` to the release and pushes it to the tap. Each of those
   steps is safe to run again (plan 096): a stable's draft gets its files, then is made public and latest, and a re-run
   of the same merge takes the same number back and finishes what the last run left; once a stable is public a re-run
   changes nothing on it and makes the cask from the `.dmg` it shipped with. A stable that finishes after a newer one
   is already out is published but not made latest, so `releases/latest` never goes back a version. The nightly is
   never deleted: its new files go up beside the last one's, the `nightly` tag moves, `latest.json` goes up last, the
   tap gets the new cask, and only then are the earlier nightlies' files removed (`release.ts prune-nightly`): every
   file whose name carries another version, never `latest.json`, `cask.rb` or the unversioned copies. A nightly
   cancelled by a newer merge at any point still downloads.

## What a release carries

| file                                                                                          | for                                                                                               |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `latest.json`                                                                                 | the updater: version, notes, date, and per platform the versioned update file's URL and signature |
| `loki_<v>_universal.dmg`                                                                      | a download by hand, and the casks                                                                 |
| `loki_<v>_universal.app.tar.gz` (+ `.sig`)                                                    | the Mac's update file (`darwin-aarch64`, `darwin-x86_64`, `darwin-universal`)                     |
| `loki_<v>_x64-setup.exe` (+ `.sig`)                                                           | the Windows installer and update file (`windows-x86_64`)                                          |
| `loki_<v>_amd64.AppImage` (+ `.sig`)                                                          | the Linux AppImage and update file (`linux-x86_64`)                                               |
| `loki_<v>_amd64.deb`                                                                          | Debian and Ubuntu; it does not update itself                                                      |
| `loki-macos-universal.app.tar.gz`, `loki-windows-x64-setup.exe`, `loki-linux-x86_64.AppImage` | the install scripts (`site/public/install.sh`, `install.ps1`)                                     |
| `cask.rb`                                                                                     | what the tap carries, to check                                                                    |

loki's updater reads `https://github.com/AlmondLabs/loki/releases/latest/download/latest.json` on the Stable channel
and `https://github.com/AlmondLabs/loki/releases/download/nightly/latest.json` on the Nightly one; the install scripts
fetch the unversioned copies from `releases/latest/download/` or `releases/download/nightly/` the same way, without
asking GitHub's API which release is newest. The nightly is a prerelease, so `releases/latest` is always the newest
stable. `npm run release -- latest-json <version> <dir>` prints the `latest.json` a release would carry for built
files in `<dir>`; with `LOKI_UPDATE_URL` pointing at a copy of it on a throwaway prerelease, an update can be tried
by hand.

## Versions

A stable is `YYYY.MMDD.N`: the UTC year, then the month and the two-digit day (October 11 is `1011`, January 1 is
`101`), then that day's release count from 0. `2026.1011.0`, then `2026.1011.1` the same day, then `2026.1012.0`.
A nightly is the number of the stable it leads up to plus the release workflow's run number: `2026.1011.1-nightly.4821`.
Run numbers only rise, so nightlies sort in order and each sorts below the stable it leads up to; the commit goes in its
title and notes.

- **The number is decided once per run, by the version job**, from the date, the stable tags and the drafts, not
  written into the PR: it counts today's `vYYYY.MMDD.*` tags and releases and takes the next. Version jobs run one at
  a time in their kind's queue (`build-stable`, `build-nightly`), and a stable's drafts its release at once, so a stable
  queued behind another sees its draft and takes the next number. A run by hand gets a queue of its own. GitHub keeps one waiting run per
  queue: of three release merges within a few minutes the middle one may be dropped, and the third, built from a
  later `main`, carries its changes. A stable never joins another merge's release: if its number is somehow taken by
  another commit, the publish fails and a re-run numbers it again. Drafts count as taken, and a re-run of the same
  merge takes its own stable's number back (`stableFor`), so **re-run failed jobs** after a stable's later step
  failed (the tap token, the network) ships nothing twice.
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
PR's marker file anyway. Its content is one marker file on top of `main`, which `ci` checked on each PR, and the stable build compiles and bundles everything before anything is published. If you want CI on it anyway,
add a fine-grained token with *Contents* and *Pull requests* write access to this repository as the
**`RELEASE_TOKEN`** secret; the workflow prefers it when present.

Merging the release PR needs the same one approval as any PR (the `requires-pr` ruleset). The PR's author is the
Actions bot, so you can approve it yourself.

## Homebrew tap (one-time setup)

The cask is another way in beside the install scripts: `brew install --cask almondlabs/loki/loki`, then
`xattr -dr com.apple.quarantine /Applications/loki.app` once. The app is not signed (next section): Homebrew
quarantines cask downloads exactly like a browser would, and Homebrew 7 removed the `--no-quarantine` flag that used
to skip it, so the cask's caveat and the README both give the `xattr` line. The cask declares `auto_updates true` and
no longer depends on Homebrew's Node: loki updates itself and fetches the Node its daemon runs on, so `brew upgrade`
leaves an installed loki to its own updater. One last `brew upgrade --cask loki` brings a loki from before that to the
self-updating version.

**The `loki-nightly` cask is deprecated.** The channel is a choice in loki's About now, so the cask carries
Homebrew's `deprecate!` (pointing at the `loki` cask and the Nightly channel), `auto_updates true` and no Node. It is
still rendered and pushed on every nightly, so one last `brew upgrade --cask loki-nightly` brings the people on it a
self-updating nightly that keeps itself current from then on. The two casks still conflict with each other: both
builds share `~/.loki`, the daemon and the mod's ports, so one loki is installed at a time.

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

## The update key

Each of the three builds signs the files loki updates from with the `TAURI_SIGNING_PRIVATE_KEY` secret (and its
password), passed only to the step that builds the app, and the app verifies them against `plugins.updater.pubkey` in `src-tauri/tauri.conf.json`, which is compiled in. tauri-cli
only warns when the two are not one pair, so after each build `scripts/check-update-key.ts` compares the key id of
every `.sig` the build made with the pubkey's. The job fails, naming the file, when they differ, when the pubkey is
still the placeholder, or when the build made no `.sig`. A loki released with the wrong pubkey could never verify an
update, and only a reinstall by hand would get past it. Without the secret the builds refuse to make the update files
and the run fails before anything is published; publish also refuses a release missing any platform's signature, so
no release ever ships that some loki could not update from.

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
needs the apt packages in `shell.yml`). Neither needs the Finder workaround.

`npm run release -- plan` says what the workflow would do for the checkout as it stands,
`npm run release -- version stable` the number a stable built now would get, and `npm run release -- notes` the notes
the release PR would carry. None of them changes the checkout's files (`version` fetches the tags first); `plan` and
`notes` ask GitHub (`gh`, signed in) which releases have shipped.

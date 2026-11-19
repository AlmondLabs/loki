# Releasing loki

Nothing is tagged by hand, and nothing ships until you ask. `.github/workflows/release.yml` runs only when you run it
from the Actions tab (or with `gh workflow run`), and `scripts/release.ts` decides what the run does. There are two
channels, nightly and stable, and you pick one each time you run it. A merge ships nothing and starts no release run.
Every release, stable or nightly, is built for the Mac, Windows and Linux in one run and carries the signed update
files every loki installs from. Nothing is written down before the run, so nothing goes stale, and nothing runs on a
schedule.

## How a change ships

1. **Merge PRs into `main`** as usual. That ships nothing.
2. **See what would ship**, if you like: `bun run release notes` prints the notes the next release would carry,
   everything merged since the last stable (below, "Building locally").
3. **Run the workflow on `main`**: Actions › release › Run workflow, with `main` as the branch, and pick the kind.
   From a terminal, `gh workflow run release.yml --ref main` for a nightly or add `-f kind=stable` for a stable.
   - **nightly**, the default: about twenty minutes later there is a new nightly of `main` as it stands, the rolling
     `nightly` prerelease with every system's files (below) and its `latest.json`, and `Casks/loki-nightly.rb` in the
     tap. A loki on the Nightly channel (About) updates itself to it. Only the newest run matters: a nightly still
     building or publishing is cancelled when the next one reaches the same job.
   - **stable**: the run decides the number (below) and publishes `v2026.1011.0` with every system's files and the
     rendered cask attached, marked latest, and pushes `Casks/loki.rb` to the tap. Every loki on the Stable channel
     updates itself to it. A stable produces no nightly; a loki on the Nightly channel stays on its nightly until the
     next one, which is numbered after this stable. Run it as often as you like.

   Either way, with nothing merged since the last stable there is nothing to build, and the run says so in its
   summary. While the builds run, the run's summary shows the notes it will publish: cancel the run before publish if
   they are not what you meant to ship. A stable cancelled that way leaves its draft release (below): delete the draft,
   or the next stable of the same day takes the number after it.

The release PR (branch `release/next`, merged to ship a stable) and the Windows and Linux PR (branch
`release/preview`) are retired: a stable is a run like a nightly, and every stable carries all three systems. Their
markers, `.github/release.txt` and `.github/preview.txt`, are gone. An open release PR left from before can be closed
and its branch deleted.

## What a release run builds

1. **plan** (`bun run release plan`) decides stable, nightly or nothing: the kind you picked (the workflow's `kind`
   input, passed as `REQUESTED_KIND`) when anything has merged since the last stable, and nothing otherwise. It writes
   what it decided, and why, to the run's summary.
2. **version** decides the number once (`release.ts version`), in a queue that runs one at a time per kind (below).
   For a stable of `main` it then drafts the release at that number straight away (`release.ts draft`): a draft has
   no tag yet, but it counts as taken, so a stable queued behind it takes the next number. A stable run from a branch
   drafts nothing. It writes the release notes to the run's summary (`release.ts notes`).
3. **Three builds**, for a stable and a nightly alike, each checking out the commit the run is for, stamping the number on the runner
   (`release.ts set`), smoke-testing the bundle (`bun run smoke`: it starts and signs in, or nothing ships), building
   with the update key, checking every `.sig` against the compiled-in key (`scripts/check-update-key.ts`) and handing
   its files to publish as an artifact:

   | job     | runner           | how                                                                              | files                                                          |
   | ------- | ---------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------- |
   | macOS   | `macos-15`       | `tauri-apps/tauri-action`, `--target aarch64-apple-darwin`                       | `loki_<v>_aarch64.dmg`, `loki.app.tar.gz` and its `.sig`       |
   | Windows | `windows-latest` | `bun run tauri build --bundles nsis`                                          | `loki_<v>_x64-setup.exe` and its `.sig`                        |
   | Linux   | `ubuntu-22.04`   | the WebKitGTK apt packages, then `bun run tauri build --bundles appimage,deb` | `loki_<v>_amd64.AppImage` and its `.sig`, `loki_<v>_amd64.deb` |

   The Mac build is for Apple silicon only, so `latest.json` has no `darwin-x86_64`: a loki already on an Intel Mac
   finds no update for itself and stays as it is. Linux builds on the oldest supported Ubuntu so the files run on
   newer glibc too; the apt list is the same as `shell.yml`'s. The Windows installer and the AppImage are their
   systems' update files themselves; the Mac's is the `.app` in a `.tar.gz`.
4. **publish** runs only when all three builds succeeded, and only on `main`. A run from any other branch, of either
   kind, builds all three and keeps the files as the run's artifacts, and never touches a release or the `nightly` tag,
   so it checks that a branch builds. `release.ts publish` writes `latest.json` from the builds' `.sig` files (it
   fails, naming the platform, when one is missing), then uploads in this order:
   1. the versioned files: the `.dmg`, `loki_<v>_aarch64.app.tar.gz` (the Mac's update archive, renamed so it carries
      the version), the `-setup.exe`, the AppImage, each update file's `.sig`, and the `.deb`;
   2. `latest.json` and the install scripts' unversioned copies, replaced with `--clobber`:
      `loki-macos-arm64.app.tar.gz` (the Mac's update archive), `loki-windows-x64-setup.exe` and
      `loki-linux-x86_64.AppImage`.

   It then renders the cask from the `.dmg`, attaches `cask.rb` to the release and pushes it to the tap. Each of those
   steps is safe to run again (plan 096): a stable's draft gets its files, then is made public and latest, and a re-run
   for the same commit takes the same number back and finishes what the last run left; once a stable is public a re-run
   changes nothing on it and makes the cask from the `.dmg` it shipped with. A stable that finishes after a newer one
   is already out is published but not made latest, so `releases/latest` never goes back a version. The nightly is
   never deleted: its new files go up beside the last one's, the `nightly` tag moves, `latest.json` goes up last, the
   tap gets the new cask, and only then are the earlier nightlies' files removed (`release.ts prune-nightly`): every
   file whose name carries another version, never `latest.json`, `cask.rb` or the unversioned copies. A nightly
   cancelled by a newer one at any point still downloads. A re-run of an older nightly after a newer one went out
   fails at `publish` before it uploads anything, so the cask, tap and prune steps after it don't run either.

## What a release carries

| file                                                                                      | for                                                                                               |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `latest.json`                                                                             | the updater: version, notes, date, and per platform the versioned update file's URL and signature |
| `loki_<v>_aarch64.dmg`                                                                    | a download by hand, and the casks                                                                 |
| `loki_<v>_aarch64.app.tar.gz` (+ `.sig`)                                                  | the Mac's update file (`darwin-aarch64`)                                                          |
| `loki_<v>_x64-setup.exe` (+ `.sig`)                                                       | the Windows installer and update file (`windows-x86_64`)                                          |
| `loki_<v>_amd64.AppImage` (+ `.sig`)                                                      | the Linux AppImage and update file (`linux-x86_64`)                                               |
| `loki_<v>_amd64.deb`                                                                      | Debian and Ubuntu; it does not update itself                                                      |
| `loki-macos-arm64.app.tar.gz`, `loki-windows-x64-setup.exe`, `loki-linux-x86_64.AppImage` | the install scripts (`site/public/install.sh`, `install.ps1`)                                     |
| `cask.rb`                                                                                 | what the tap carries, to check                                                                    |

loki's updater reads `https://github.com/AlmondLabs/loki/releases/latest/download/latest.json` on the Stable channel
and `https://github.com/AlmondLabs/loki/releases/download/nightly/latest.json` on the Nightly one; the install scripts
fetch the unversioned copies from `releases/latest/download/` or `releases/download/nightly/` the same way, without
asking GitHub's API which release is newest. The nightly is a prerelease, so `releases/latest` is always the newest
stable. `bun run release latest-json <version> <dir>` prints the `latest.json` a release would carry for built
files in `<dir>`; with `LOKI_UPDATE_URL` pointing at a copy of it on a throwaway prerelease, an update can be tried
by hand.

The Stable install line works only once a stable built by this workflow is out: older stables carry no unversioned
copies, so until then `releases/latest/download/` answers 404 and the scripts say the latest loki isn't published
yet. Run a stable right after the change that brought the one-line install lands; until that stable ships, the Nightly
line works.

## Versions

A stable is `YYYY.MMDD.N`: the UTC year, then the month and the two-digit day (October 11 is `1011`, January 1 is
`101`), then that day's release count from 0. `2026.1011.0`, then `2026.1011.1` the same day, then `2026.1012.0`.
A nightly is the number of the stable it leads up to plus the release workflow's run number: `2026.1011.1-nightly.4821`.
Run numbers only rise, so nightlies sort in order and each sorts below the stable it leads up to; the commit goes in its
title and notes.

- **The number is decided once per run, by the version job**, from the date, the stable tags and the drafts, never
  written down beforehand: it counts today's `vYYYY.MMDD.*` tags and releases and takes the next. Version jobs run one
  at a time in their kind's queue (`build-stable`, `build-nightly`), and a stable's drafts its release at once, so a
  stable queued behind another sees its draft and takes the next number. A run from a branch gets a queue of its own.
  GitHub keeps one waiting run per queue: of three stables started within a few minutes the middle one may be
  dropped, and the third, built from a later `main`, carries its changes. A stable never joins another commit's
  release: if its number is somehow taken by another commit, the publish fails and a re-run numbers it again. Drafts
  count as taken, and a stable run again for the same commit takes its own stable's number back (`stableFor`), so
  **re-run failed jobs** after a stable's later step failed (the tap token, the network) ships nothing twice.
- **It sorts after everything before it.** All three parts are integers, so semver, Cargo, macOS bundle versions,
  Homebrew and the app's own update check (`core/version.ts`) order it, and Windows installers' limit of 65535 per
  part is never reached. A month and day (101 to 1231) outnumber a month (1 to 12), so `2026.1011.0` is newer than
  every `YYYY.M.D` stable shipped before October 2026 (the last was `2026.10.11`), and upgrades just work.
- **The tags are the truth.** `main` takes changes through PRs alone (the `requires-pr` ruleset), so nothing commits
  the number back: `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` (and the lockfile) keep the
  last number committed before releases were numbered at the build, and every build stamps its own on the runner. A checkout
  therefore shows that old number in Settings and may say a newer release exists; that is expected.
- **`CHANGELOG.md` is frozen at 2026.10.11.** Its headings would need the final number on `main`; each release's
  notes are on its GitHub release instead.
- The version says nothing about compatibility. The release notes carry that; a `breaking` word in a PR title is
  the convention if you want one.

## Who can release

Running the workflow needs write access to this repository; nothing else gates it. Every change in a release already
passed CI and its one approval as a PR (the `requires-pr` ruleset), and the builds smoke-test the bundle before
anything is published.

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
(`bun run cask <owner> <version> <sha256> [stable|nightly]`), covered by `test/cask.test.ts`.

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

`bun run desktop:build` produces the `.app` and the `.dmg` under `src-tauri/target/release/bundle/`, at the version
the files hold (not a release's: see Versions). The `.dmg` step drives Finder through AppleScript to lay out the window; from a
terminal without Automation permission for Finder (an SSH session, an agent's shell) it fails with `Finder got an
error: AppleEvent timed out`. The `.app` is complete at that point; make the image without the Finder pass:

```bash
cd src-tauri/target/release/bundle/macos
../dmg/bundle_dmg.sh --skip-jenkins --volname loki --icon loki.app 180 170 --app-drop-link 480 170 \
  --window-size 660 400 --hide-extension loki.app --volicon ../dmg/icon.icns \
  ../dmg/loki_local_aarch64.dmg loki.app
```

On Windows or Linux, `bun run tauri build --bundles nsis` or `bun run tauri build --bundles appimage,deb` makes the
same files as the release, under `src-tauri/target/release/bundle/nsis/`, `appimage/` and `deb/` (the Linux build
needs the apt packages in `shell.yml`). Neither needs the Finder workaround.

`bun run release plan` says what a run would do for the checkout as it stands, as a nightly (with
`REQUESTED_KIND=stable`, as a stable), `bun run release version stable` the number a stable built now would get,
and `bun run release notes` the notes the next release would carry. None of them changes the checkout's files (`version` fetches the tags first); `plan` and
`notes` ask GitHub (`gh`, signed in) which releases have shipped.

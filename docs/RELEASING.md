# Releasing loki

A release is a git tag. `.github/workflows/release.yml` builds the macOS app (universal), signs and
notarizes it if the secrets below exist, and attaches the `.dmg` to a **draft** GitHub release for you
to publish.

## Cut a release

1. Bump the version in all three places and keep them equal: `package.json`, `src-tauri/tauri.conf.json`,
   `src-tauri/Cargo.toml`. Settings shows the package version; the bundle carries the Tauri one.
2. Retest against npm's newest Letta Code (`npm view @letta-ai/letta-code version`; a fresh install gets exactly that) and
   move `TESTED_LETTA_CODE` in `core/compat.ts` to it. `MIN_LETTA_CODE` moves only when something older stops working.
3. `bun test && bun run typecheck && cargo test --manifest-path src-tauri/Cargo.toml`.
4. Commit, then `git tag v0.1.0 && git push origin main --tags`.
5. Wait for the workflow, open the draft release, check the notes, publish.
6. Publishing triggers `.github/workflows/cask.yml`, which reads the `.dmg`'s checksum, renders the Homebrew
   cask and pushes it to the tap (below). `brew upgrade --cask loki` then picks the release up. The rendered
   `loki.rb` is also attached to the release.

## Homebrew tap (one-time setup)

The app is not signed (next section), so Homebrew is the recommended install: `brew install --cask
<owner>/loki/loki`, then `xattr -dr com.apple.quarantine /Applications/loki.app` once. Homebrew quarantines
cask downloads exactly like a browser would, and Homebrew 7 removed the `--no-quarantine` flag that used to
skip it, so the cask's caveat and the README both give the `xattr` line.

1. Create an empty public repository named **`homebrew-loki`** under the same owner as this repo (Homebrew
   resolves `<owner>/loki` to it). No files needed; the workflow adds `Casks/loki.rb`.
2. Create a token that can push to it: GitHub → Settings → Developer settings → Fine-grained tokens, repository
   access `homebrew-loki` only, permission *Contents: read and write*.
3. Add it to this repository's secrets as **`TAP_TOKEN`**.

Without the secret the cask job renders the file and attaches it to the release, then fails at the push with a
message naming the secret; copy the file into the tap by hand and nothing else is lost. `scripts/cask.ts` is
the template (`bun scripts/cask.ts <owner> <version> <sha256>`), covered by `test/cask.test.ts`.

## Signing (one-time setup)

Without signing, macOS blocks the downloaded app as "damaged"; people must run
`xattr -dr com.apple.quarantine /Applications/loki.app` or allow it in System Settings › Privacy & Security
(right-click → Open no longer helps on macOS 14 and later, and Homebrew 7 has no `--no-quarantine`).
Signing needs an Apple Developer Program membership (paid, yearly).

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

The workflow exports the six as env vars only when `APPLE_CERTIFICATE` is set (a step before tauri-action);
Tauri signs whenever that variable exists, even empty, so passing missing secrets straight through would fail
the bundle with "failed to import keychain certificate", as the first release attempt did. Without the secrets
the build succeeds unsigned.

## Building locally

`bun run desktop:build` produces the `.app` and the `.dmg` under `src-tauri/target/release/bundle/`. The
`.dmg` step drives Finder through AppleScript to lay out the window; from a terminal without Automation
permission for Finder (an SSH session, an agent's shell) it fails with `Finder got an error: AppleEvent
timed out`. The `.app` is complete at that point; make the image without the Finder pass:

```bash
cd src-tauri/target/release/bundle/macos
../dmg/bundle_dmg.sh --skip-jenkins --volname loki --icon loki.app 180 170 --app-drop-link 480 170 \
  --window-size 660 400 --hide-extension loki.app --volicon ../dmg/icon.icns \
  ../dmg/loki_0.1.0_aarch64.dmg loki.app
```

## What ships

- `loki.app` with the React canvas built in and the mod bundled as one file under `Contents/Resources`.
- On first launch the app copies the mod to `~/.letta/loki/mod/` and writes
  the shim `~/.letta/mods/loki.ts` and the skill `~/.agents/skills/loki/` (both marked as managed; a
  developer's own shim or symlink is never overwritten). Settings → install shows what happened.
- Nothing is sent anywhere: no telemetry, no update check. Updates are a new release: `brew upgrade --cask loki`,
  or the next `.dmg`.

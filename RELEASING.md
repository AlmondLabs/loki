# Releasing loki

A release is a git tag. `.github/workflows/release.yml` builds the macOS app (universal), signs and
notarizes it if the secrets below exist, and attaches the `.dmg` to a **draft** GitHub release for you
to publish.

## Cut a release

1. Bump the version in all three places and keep them equal: `package.json`, `src-tauri/tauri.conf.json`,
   `src-tauri/Cargo.toml`. Settings shows the package version; the bundle carries the Tauri one.
2. If Letta Code was upgraded, retest and update `TESTED_LETTA_CODE` in `shared/compat.ts`.
3. `bun test && bun run typecheck && cargo test --manifest-path src-tauri/Cargo.toml`.
4. Commit, then `git tag v0.3.0 && git push origin main --tags`.
5. Wait for the workflow, open the draft release, check the notes, publish.

## Signing (one-time setup)

Without signing, macOS blocks the downloaded app as "damaged" or from an unidentified developer; people
must right-click → Open, or run `xattr -dr com.apple.quarantine /Applications/loki.app`. Signing needs an
Apple Developer Program membership (paid, yearly).

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

The workflow reads all six as plain env vars; when they are empty, tauri-action skips signing and the
build still succeeds.

## Building locally

`bun run desktop:build` produces the `.app` and the `.dmg` under `src-tauri/target/release/bundle/`. The
`.dmg` step drives Finder through AppleScript to lay out the window; from a terminal without Automation
permission for Finder (an SSH session, an agent's shell) it fails with `Finder got an error: AppleEvent
timed out`. The `.app` is complete at that point; make the image without the Finder pass:

```bash
cd src-tauri/target/release/bundle/macos
../dmg/bundle_dmg.sh --skip-jenkins --volname loki --icon loki.app 180 170 --app-drop-link 480 170 \
  --window-size 660 400 --hide-extension loki.app --volicon ../dmg/icon.icns \
  ../dmg/loki_0.3.0_aarch64.dmg loki.app
```

## What ships

- `loki.app` with the React canvas built in and the mod bundled as one file under `Contents/Resources`.
- On first launch the app copies the mod to `~/Library/Application Support/<identifier>/mod/` and writes
  the shim `~/.letta/mods/loki.ts` and the skill `~/.agents/skills/loki/` (both marked as managed; a
  developer's own shim or symlink is never overwritten). Settings → install shows what happened.
- Nothing is sent anywhere: no telemetry, no update check. Updates are a new `.dmg`.

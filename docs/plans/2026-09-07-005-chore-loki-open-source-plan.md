# loki · open source and installable (2026-09-07)

Decided 2026-09-07 with Deepak ("what would it take to make the loki project opensource and
available for everyone?" → "finish them all"). The code was closer than the packaging: nothing in
the repo or its history leaked secrets, money or personal data, but there was no licence, no way to
install without a dev machine, and no build anyone could download.

## Decisions

- **Licence: Apache-2.0.** Same as Letta Code, so the mod boundary raises no question. `LICENSE`,
  `package.json`, `Cargo.toml`.
- **Identifier stays `dev.deepak.loki`.** Changing it later resets the app data directory; do it
  before the first signed build if at all (RELEASING.md).
- **The app installs its own mod.** `scripts/build-mod.mjs` bundles `mod/index.ts` into one file
  (`ws` inside, `esbuild` optional) under `src-tauri/resources/`, which Tauri ships in
  `Contents/Resources`. On launch (`src-tauri/src/install.rs`) the bundle is copied to the app data
  directory and `~/.letta/mods/loki.ts` is written pointing at it, plus the skill at
  `~/.agents/skills/loki/`. Both carry a managed marker; anything else in the way is `custom` and
  left alone, so a developer's checkout keeps working. Dev builds skip the step unless
  `LOKI_INSTALL=1`. The install runs before harness discovery so a harness loki starts loads the
  new copy; if a harness was already up, Settings says to `/reload`.
- **Requirements are checked, not assumed.** `tool_status` finds `letta` and `bd` on PATH and the
  usual install dirs; Settings → requirements shows paths or the install command. The board runs
  `bd init` itself on first use.
- **Compatibility is recorded.** `shared/compat.ts` holds the Letta Code version loki was tested
  with; the page asks the harness for `app_server_info` and Settings shows both, with a warning when
  major.minor differ.
- **CSP on.** Scripts only from the app and `loki://`; styles inline (React); images and fetches
  anywhere (widgets). A `securitypolicyviolation` listener reports refusals to the shell's stderr.
- **CI and releases.** `ci.yml` runs bun test, tsc, the app and mod builds, and cargo test.
  `release.yml` builds a universal `.dmg` on a `v*` tag into a draft release; signing and
  notarization happen when the six Apple secrets exist and are skipped otherwise.
- **macOS only**, said plainly in the README. `lsof`, `osascript`, the native title bar, the dock
  badge and the global shortcut are all Mac.
- **Kept**: the plan docs as public design history; the name (the README disambiguates from
  Grafana Loki).

## Left to the owner

- Create the GitHub repository and push (`gh repo create skilp4d/loki --public --source . --push`).
- Apple Developer membership and the six secrets, if signed builds are wanted.
- A 30-second clip and screenshots for the README, under the no-money rule.

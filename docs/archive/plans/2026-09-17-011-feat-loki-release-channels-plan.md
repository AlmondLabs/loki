# loki · releases from every merge: a nightly channel, a release PR, the calendar as the version (2026-09-17)

Raised 2026-09-17: "Can we setup auto release management in github CI so that any new merge to the main branch
automatically does a version bump and does the release cadence." Then, over five exchanges: the release-PR shape
was chosen over a stable-per-merge because the repo's ruleset lets no bot push to `main` and desktop apps release
deliberately; "I actully want the nightly channel as well"; and the version scheme moved from semver-by-label to
dates — "can we instead use date based version management?", "shoudn't it propose 2026.9.28?" → "go ahead".

## The shape

1. **Two channels, one workflow.** `.github/workflows/release.yml` runs on every push to `main`, at midnight UTC
   and by hand. A `plan` job asks `scripts/release.ts` what the run is: a **nightly** (any merge), a **stable**
   (the release PR landing), a **repush** (a release PR merged on the wrong day) or **none** (nothing since the
   last stable). The `build` job stamps the version into the files on the runner, builds the universal `.dmg`
   with tauri-action, publishes with `gh release create`, renders the cask and pushes it to the tap. The old
   tag-triggered `release.yml` and the publish-triggered `cask.yml` fold into it; nothing is tagged by hand.
2. **The calendar is the version.** A stable is `YYYY.M.D` (UTC) of the day its release PR is merged; a nightly
   is `YYYY.M.D-nightly.<sha>` of the merge that built it. Three integers, so semver, macOS and Homebrew order
   them and `core/version.ts` compares them unchanged. Tags are the source of truth; the three version files hold
   the last stable between releases and only the release PR moves them, so a checkout shows the last stable and
   stays quiet about updates. `0.1.0` counts as the last stable until the first date-based one, which the app on
   `0.1.0` will see as newer — the broken `v0.1.0` download finally retires.
3. **One release PR.** The first merge after a stable creates branch `release/next` with one commit: the bump
   and the notes prepended to `CHANGELOG.md`; each merge after that rebuilds it from `main` and force-pushes, and
   the midnight run refreshes its number. n merges are one PR with n entries. Merging it is the release, and that
   merge is the stable build (no nightly from it). The author is the Actions bot, so the owner can approve.
4. **One stable a day**, because a date fills the three slots. The release merge recomputes: files that disagree
   with today are not tagged — the PR is force-pushed with today's number (or tomorrow's, if today already
   shipped) and asks for one more merge. Nothing wrong ever ships; the merge still made a nightly.
5. **The rolling nightly.** One prerelease tagged `nightly`, replaced only after the build succeeded, so a failing
   merge leaves the previous nightly in place. Only the newest merge matters: a nightly build in progress is
   cancelled by the next merge; a stable build never is.
6. **Two casks that conflict.** `loki` and `loki-nightly` in the same tap, from `scripts/cask.ts` with a channel.
   Both builds share `~/.letta/loki`, the mod shim and the harness port, so one loki is installed at a time —
   unlike Insiders or Preview builds elsewhere, which have their own data directories. The nightly cask skips
   livecheck (a rolling tag) and is rewritten on every merge.
7. **The app knows its channel** from its version string (`channelOf`). A nightly asks GitHub for the `nightly`
   prerelease and treats any other build as newer; a stable asks for the latest release as before. Settings names
   the right cask in the brew line.

## Decisions

- **Release PR over stable-per-merge.** The ruleset needs one approval on every PR and no bot may bypass it, so a
  human click per release is structurally required; making that click the release itself (as release-please and
  changesets do) beats a bot committing bumps. Desktop apps also batch: a build is slow and users pay for every
  upgrade. The per-merge flavour is the nightly channel, additive.
- **Dates over semver-by-label.** The user's commits are prose, not conventional commits, so semver tooling would
  never bump; labels were the alternative and were dropped when dates removed the need. The version loses its
  compatibility signal, which the notes carry instead. Warp, JetBrains and Ubuntu ship this way.
- **`YYYY.M.D`, not `YYYY.M.N`.** "If the date is the version, the day belongs in it." The cost is one stable a
  day and a number that goes stale at midnight; the midnight refresh and the merge-time guard pay it.
- **No `0.0.0` placeholder.** The files hold the last stable, so a checkout is honest about what it is and the
  update check needs no special case. A nightly's number lives only on the runner.
- **CI on the release PR is optional.** Pushes with the workflow token start no workflows; the PR's content is
  numbers and a changelog, and the stable build compiles everything before publishing. `RELEASE_TOKEN` turns CI
  on when wanted.

## Files

- `scripts/release.ts` (new): `dateVersion`, `nightlyVersion`, `latestStable`, `nextStable`, `plan`,
  `releaseNotes`, `setVersion`, `withChangelog`; the commands `plan`, `set`, `notes`, `release-pr`, `publish`.
- `.github/workflows/release.yml` (rewritten): `plan` → `release-pr` / `build`. `.github/workflows/cask.yml` removed.
- `scripts/cask.ts`: a `channel`; `loki-nightly`, `conflicts_with`, the rolling url.
- `core/version.ts`: `Channel`, `channelOf`, `nightlyVersionIn`. `app/src/shell/useLokiUpdate.ts`: the channel's
  endpoint. `app/src/settings/Settings.tsx`: the cask in the brew line.
- Tests: `test/release.test.ts` (new), `test/cask.test.ts`, `test/version.test.ts`.
- `docs/RELEASING.md` (rewritten), `README.md`, `docs/manual.md`.

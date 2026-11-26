---
title: Releases by hand - Plan
type: feat
date: 2026-11-16
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
execution: code
---

# Releases by hand - Plan

---

## Goal Capsule

- **Objective:** a nightly and a stable each ship only when the maintainer asks for one, the same way; a merge to
  `main` ships nothing.
- **Means:** the release workflow's "Run workflow" on `main` (or `gh workflow run release.yml --ref main`, with
  `-f kind=stable` for a stable) takes one input, `kind`: nightly, the default, or stable. The release PR goes.
- **Authority:** the owner's decisions (2026-11-16): "I don't like the fact that every merge on main releases a
  nightly. I want to have explicit control over when to release nightlies just like the stable releases", choosing
  "Run it by hand"; then "Why not bring the stable also to the manual workflow run?", and "yes, extend" to moving
  stables to the same run and removing the release PR.

This changes R17 of [the self-updating install plan](2026-11-15-2319-feat-self-updating-install-plan.md): both
channels still ship for the Mac, Windows and Linux, but from a run by hand on `main`, not from merges.

---

## Product Contract

### Summary

`release.ts plan` takes the kind asked for (`REQUESTED_KIND`, from the workflow's `kind` input) and ships it when
anything has merged since the last stable. The workflow runs only by hand, and publishes only on `main`, so a run from
a branch still builds all three systems and publishes nothing. The release PR, its job, its branch, its marker file
and the commit filter that kept its commits out of the notes are removed. The run writes the notes it will publish to
its summary, and `npm run release -- notes` prints them beforehand, which stands in for the release PR's preview.

### Requirements

- R1. A merge to `main` starts no release run and ships nothing.
- R2. A run by hand on `main` asking for a nightly ships a nightly of `main` as it stands, numbered by the run,
  through the same steps as before: the stale-nightly guard, the nightly cask, the prune.
- R3. A run by hand on `main` asking for a stable ships a stable of `main` as it stands, numbered and drafted in the
  version queue as before, made latest, with the stable cask.
- R4. Either kind ships nothing when nothing has merged since the last stable, and says so in the run's summary.
- R5. A run from any other branch, of either kind, builds all three systems and publishes nothing; a stable there
  drafts no release, so it takes no number.
- R6. A nightly of `main` joins the nightly queues (`build-nightly`, `macos-nightly`, …), so a newer one cancels an
  older one still building or publishing; a stable takes the `build-stable` queue; a branch's run keeps queues of its
  own.
- R7. The run writes its release notes to its summary before the builds finish, so it can be cancelled before
  publish.
- R8. The README, the manual, SECURITY.md and the release docs say both channels ship when the maintainer releases
  them.

### Scope Boundaries

- A schedule for either channel.
- A review gate on releasing beyond write access to the repository: every change in a release already passed CI and
  review as a PR.
- Cleaning up a draft left by a cancelled stable: the docs say to delete it.

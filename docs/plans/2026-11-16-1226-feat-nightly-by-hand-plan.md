---
title: Nightlies by hand - Plan
type: feat
date: 2026-11-16
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
execution: code
---

# Nightlies by hand - Plan

---

## Goal Capsule

- **Objective:** a nightly ships only when the maintainer asks for one, as a stable does; a merge to `main` ships
  nothing.
- **Means:** the release workflow's "Run workflow" (or `gh workflow run release.yml --ref main`) on `main` ships a
  nightly of `main` as it stands; a push to `main` ships a stable when it is the release PR's merge, and otherwise only
  refreshes the release PR.
- **Authority:** the owner's decision (2026-11-16): "I don't like the fact that every merge on main releases a
  nightly. I want to have explicit control over when to release nightlies just like the stable releases", choosing
  "Run it by hand".

This changes R17 of [the self-updating install plan](2026-11-15-2319-feat-self-updating-install-plan.md): nightlies
still ship for the Mac, Windows and Linux, but from a run by hand on `main`, not from every merge.

---

## Product Contract

### Summary

`release.ts plan` takes what started the run. A push is a stable when it lands the release PR and nothing otherwise; a
run by hand is a nightly, and never a stable. The workflow publishes only on `main`, a stable from a push and a nightly
from a run by hand, so a run from a branch still builds all three systems and publishes nothing.

### Requirements

- R1. A push to `main` ships a stable when it is the release PR's merge, as before, and otherwise ships nothing: no
  nightly build or publish, no cask push, no prune. Every push but the release PR's own refreshes the release PR.
- R2. A run by hand on `main` ships a nightly of `main` as it stands, numbered by the run, through the same steps as
  before: the stale-nightly guard, the nightly cask, the prune. It takes no inputs. With nothing since the last stable
  it ships nothing.
- R3. A run by hand from any other branch builds all three systems and publishes nothing. A run by hand never ships a
  stable.
- R4. A nightly of `main` joins the nightly queues a merge's nightly used (`build-nightly`, `macos-nightly`, …), so a
  newer one cancels an older one still building or publishing; a branch's run keeps queues of its own.
- R5. The README, the manual, SECURITY.md and the release docs say a nightly ships when the maintainer releases one.

### Scope Boundaries

- A schedule for nightlies, or an input to choose the kind of a run by hand.
- Refreshing the release PR from a run by hand: merges keep it current.
- A docs-only merge still starts no run; the release PR waits for the next change that does.

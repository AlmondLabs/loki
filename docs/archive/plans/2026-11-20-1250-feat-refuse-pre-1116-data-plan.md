---
title: Refuse data older than 1116 - Plan
type: feat
date: 2026-11-20
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
execution: code
---

# Refuse data older than 1116 - Plan

---

## Goal Capsule

- **Objective:** a loki folder that no version up to 2026.1116 converted is refused at start with a message saying how to fix it, rather than read wrongly. Without the check, phones would be unpaired, desks dropped and Letta-era text replayed with no sign.
- **Means:** one start-up check that reads the markers the converting versions already wrote (KTD1), and an exit code the shell treats as final (KTD2).
- **Authority:**
  - AlmondLabs/loki#354 removed the conversions and relies on a release note for installs older than 2026.1116.
  - The owner chose to add this check on top of that, rather than rely on the note alone (2026-11-20).
  - The check was first planned and reviewed as U1 of `docs/plans/2026-11-20-1150-refactor-remove-shipped-migrations-plan.md`, which #354 overtook.
- **Stop conditions:** stop and ask if the check would refuse a folder that a 2026.1116-era daemon has started and converted.
- **Finishes and ships:** an agent through `ce-work`, in one pull request carrying this plan.

---

## Product Contract

### Summary

Before anything else opens, the daemon checks whether the loki folder was ever started by a version that converted older data. If it wasn't, the daemon refuses with its own exit code. The app stops restarting it and says: install loki 2026.1116, open it once, then update again. The same happens when a listed agent's store was left unconverted. A fresh folder gets the marker and starts as usual.

### Problem Frame

#354 removed loki's one-time conversions. Its release note asks anyone on 2026.1022 or older to open 2026.1116 first. But the updater installs the newest release, so a switched-off Mac, an old install or a restored `~/.loki` skips that step. Today such a folder is read in its old shape, and nothing says so.

### Requirements

- R1. At start, before any store, approval or pass file is opened, the daemon refuses a loki folder that holds loki data but was never started by a version from 2026-10-28 to 2026.1116. It also refuses a folder where such a version did not finish converting a listed agent's store. The person sees the refusal in the window, naming 2026.1116.
- R2. A fresh loki folder starts as usual, and every later start passes the check.
- R3. The manual says how to update from before 2026.1116 and that the two `migrations.json` files are kept.

### Scope Boundaries

- Considered and not built: a test that starts the real daemon on old data. The check itself is unit-tested, the Rust mapping has its own test, and a fixture run covers the daemon by hand. Revisit if the start-up order changes.

---

## Planning Contract

### Key Technical Decisions

- KTD1. **The check reads the markers the converting versions already wrote.**
  - Every daemon from 2026-10-28 until #354 wrote `agents: 1` to `state/migrations.json` at its first start. A missing marker next to loki data means none of them ran.
  - A store mark below 3 in `stores/migrations.json` means 1116 never finished that store. A mark counts only for a listed agent whose `stores/<id>.sqlite` exists: deleting an agent leaves its entry, and 1116 opens only listed agents' stores.
  - A store with no mark is fine. A pre-marker store implies a missing `agents` marker, and stores made after #354 carry no mark.
  - On a folder with no marker and no data, the check writes `agents: 1` atomically and keeps any other keys.
- KTD2. **The refusal has its own exit code, and the shell stops on it.** Until now a daemon exit reached the window only as the generic "keeps stopping" note, and the shell restarted it forever. `EXIT_OLD_DATA` (4) is defined beside `EXIT_HELD` in `daemon/main.ts` and `src-tauri/src/harness.rs`. `supervise_daemon` stops on it and publishes the refusal as the daemon status's error.

---

## Implementation Units

### U1. Refuse data older than 1116

- **Goal:** R1, R2 (KTD1, KTD2).
- **Files:**
  - `daemon/old-data.ts` (new) and `test/old-data.test.ts` (new);
  - `daemon/main.ts`;
  - `src-tauri/src/harness.rs` and `src-tauri/src/lib.rs`.
- **Test scenarios:**
  - An agent with no marker is refused, and the refusal names 2026.1116.
  - A saved state file or a store with no marker is refused.
  - A malformed marker file next to loki data is refused, not crashed on.
  - The marker beside other keys passes.
  - A listed agent's store marked 2 is refused by name.
  - An unmarked store passes, and so does a leftover mark for a missing file or an unlisted agent.
  - A fresh folder passes and gets the marker, keeping existing keys.
  - In Rust, only the new code yields the refusal note.
- **Verification:** the tests pass. A built daemon on a pre-1116 fixture folder exits 4 with the message and touches no file. On a fresh folder it starts and writes the marker.

### U2. The words

- **Goal:** R3.
- **Files:** `docs/manual.md`, `docs/architecture.md`.
- **Test expectation:** none. These are docs.

---

## Verification Contract

| Check | When |
|---|---|
| `bun run format:check && bun run lint && bun run typecheck && bun run test && bun run test:node` | before pushing |
| `bun run build:app && bun run build:mod && bun run smoke` | before pushing |
| the cargo lines in `docs/CONTRIBUTING.md#checks` | before pushing |
| The fixture and fresh-folder runs in U1's verification, and the check passing on this Mac's `~/.loki` | by hand |
| CI on the pull request, Windows included | after pushing |

---

## Definition of Done

- Both units' verification holds, and every check above passes.
- The manual no longer says the `migrations.json` files can be deleted.

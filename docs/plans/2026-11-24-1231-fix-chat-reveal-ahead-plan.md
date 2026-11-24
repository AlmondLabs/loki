---
title: Older messages load before you reach them - Plan
type: fix
date: 2026-11-24
topic: chat-reveal-ahead
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
execution: code
---

# Older messages load before you reach them - Plan

## Goal Capsule

- **Objective:** scrolling up through a long desktop chat, a strong trackpad flick included, glides without stopping, bouncing or jumping.
- **Means:** while the reader scrolls, the desktop thread mounts older rows a few screens ahead of them instead of 800px from the top (KTD1, KTD2).
- **Product authority:** the owner, who reported the jump and confirmed it happens when scrolling up to older messages.
- **Stop conditions:** stop and ask if, in the Mac app, the place-keeping `scrollTop` write during a trackpad fling ends the glide (revealing ahead would then trade one bounce for a stop every chunk). Stop and bring the estimated-height placeholder (Scope Boundaries) back to the owner if a strong flick in the Mac app still reaches the top of the loaded rows; don't just raise the distance. Stop and ask if opening a chat, find or ↓ Latest mounts more rows than today.
- **Execution profile:** the desktop thread (`app/src/item/timeline.tsx`, `app/src/item/thread-follow.ts`), its tests, and one line of `docs/manual.md`. Branch `fix/chat-reveal-ahead`, commit scope `chat`.
- **Open blockers:** none.

## Product Contract

### Summary

While you scroll a long desktop chat, older rows load when you are a few screens from the top of what is loaded instead of 800px from it, so a flick up doesn't run into that top. Opening a chat, find and ↓ Latest behave as today.

### Problem Frame

A long chat opens on its newest 60 rows and mounts 20 older ones once the scroll comes within 800px of the top. Measured in the desktop page in Chromium (the browser pane), a fast scroll up passes 800px in a frame or two, so the scroll reaches the real top first. On a Mac trackpad that is the rubber-band bounce. The 20 rows then mount in one ~50ms render. `use-keep-place.ts` puts the reader back by writing `scrollTop`, and the rest of that gesture is clamped against the old top: in one 1000px scroll, 271px were lost. The reader sees the scroll stop, bounce, then jump. The owner's app is WebKit, so the Mac check is part of the definition of done.

### Requirements

- R1. While the reader scrolls up the desktop thread, older rows are mounted while they are still at least a few screens below the top of what is loaded, so a scroll up, a strong trackpad flick included, doesn't reach that top while older rows remain.
- R2. When one reveal leaves the reader still within that distance (short rows, a tall window), the next reveal follows without another gesture.
- R3. Asking the daemon for an older page starts from the same distance.
- R4. Only one reveal is in flight at a time: a burst of scroll events mounts one chunk, not several.
- R5. The reader's place is kept exactly as today when rows land above (the row being read does not move).
- R6. Opening a thread, find and ↓ Latest mount exactly the rows they do today: a thread opens on its newest 60 rows (back to the New line), find reaches the older rows it needs, and ↓ Latest folds the window back.

### Scope Boundaries

- The phone thread (`app/src/chat/use-transcript-scroll.ts`) and the shared `REVEAL_PX` constant are not changed. iOS stops a fling when `scrollTop` is written, so revealing mid-fling there is a different trade-off, and the report was about the Mac.
- Streaming, sending and following the bottom are not changed.
- Considered and not built: a placeholder of estimated height above the loaded rows, so the scroll can never reach the real top. It needs a height estimate and a second correction when rows land; revealing ahead removes the clamp without it at the speeds measured. Evidence that would change this: a strong flick in the Mac app that still reaches the top (a stop condition).
- Considered and not built: rendering a reveal as a React transition. Scrolling runs off the main thread in Chromium and in macOS WebKit's overflow scrolling, so the render delays only the commit, and a transition delays it further; while a reply streams, its urgent updates would keep restarting the transition. Evidence that would change this: a reveal's render visibly stuttering the scroll in the Mac app.
- Considered and not built: dropping the 60-row window on desktop. Opening a long chat would render all of it.

### Sources / Research

- Browser measurement in this session (Chromium), on a throwaway daemon (`npm run phone-preview`) with the desktop page: the reveal fired at `scrollTop` 729 after the scroll had been clamped, a 51ms long task, then `keepReading` moved `scrollTop` from 729 to 3941; the next 1000px wheel moved it by 729.
- `9eb62082` (PR #270) built the place-keeping in `use-keep-place.ts` for the Mac app's WebKit, which has no scroll anchoring; this plan keeps it.
- Code reading: every reveal's place-keeping write (`keepReading`, or MessageScroller's prepend restore at the bottom) fires a scroll event, which re-runs the near-top check; and `onScroll` also fires for the code's own scrolls (the scroll to the end on open, find, ↓ Latest).

## Planning Contract

### Key Technical Decisions

- KTD1. **Three screens while the reader scrolls, today's 800px otherwise.** A pure helper in `app/src/item/thread-follow.ts` decides from `scrollTop`, `clientHeight` and whether the reader is scrolling. The reader distance is `max(REVEAL_PX, 3 × clientHeight)`, which covers a strong flick in the measured case; the Mac check confirms it (a stop condition). Without reader input, the distance stays `REVEAL_PX`, so opening, find and ↓ Latest mount what they do today. Governs R1, R3, R6.
- KTD2. **Reader input is marked where it arrives.** The viewport's existing `onWheel` and `onKeyDown` handlers, plus `onTouchMove`, record the event's time. `onScroll` can't tell the reader's scroll from the code's own, so a scroll counts as the reader's for one second after their last input, comparing the two events' `timeStamp`s. A trackpad fling keeps sending wheel events, so it stays marked; a chat opening has no input yet, and each chat's thread remounts, so the mark never carries over. Governs R1, R6.
- KTD3. **One reveal at a time, keyed on the start it was asked from.** The window update moves the start only if it still equals the start that triggered it, so scroll events before the commit don't stack chunks. Reveals still commit synchronously, as today. Governs R4.
- KTD4. **The chain rides the place-keeping scroll.** When rows land above a reader away from the bottom, the place-keeping write fires a scroll event, which re-runs the check with the new start; no extra effect is built. Governs R2.

### Sequencing

U1 first (the pure decision), then U2 (the thread uses it), then U3 (manual).

## Implementation Units

### U1. When the thread is near the top

- **Goal:** one pure function says whether the desktop thread should reveal older rows, ask the daemon for an older page, or do nothing.
- **Requirements:** R1, R3, R6.
- **Dependencies:** none.
- **Files:** `app/src/item/thread-follow.ts`, `test/thread-follow.test.ts`.
- **Approach:** input is `scrollTop`, `clientHeight`, whether the reader is scrolling, whether the window has hidden rows above (`start > 0`), and whether an older page can be asked for and wasn't already asked for at this length. A zero `clientHeight` (a hidden pane) does nothing, as today. Distances per KTD1, reusing `REVEAL_PX` without changing it.
- **Patterns to follow:** `keepsFollowing` and `newSince` in the same file; tests in `test/thread-follow.test.ts`.
- **Test scenarios:**
  - Reader scrolling, `scrollTop` 1500 in a 700px window, rows above: reveal (inside 2100px, past the old 800px).
  - Reader scrolling, `scrollTop` 2500 in a 700px window: nothing.
  - Reader scrolling, `scrollTop` 600 in a 200px window: reveal (the 800px floor holds).
  - Not scrolling (open, find, Latest), `scrollTop` 1500 in a 700px window: nothing; `scrollTop` 700: reveal, as today.
  - At the window's top (`start` 0), reader scrolling, an older page available: ask for it; already asked at this length: nothing.
  - `clientHeight` 0: nothing.
- **Verification:** the tests pass, and without reader input every case matches today's 800px rule.

### U2. The thread reveals ahead while you scroll, one chunk at a time

- **Goal:** `useThreadWindow` in `app/src/item/timeline.tsx` uses U1, knows when the reader is scrolling, and never stacks reveals.
- **Requirements:** R1–R6.
- **Dependencies:** U1.
- **Files:** `app/src/item/timeline.tsx`, `app/src/item/thread-follow.ts`, `test/thread-follow.test.ts`.
- **Approach:**
  1. The viewport's `onWheel`, `onKeyDown` and `onTouchMove` record when the reader last scrolled (KTD2).
  2. `nearTop` asks U1 what to do instead of comparing with `REVEAL_PX`.
  3. A reveal calls `beforeReveal`, then moves the start only from the start that triggered it (KTD3).
  4. `older()` is asked from the same distance (R3). Nothing else is added for R2 (KTD4).
- **Patterns to follow:** the existing `useThreadWindow` state shape (`id`, `start`, `first`, `above`) and its `asked` ref; the existing `onWheel`/`onKeyDown` handlers in `ThreadBody`.
- **Test scenarios:**
  - The window update from a start that is no longer current returns the window unchanged (KTD3), as a pure updater exported from `thread-follow.ts`.
  - Reader input handling and the chain are checked by hand (Verification Contract), since they depend on real layout and scroll events.
- **Verification:** the by-hand rows of the Verification Contract.

### U3. The manual

- **Goal:** the manual describes loading older rows as it now works.
- **Requirements:** R1.
- **Dependencies:** U2.
- **Files:** `docs/manual.md`.
- **Approach:** the line "loads older ones 20 at a time as you scroll up, keeping your place" says they load 20 at a time a few screens before you reach them, keeping your place.
- **Test expectation:** none -- documentation.

## Verification Contract

| Gate | Command or check | Applies to |
|---|---|---|
| Format, lint, types | `bun run format:check && bun run lint && bun run typecheck` | all units |
| Tests | `bun run test && bun run test:node` | U1, U2 |
| Builds and smoke | `bun run build:app && bun run build:mod && bun run smoke` | all units |
| CI toolchain | Newest Node 22, the bun in `package.json`'s `packageManager`, `SHELL=/bin/bash` | before push |
| By hand, browser: scroll up | Desktop page on `npm run phone-preview`'s daemon, a chat of 80+ rows: scrolling up hard from the bottom, each wheel moves `scrollTop` by its full delta (no clamp), the row being read stays put when rows land, and each burst mounts one chunk (R1, R4, R5) | U2 |
| By hand, browser: chain | In a tall window, one scroll that leaves the reader inside the distance mounts the next chunk with no further gesture (R2) | U2 |
| By hand, browser: unchanged paths | Opening the long chat mounts its newest 60 rows; find for an early word reaches it; ↓ Latest folds back to 60 (R6) | U2 |
| By hand, Mac app | A strong trackpad flick up through a long chat glides without a bounce, stop or jump, including while a reply streams (Objective; stop conditions) | U2 |
| PR title | `PR_TITLE="fix(chat): …" node --experimental-strip-types scripts/check-pr-title.ts` | the PR |

## Definition of Done

- R1–R6 each have a passing test or a by-hand check from the Verification Contract.
- All checks pass with CI's toolchain, and the PR's CI, Windows included, is green.
- The Mac app check passes before merge (the owner's app is WebKit; the browser checks are Chromium).
- No comment outside the kinds AGENTS.md allows.
- This plan ships in the PR that builds it.

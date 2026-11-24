---
title: Older messages load while the thread is still - Plan
type: fix
date: 2026-11-24
topic: chat-reveal-at-rest
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
execution: code
---

# Older messages load while the thread is still - Plan

## Goal Capsule

- **Objective:** flicking up through a long desktop chat in the Mac app never lands the reader somewhere they did not scroll to.
- **Means:** the desktop thread mounts older rows, and corrects the reader's place, only while the thread is still; while it moves, nothing writes `scrollTop` to keep a place (KTD1–KTD3).
- **Product authority:** the owner, who reported the jumps and recorded them in the Mac app.
- **Stop conditions:** stop and ask if, in the Mac app, a reveal at rest still moves the row being read, or if opening a chat visibly flashes or shifts when rows are prefilled. Stop and bring the bottom-anchored scroller (Scope Boundaries) to the owner if meeting the top of the loaded rows on a long flick is not acceptable; don't just raise the distance.
- **Execution profile:** the desktop thread (`app/src/item/timeline.tsx`, `app/src/item/thread-follow.ts`, `app/src/item/use-keep-place.ts`), their tests, one line of `docs/manual.md`. Branch `fix/chat-reveal-at-rest`, commit scope `chat`.
- **Open blockers:** none.

## Product Contract

### Summary

Older rows load while the thread is still, until five screens are loaded above you. While you scroll, nothing is loaded and your place is not corrected, so the scroll is only ever the one your fingers made. A flick longer than what is loaded meets the top of it, and the next rows land once it settles.

### Problem Frame

This follows `docs/plans/2026-11-24-1231-fix-chat-reveal-ahead-plan.md` (PR #369) and hits its first stop condition. #369 mounts older rows mid-scroll, three screens ahead of the reader, and each mount writes `scrollTop` to keep the reader's place. Recorded in the owner's Mac app (WKWebView, a build with #369) on a real chat, one flick up from the bottom:

- The thread held 24 entries, `scrollTop` 1047, `scrollHeight` 1919, in a window about 872px tall. Four reveals chained in 110ms (24, 33, 37, 46, 53 entries: the whole chat, `scrollHeight` 4264), because the reader was still inside three screens after each.
- Each reveal wrote `scrollTop` mid-gesture: MessageScroller's `scrollTo`, then `keepReading` from a layout effect, and once more after a 23px size change.
- WebKit's scrolling thread raced those writes. Successive reads of `scrollTop` alternated between two positions' histories (1466, 950, 1457, 2295, 1141, 1831, 2248), and writes started from stale values (1040 just after a `scrollTo` to 1166; 1167 just after a write to 2295).
- The wheel deltas over the burst summed to about 358px, so the reader belonged at 1047 + 2345 − 358 = 3034. The view settled at 2248: 786px, most of a screen, too high. The row at the top went from 6th from the end to 29th.
- After the last reveal the glide ran smoothly to the top with no writes. The writes did not end momentum, and rows changing height after mounting was one 23px change.

So the jump is place-keeping writes lost to the scrolling thread while a gesture is in flight. #369's measurement was Chromium, which does not do this.

### Requirements

- R1. Older rows are mounted, and the daemon is asked for an older page, only when the desktop thread has been still for a moment: no wheel, key, touch or scroll event.
- R2. While still, rows mount one chunk at a time until five screens are loaded above the reader or no older rows are left.
- R3. While the thread moves, nothing writes `scrollTop` to keep the reader's place. A size change above the reader then moves what they see by that much, once, and is not put back.
- R4. While still, the reader's place is kept exactly as today when rows land above or something above changes size.
- R5. A chat opens on the same rows as today; rows prefilled after that do not move what is on screen. Find and ↓ Latest are unchanged.

### Scope Boundaries

- This reverses #369's reveal-while-scrolling on the desktop thread, on the recording above. #369's keyed, one-at-a-time window update stays.
- The phone thread (`app/src/chat/use-transcript-scroll.ts`) and `REVEAL_PX` are not changed.
- Streaming, sending and following the bottom are not changed.
- The cost: up to five screens of rows above the reader stay mounted, beyond the newest 60. ↓ Latest folds the window back as today.
- Known limit: a flick that travels more than what is loaded above meets the top of the loaded rows (the rubber band), and older rows land once it settles.
- Considered and not built: a bottom-anchored scroller (`flex-direction: column-reverse`), where rows landing above need no `scrollTop` write at all. It removes the known limit, and it rewrites the MessageScroller layer; the owner decides (a stop condition).
- Considered and not built: a placeholder of estimated height above the loaded rows. Its estimate is corrected with the same write, mid-gesture.

### Sources / Research

- The owner's recording in the Mac app, 2026-11-24: every `scrollTop` write, `scrollTo`, scroll event and wheel event on `[data-thread-scroll]`, summarised in the Problem Frame.
- Between separate pushes of one flick the wheel events paused for 32–50ms, and the rubber band's return fired scroll events up to 109ms after the last wheel event; 150ms without either is taken as still.
- `9eb62082` (PR #270) built `use-keep-place.ts` for the Mac app's WebKit, which has no scroll anchoring; this plan keeps it for the thread at rest.

## Planning Contract

### Key Technical Decisions

- KTD1. **One rest timer.** Every wheel, key, touch and scroll event on the viewport restarts a 150ms timer (`REST_MS`); so do the window's start and the row count changing. When it fires the thread is still, and it checks the top once. A reveal changes the start, which restarts the timer, so the chain to five screens is the same timer firing again, one chunk per rest. Governs R1, R2.
- KTD2. **One distance.** At rest the thread reveals, or asks for an older page, within `max(REVEAL_PX, 5 × clientHeight)` of the top (`SCREENS_AHEAD`). The one-second "reader is scrolling" mark and the two distances from #369 go. Governs R2.
- KTD3. **Place-keeping reads while moving, writes while still.** On a scroll event the thread only notes the row being read. On a size change it corrects the place if the rest timer is not running, and otherwise notes the row afresh. Governs R3, R4.
- KTD4. **The timer is plain code with its scheduler passed in**, so tests drive it without real time. Governs R1.

### Sequencing

U1 (the pure parts), then U2 (the thread uses them), then U3 (manual).

## Implementation Units

### U1. Still or moving, and what to do at the top

- **Goal:** a rest timer with an injected scheduler, and the top-of-thread decision with one distance.
- **Requirements:** R1, R2.
- **Dependencies:** none.
- **Files:** `app/src/item/thread-follow.ts`, `test/thread-follow.test.ts`.
- **Approach:** `nextAbove` loses its `scrolling` input and uses the one distance. `readerScrolling` and `READER_MS` are removed. A small rest timer takes what to call at rest and a scheduler (set and clear); it exposes "moved" and "moving".
- **Patterns to follow:** the pure helpers and tests already in these two files.
- **Test scenarios:**
  - `scrollTop` 3000 in a 700px window with rows above: reveal (inside 3500px); `scrollTop` 3600: far.
  - `scrollTop` 600 in a 100px window: reveal (the 800px floor).
  - Every row drawn, an older page available: older, once per length; none available: nothing.
  - `clientHeight` 0: far.
  - The timer: not moving before any event; moving after one; a second event before it fires postpones the call; it calls once at rest and is then not moving; stopping it cancels the call.
  - `revealFrom` cases stay as they are.
- **Verification:** the tests pass.

### U2. The thread loads and corrects only at rest

- **Goal:** the desktop thread uses U1: no reveal, older-page request or place-keeping write while it moves.
- **Requirements:** R1–R5.
- **Dependencies:** U1.
- **Files:** `app/src/item/timeline.tsx`, `app/src/item/use-keep-place.ts`, `test/keep-place.test.ts`.
- **Approach:**
  1. The viewport's `onScroll`, `onWheel`, `onKeyDown` and `onTouchMove` mark the thread as moved; an effect does the same when the start or the row count changes, and stops the timer on unmount.
  2. At rest, the top check runs against the viewport: `beforeReveal`, then the keyed window update, or the older-page request, as today.
  3. `useKeepPlace` takes "moving": its scroll handler only notes the reading row; its size observer corrects only when not moving.
- **Patterns to follow:** `useKeepPlace`'s refs and effects; the `asked` ref in `useThreadWindow`.
- **Test scenarios:**
  - Moving, a row above grows: `scrollTop` is not written, and the next correction at rest starts from the new place.
  - Still, a row above grows: `scrollTop` moves by the growth, as today.
  - The existing reveal cases in `test/keep-place.test.ts` hold at rest.
- **Verification:** the by-hand rows of the Verification Contract.

### U3. The manual

- **Goal:** the manual says when older rows load.
- **Requirements:** R1.
- **Dependencies:** U2.
- **Files:** `docs/manual.md`.
- **Approach:** the line "20 at a time a few screens before you reach them" says they load 20 at a time while the thread is still, a few screens ahead of you.
- **Test expectation:** none -- documentation.

## Verification Contract

| Gate | Command or check | Applies to |
|---|---|---|
| Format, lint, types | `bun run format:check && bun run lint && bun run typecheck` | all units |
| Tests | `bun run test && bun run test:node` | U1, U2 |
| Builds and smoke | `bun run build:app && bun run build:mod && bun run smoke` | all units |
| CI toolchain | Newest Node 22, the bun in `package.json`'s `packageManager`, `SHELL=/bin/bash` | before push |
| By hand, Mac app: flick | A hard flick up through a long real chat, idle and while a reply streams: the view never lands somewhere unrelated. The recorder shows no `scrollTop` write between the first and last wheel event of a gesture (R1, R3) | U2 |
| By hand, Mac app: prefill | A chat opens at its bottom with no flash or shift; left alone, entries above grow until five screens are loaded (R2, R5) | U2 |
| By hand, Mac app: unchanged paths | Find for an early word reaches it; ↓ Latest folds back; a picture loading above a still reader does not move the row being read (R4, R5) | U2 |
| PR title | `PR_TITLE="fix(chat): …" node --experimental-strip-types scripts/check-pr-title.ts` | the PR |

## Definition of Done

- R1–R5 each have a passing test or a by-hand check from the Verification Contract.
- All checks pass with CI's toolchain, and the PR's CI, Windows included, is green.
- The owner has felt it in the Mac app; a browser check does not stand in for it.
- No comment outside the kinds AGENTS.md allows.
- This plan ships in the PR that builds it.

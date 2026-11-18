---
title: The phone, previewed in a browser - Plan
type: feat
date: 2026-11-18
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
execution: code
---

# The phone, previewed in a browser - Plan

---

## Goal Capsule

- **Objective:** A person or an agent working on loki's phone can see the real phone screens, with made-up data, in a desktop browser at iPhone size from one command. They can screenshot them in day, night and Increase Contrast without a phone, a Simulator, or touching `~/.loki` and the running daemon.
- **Means:** a dev-only script starts a throwaway daemon on a scratch folder, seeds it through its own frames with the test suite's made-up ACP agent, and prints a pairing link (KTD1, KTD2, KTD3).
- **Authority:** the Requirements, then the Key Technical Decisions, then the units.
- **Stop conditions:** stop and ask if any of these happens:
  - The preview needs a change in `app/`, `mod/` or `daemon/` to work.
  - Seeding cannot produce a Flow card without a real model or account.
- **Execution profile:** `scripts/`, one npm script, a small branch in `test/fixtures/fake-acp.mjs`, `docs/CONTRIBUTING.md` and a test. One PR.
- **Who finishes:** `ce-work` on `feat/phone-preview`. Done is shown by screenshots taken through the preview in the built-in browser: Home, Flow, a conversation and a sheet, each in day and night, and one in Increase Contrast.

---

## Product Contract

### Summary

`npm run phone-preview` builds the phone's page if needed and starts a daemon on a scratch folder with its own ports and the phone listener on. It seeds three made-up agents and a handful of chats through a made-up ACP agent, some of them waiting on an approval. It then prints a `localhost` link that pairs a browser as a phone on open, and a fresh one each time Enter is pressed. Edits under `app/` rebuild the page on their own. Ctrl-C stops the daemon and removes the folder.

### Problem Frame

Plan 2026-11-16-0959 changed every phone screen's layout and merged without anyone seeing it rendered. Three things got in the way. The phone page appears only on the daemon's phone listener after pairing. This Mac has no full Xcode for the iOS Simulator. Swapping the person's regular daemon for a branch's is refused by the permission check, and rightly: it is their working setup.

### Requirements

**Isolation**

- R1. The preview never reads or writes `~/.loki` or the keychain, never touches the person's running daemon and its ports, and never reaches a real model or account.
- R2. Nothing it adds ships: no change under `app/`, `mod/`, `daemon/`, and nothing in `npm run build:app` or `build:mod` output.

**What it shows**

- R3. The page is the real phone surface served by a real phone listener, so the screens, sockets and routes are the ones a paired iPhone gets.
- R4. It opens with made-up data, never real chats:
  - several agents and chats on Home;
  - at least one chat waiting on an approval, so Flow has a card and the conversation shows its dock;
  - a long chat, so threads scroll under the floating bars.
- R5. A printed link pairs the browser on open, with no code to type, for as long as the preview runs.

**Use**

- R6. One command starts it and Ctrl-C stops it, removing the scratch folder unless `--keep` is passed. An edit under `app/` shows on the next reload.
- R7. `docs/CONTRIBUTING.md` says how to run it and how to view it at iPhone size in day, night and Increase Contrast.

### Scope Boundaries

- Safari- and iPhone-exact rendering: the preview runs in Chromium, so blur, safe areas and Dynamic Type are approximations.
- Gmail, Slack and Jira cards. They need accounts and syncs that would run and fail. Considered and not built; a fake account fixture could add them later.
- A fixture-based phone frame in the dev workbench. Considered and not built: a dozen screens' props would drift from the real ones.
- A separate made-up agent in `scripts/`. Considered and not built: `test/fixtures/fake-acp.mjs` already answers plainly and asks permission for an edit, and a second copy of the protocol would drift.

### Sources

- `scripts/smoke.ts`: starting an isolated daemon, waiting on `/health`, and the frame helper.
- `test/fixtures/fake-acp.mjs`, `test/acp-chats.test.ts`: a made-up ACP agent and how a chat runs on it.
- `mod/lan.ts`, `mod/pairing.ts`: the phone listener's state file, `/pair`, the pair URL, and codes that live ten minutes and pair once.
- `app/src/phone/pair.tsx` and `model.ts` `codeFromUrl`: a `?code=` link pairs on open.
- `daemon/main.ts`: under `mod/boot.ts` it watches `core/`, `daemon/` and `mod/` and exits to be restarted on a change; `LOKI_BUILT_PAGE=1` rebuilds `app/dist` on an `app/` change.

---

## Planning Contract

### Key Technical Decisions

- KTD1. **A throwaway daemon from source, isolated by environment.** It runs `daemon/main.ts --loki-daemon` with `mod/boot.ts`. Its environment:
  - `LOKI_DIR` and `HOME` on the scratch folder, `LOKI_SKILLS_DIR` under it, `LOKI_KEYCHAIN=0` and `LOKI_ANALYTICS=0`;
  - free ports for `LOKI_PORT` (the desktop socket) and `LOKI_LAN_PORT` (the phone listener);
  - `LOKI_BUILT_PAGE=1`, so an `app/` edit rebuilds the page;
  - no provider credentials: every variable pi-ai's `env-api-keys` reads, and `AWS_*`, are removed, so background passes cannot reach a real model.

  The phone listener is switched on by writing `state/lan.json` as `{"enabled": true, "via": "lan"}` before start; `via: "lan"` keeps a running Tailscale out of the pair URL. (R1, R3, R6)

- KTD2. **Seeded through the daemon's own frames, with `test/fixtures/fake-acp.mjs`.** Transcripts live in per-agent SQLite stores, so writing them by hand would copy internals. The seed connects to the socket and runs a real turn per chat:
  - `chat_engine_set` registers the fixture as an ACP engine;
  - `chat_agent_create` makes each of the three agents;
  - `chat_create` and `chat_model` (`acp:<id>/default`) start each chat on it;
  - `chat_send` runs each turn.

  An `edit` message leaves a permission request pending, which makes the Flow card and the conversation's approval. The fixture gains one branch: a `long` message answers with many paragraphs. (R3, R4)

- KTD3. **The socket helper waits on pushes, not only replies.** `smoke.ts`'s `connect` resolves only messages with a `request_id`. The preview's helper adds a push listener keyed by type, agent and conversation:
  - `pair_begin`'s answer is the `pair_code` push;
  - a plain or long chat is seeded at its `turn_end` chat event;
  - a permission chat is seeded at its `approval` chat event, since its turn never ends.

  (R4, R5)

- KTD4. **Pair links are rewritten to `localhost` and minted on demand.** The daemon's `pair_code` URL names the Mac's Bonjour host, and a code lives ten minutes and pairs once. The script prints `http://localhost:<lan port>/?code=<code>` after seeding, and a fresh one each time Enter is pressed in its terminal. A paired browser stays paired by its cookie for the rest of the run. `localhost` rather than `127.0.0.1` matters because cookies are per host, not per port: a `127.0.0.1` pairing could overwrite the cookie a real listener on that host set. (R5)
- KTD5. **A daemon that exits on its own is started again.** Under `mod/boot.ts` the daemon exits after a `core/`, `daemon/` or `mod/` edit, expecting the Mac app to restart it. The script restarts it on the same folder and ports. It also sends the permission chats again, since the pending approval died with the old process. Ctrl-C is the only stop. (R6)
- KTD6. **The phone page is built only when missing.** The script runs `npm run build:app` when `app/dist/index.html` is absent; after that `LOKI_BUILT_PAGE` keeps it current. (R3, R6)
- KTD7. **Pure helpers are tested; the run is checked by hand.** These are plain functions tested in `test/phone-preview.test.ts`:
  - the environment and port assembly;
  - the pair-link rewrite;
  - the restart decision;
  - the seed's list of frames.

  Starting a daemon in the vitest suite would duplicate `smoke.ts` and slow every run. (R1, R5, R6)

---

## Implementation Units

### U1. Start an isolated daemon with the phone listener on

**Goal:** `scripts/phone-preview.ts` starts a daemon on a scratch folder with its own ports and the phone listener on. It waits for the daemon, restarts it if it exits on its own, and stops and cleans up on Ctrl-C.

**Requirements:** R1, R2, R3, R6

**Dependencies:** none

**Files:** `scripts/phone-preview.ts` (new), `package.json` (the `phone-preview` script), `test/phone-preview.test.ts` (new)

**Approach:**

1. Make the scratch folder (`mkdtemp` under `tmpdir()`) and write `state/lan.json` (KTD1).
2. Build the phone page if needed (KTD6).
3. Spawn the daemon with the KTD1 environment and wait for `/health` and the token file, as `smoke.ts` does.
4. Restart it on an exit Ctrl-C did not cause (KTD5).
5. On SIGINT or SIGTERM, stop the daemon (SIGTERM, then SIGKILL after 5 s) and remove the folder unless `--keep`.

**Patterns to follow:** `scripts/smoke.ts` (`freePort`, its daemon start, wait and stop).

**Test scenarios:**

- The environment for a scratch folder sets `LOKI_DIR` and `HOME` to it, `LOKI_KEYCHAIN` to `0`, `LOKI_BUILT_PAGE` to `1`, and `LOKI_PORT` and `LOKI_LAN_PORT` to the given ports. It never names the real home.
- Given a parent environment holding `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` and `AWS_SECRET_ACCESS_KEY`, the daemon's environment holds none of them.
- The `lan.json` written is `{"enabled": true, "via": "lan"}`.
- The restart decision is yes for an exit while running and no once stopping has begun.
- `--keep` parses; any other flag is an error that names it.

**Verification:** running it prints the two ports and leaves `~/.loki` and the regular daemon untouched. Editing a file under `daemon/` restarts the preview's daemon rather than ending it. Ctrl-C removes the scratch folder.

### U2. Seed made-up agents and chats

**Goal:** the preview opens with three agents, chats on Home, a long chat, and at least one chat waiting on an approval in Flow.

**Requirements:** R3, R4

**Dependencies:** U1

**Files:** `scripts/phone-preview.ts`, `test/fixtures/fake-acp.mjs` (the `long` branch), `test/phone-preview.test.ts`

**Approach:**

1. Add the `long` branch to the fixture (KTD2).
2. Connect with the push-aware helper (KTD3) and send the seed frames in order. Each chat waits for its `turn_end`, or its `approval` for a permission chat, before the next.
3. Leave the permission chats pending.

**Patterns to follow:** `test/acp-chats.test.ts` (registering an engine and running a chat on the fixture); `smoke.ts`'s `connect` and `request`.

**Test scenarios:**

- The seed plan names three agents, gives each at least two chats, and includes one `long` chat and at least one `edit` chat.
- The fixture, sent `long`, answers with several paragraphs (in `test/acp-chats.test.ts`, alongside its other replies).
- The helper resolves a waiter on a matching push without a `request_id` and ignores pushes for other conversations.

**Verification:** after seeding, the throwaway daemon's Flow holds at least one card and Home lists the seeded chats.

### U3. Pair by link, and document it

**Goal:** the script prints a link that pairs a browser as a phone, prints a fresh one on Enter, and `docs/CONTRIBUTING.md` explains the preview.

**Requirements:** R5, R6, R7

**Dependencies:** U2

**Files:** `scripts/phone-preview.ts`, `docs/CONTRIBUTING.md`, `test/phone-preview.test.ts`

**Approach:**

1. Send `pair_begin`, wait for the `pair_code` push, and print the `localhost` link (KTD4) with `LOKI_PORT` beside it. Do it again on each Enter.
2. Keep running until Ctrl-C.
3. Add a "Phone preview" part to CONTRIBUTING covering:
   - the command;
   - opening the link at 390 × 844, and that a link pairs once within ten minutes, with Enter giving another;
   - switching day and night, and emulating Increase Contrast;
   - that `app/` edits rebuild the page and `core/` or `daemon/` edits restart the daemon;
   - what it does not show (Scope Boundaries).

**Test scenarios:**

- The pair link for code `AB12CD` and LAN port 50123 is `http://localhost:50123/?code=AB12CD`, whatever host the daemon's own URL named.

**Verification:** in the built-in browser at 390 × 844, the printed link pairs and opens Home with the seeded chats. Flow shows a card, a conversation shows its floating dock, and Home's menu sheet opens. Each of the four is screenshotted in day and in night, and one in Increase Contrast, for the PR.

---

## Verification Contract

| What      | How                                                                                                                                                                                                    |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Checks    | `npm run format:check && npm run lint && npm run typecheck && npm test && npm run test:node`, then `npm run build:app && npm run build:mod && npm run smoke`, on Node 22, npm 10 and `SHELL=/bin/bash` |
| New tests | `test/phone-preview.test.ts` (U1–U3), and the `long` reply in `test/acp-chats.test.ts`                                                                                                                 |
| By hand   | `npm run phone-preview`, open the link in the built-in browser at 390 × 844 and take the U3 screenshots. Confirm `~/.loki` and port 41414 are untouched                                                |
| PR title  | `feat(phone): preview the phone in a browser with made-up data`                                                                                                                                        |

---

## Definition of Done

- The preview runs from one command, shows the seeded screens through a link that pairs on open, survives a daemon restart, and stops cleanly.
- `~/.loki`, the keychain, the regular daemon and real models are untouched by a run.
- Nothing under `app/`, `mod/` or `daemon/` changed.
- CONTRIBUTING explains it; the tests pass; the PR has the U3 screenshots.
- No abandoned attempts left in the diff.

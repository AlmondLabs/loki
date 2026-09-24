---
title: Loki on Windows and Linux - Plan
type: feat
date: 2026-09-24
topic: loki-windows-linux
artifact_contract: ce-unified-plan/v1
artifact_readiness: requirements-only
product_contract_source: ce-brainstorm
execution: code
---

# Loki on Windows and Linux - Plan

## Goal Capsule

- **Objective:** Someone on Windows or Linux can download loki from its GitHub release, install it, and use the same desk, inbox, board, agents and Learn as a Mac user, with the builds clearly marked as a preview until people confirm they work.
- **Product authority:** The user's decisions in the 2026-09-24 brainstorm. The macOS app as shipped in stable 2026.9.23 (the Slack layout of plans 012 and 013) is the behaviour to match.
- **Open blockers:** None.

---

## Product Contract

### Summary

Preview builds of loki for Windows and Linux, from the same code and on the same nightly and stable releases as the Mac. They cover the core (Desk, Inbox, Board, Agents, Learn, Preferences and the mod) and behave like the Mac: loki finds a running Letta harness and attaches to it, or starts its own.

### Problem Frame

loki is public on GitHub, but it only runs on macOS 13 or later. Releases build one universal Mac app, CI runs only on macOS, and installs go through a Homebrew tap. The Rust shell and the mod find Letta, Node and a running harness through Mac and Unix paths and tools, the folder picker is AppleScript, and every shortcut is drawn with ⌘. Letta Code itself is a Node program with Windows handling of its own, so the agents loki fronts could run on Windows and Linux; loki is the part that cannot. Nobody on the project has a Windows or Linux machine, so anything shipped for them is tested only by CI runners and by the people who report back.

### Key Decisions

- **Same behaviour on every OS: attach to a running harness, else start one.** Governs R6. (session-settled: user-directed — chosen over loki always starting its own harness on Windows and Linux: one behaviour everywhere, and Letta Desktop users share their agents with loki.)
- **Windows and Linux together, core features first.** Most of the porting (process lookup, install paths, window chrome, packaging) is shared between them. Governs R1, R2, R3. (session-settled: user-directed — chosen over Windows-only core first, and over full parity with the Mac extras: one pass covers both systems.)
- **Unsigned installers on the GitHub release; package managers later.** Matches the Mac, which is unsigned too. Governs R9, R10. (session-settled: user-approved — chosen over adding winget and Flatpak or AUR at launch, and over a code-signed Windows build: no paid signing account or outside review queues for a preview.)
- **Show how to install Node rather than downloading it.** Keeps the promise in docs/SECURITY.md that loki downloads no runtime of its own. Governs R7. (session-settled: user-approved — chosen over loki fetching a private Node, and over installers that bring Node: no runtime for loki to keep patched.)
- **Preview label until users confirm.** Nobody can try these builds on real hardware. Governs R12, R13. (session-settled: user-approved — chosen over nightly-only builds and over shipping them unlabelled: people can install them from stable, and know what they're getting.)
- **The window follows Slack's Windows and Linux layout.** loki draws its own title strip with minimise, maximise and close on the right, as Slack does there, rather than the system title bar; the Slack direction set in plans 012 and 013 applies. Governs R4.

### Requirements

**Platforms and scope**

- R1. loki installs and runs on 64-bit Windows 10 and 11 and on current 64-bit desktop Linux (Ubuntu and Debian families first, through the .deb; other distributions through the AppImage).
- R2. On Windows and Linux, Desk, Inbox, Board, Agents, Learn, Preferences, search and the mod behave as they do on the Mac.
- R3. The Mac-only extras (phone pairing over the LAN and Tailscale, dictation, the menu-bar or tray item, the dock badge, and the global Catch Up shortcut) are hidden on Windows and Linux. Where one would appear, loki says it is not on this system yet rather than showing a control that fails.

**Window and keys**

- R4. On Windows and Linux the window has loki's own title strip in the Slack layout: it drags the window, double-click maximises, and minimise, maximise and close sit on the right.
- R5. Every shortcut works with Ctrl in place of ⌘ on Windows and Linux, and every place that shows a shortcut (menus, the keys sheet, Preferences › keys, tooltips, the docs) shows Ctrl there. A shortcut that collides with a system-reserved key on that OS is reassigned there and listed under its new key.

**Harness and first run**

- R6. On launch, loki looks for a Letta harness already running on the machine (Letta Desktop, or a `letta server` the user started) and attaches to it, as it does on the Mac; finding none, it starts its own.
- R7. When Letta Code is missing, loki installs it with npm as on the Mac. When no Node 22 or newer is found, Welcome says Node is needed, links to nodejs.org, names the system's usual install command (winget on Windows, the package manager on Linux), and checks again with one button. loki never downloads Node itself.
- R8. Folder choice works on every system, using that system's own folder dialog.

**Distribution and updates**

- R9. Every nightly and stable release carries a Windows installer and a Linux AppImage and .deb beside the Mac files, built by the same release run.
- R10. The Windows and Linux files are unsigned. The README and manual describe the warning each system shows on first run (Windows' "unknown publisher" SmartScreen screen; the AppImage's executable bit) and how to get past it, as they do for Gatekeeper today.
- R11. The in-app update check tells Windows and Linux users about a newer build on their channel and links to that system's download.

**Preview and confidence**

- R12. Until users confirm, the README, the release notes and loki's About screen call the Windows and Linux builds a preview ("built and tested in CI, not yet tried on real machines") and link to where to report problems.
- R13. CI builds and runs the test suite on Windows and Linux runners on every pull request, and exercises the harness lookup of R6 there against a stand-in harness, not only the build.

### Acceptance Examples

- AE1. **Covers R6.** Given Letta Desktop is running on a Windows PC, when loki launches, then it attaches to that harness and shows the same agents and conversations, and no second harness starts.
- AE2. **Covers R6.** Given nothing Letta is running on a Linux machine, when loki launches, then it starts its own harness and the desk opens once it is ready.
- AE3. **Covers R7.** Given a Windows PC with no Node, when loki first launches, then Welcome says Node 22 or newer is needed, shows the winget command and a link, and after the user installs Node and presses the re-check button, installs Letta Code and continues.
- AE4. **Covers R3.** Given loki on Linux, when the user opens Preferences › phone, then it says phone pairing is not on Linux yet instead of showing a pairing code.
- AE5. **Covers R5.** Given loki on Windows, when the user presses Ctrl+K, then search opens, and the keys sheet lists it as Ctrl K.

### Scope Boundaries

- Phone pairing, Tailscale, dictation, the tray item and the global shortcut on Windows and Linux (deferred; R3 hides them).
- winget, Scoop, Flathub, AUR or Snap packages (deferred).
- Code signing for Windows or Linux (deferred).
- ARM builds for Windows and Linux (deferred; 64-bit x86 only).
- Changing any Mac behaviour, except where shared code must learn about the other systems.

### Dependencies / Assumptions

- Letta Code runs on Windows and Linux. The installed 0.32.18 declares no OS restriction and has Windows branches (npm.cmd, PowerShell, drive-letter paths); this is observed, not tested.
- Letta Desktop exists for Windows or Linux and runs the same app-server protocol as on the Mac (unverified). If it doesn't, R6 still holds for a `letta server` the user started.
- GitHub's hosted Windows and Ubuntu runners can build Tauri 2 installers and run the test suite.

### Outstanding Questions

**Deferred to Planning**

- Which reserved-key collisions exist (for example Alt+Space, which opens the window menu on Windows) and what each moves to (R5).
- How loki finds a running harness on each system without `lsof` and `ps` (R6).
- Where the Windows and Linux Node, npm and Letta Code install locations are searched (R7).
- The stand-in harness CI uses for R13, and whether a launch smoke test of the built app is feasible on the runners.
- What the About screen's preview line looks like and where "not on this system yet" appears for each hidden extra (R3, R12).

### Sources / Research

- Mac-only paths: `src-tauri/src/appserver.rs` (lsof, ps), `src-tauri/src/bootstrap.rs` and `src-tauri/src/install.rs` (Homebrew and Unix install paths), `src-tauri/src/scratch.rs` and `src-tauri/src/lib.rs` (Unix permissions), `mod/app-server.ts` (lsof, ps), `mod/folders.ts` (AppleScript picker), `mod/tailscale.ts`, `scripts/dev.ts` (`:` PATH separator).
- Shortcuts: `app/src/shell/keymap.ts` already matches "cmd" as Meta or Ctrl; the ⌘ glyph is written into display text across `app/src`.
- Update check: `app/src/shell/useLokiUpdate.ts` reads only the release's tag and name and links to the release page.
- Releases and CI: `.github/workflows/release.yml` and `ci.yml` (macOS only), `scripts/release.ts`, `scripts/cask.ts`.
- Portability guard: `test/core-portability.test.ts` keeps `core/` free of browser and Tauri globals.
- Earlier plans listing Windows and Linux as out of scope: `docs/plans/2026-09-07-006-feat-loki-onboarding-plan.md`, `docs/plans/2026-09-07-007-feat-loki-mobile-plan.md`.

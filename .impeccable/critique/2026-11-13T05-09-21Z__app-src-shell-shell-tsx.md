---
target: loki Liquid Glass, round 2
total_score: 24
max_score: 40
na_heuristics: 
p0_count: 1
p1_count: 5
target_identity: "file:app/src/shell/shell.tsx"
target_fingerprint: "sha256:d72e21790aec02967e14532127de63835e9d754a5bd6f87bd44de78092e73851"
target_path: app/src/shell/shell.tsx
timestamp: 2026-11-13T05-09-21Z
slug: app-src-shell-shell-tsx
---
# Liquid Glass review, round 2 (2026-11-13)

Heuristics: 1:3 2:2 3:3 4:2 5:2 6:3 7:3 8:2 9:2 10:2 = 24/40 (Acceptable).

Verdict: the window frame, toolbar, sidebar material and thread now read as a Mac app. Everything that opens over the page (menus, pickers, ⌘K, ⌘N, the keys sheet) and every control smaller than a toolbar is still HTML.

Priority issues:
1. P0 Menus, pickers and dialogs are HTML: the model picker is a centered dialog that blurs the whole window; the right-click menu has ~34px rows of 15px text with no separators and no shortcuts; ⌘K, ⌘N and the keys sheet dim the whole window.
2. P1 ⌘N opens a six-field form; Messages and Notes create the item in place.
3. P1 The sidebar mixes places, the chat list and app status: two selections at once, a doubled "Chats" heading, a web-style search box, grey "main chat" rows, bold for unread, "Update Available" at the foot.
4. P1 The composer follows ChatGPT's layout: bordered pills with mismatched carets, a paper-plane send button that is pale while empty, five controls in the bottom row.
5. P1 Flow is a bordered card holding a whole chat under a stray lowercase "flow ▾"; no list.
6. P1 Lowercase controls ("not now", "effort", "low", "latest", "flow", "esc") follow the Slack-era house rule; Apple uses title case on buttons and menus.
7. P2 Thread carries Slack and developer habits: the blue "New" divider, the ">_" glyph, a red failure line after the agent recovered, the pop-up glyph on Plan, number badges on quick replies.
8. P2 Keys: ⌘⇧D toggles the sidebar and also denies in Flow; ⌘3 is missing; a bare "a" approves an agent's action.
9. P2 Learn's empty state is ~200 words at ~125 characters a line; outlined bold-blue buttons; Apple's default button is filled.
10. P3 Contrast: white initials on grey monograms 2.6:1; muted time on a selected row 4.0:1.

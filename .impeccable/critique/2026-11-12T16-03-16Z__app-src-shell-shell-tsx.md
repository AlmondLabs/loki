---
target: loki Liquid Glass desktop
total_score: 19
max_score: 40
na_heuristics: 
p0_count: 2
p1_count: 4
target_identity: "file:app/src/shell/shell.tsx"
target_fingerprint: "sha256:74be7061ad6d7b1fef383b725d180b1cd9cb54e6f763e3bd7bd40fe0dc93822f"
target_path: app/src/shell/shell.tsx
timestamp: 2026-11-12T16-03-16Z
slug: app-src-shell-shell-tsx
---
# Critique: loki Liquid Glass (desktop), 2026-11-12

Verdict: Slack's skeleton with Apple tokens and glass paint; does not read as an Apple first-party Mac app.

| # | Heuristic | Score |
|---|---|---|
| 1 | Visibility of status | 3 |
| 2 | Match real world | 1 |
| 3 | User control | 2 |
| 4 | Consistency and standards | 1 |
| 5 | Error prevention | 2 |
| 6 | Recognition over recall | 2 |
| 7 | Flexibility and efficiency | 3 |
| 8 | Aesthetic and minimalist | 1 |
| 9 | Error recovery | 2 |
| 10 | Help and docs | 2 |
| Total | | 19/40 Poor |

Priority issues:
- P0 Slack shell: labelled icon rail, red badges, channel-style agent groups, Preferences in the rail. Fix: one inset source list (Flow/Agents/Learn rows, per-agent sections, 11pt headers, 13pt rows, grey counts), Settings on cmd-comma.
- P0 No unified toolbar, fake glass: title/chip/Add Label loose; Messages/Canvas alone top-right; Archive pill under composer; Tauri window has no vibrancy (lib.rs TitleBarStyle::Overlay only) so blur paints over flat colour. Fix: 52pt toolbar with title+subtitle and trailing capsules; real NSVisualEffectView sidebar material or solid.
- P1 Thread grammar: bold name over every agent message, copy+time row under each, full-width grey "You" slabs. Fix: right-aligned user bubbles, nameless agent prose, time dividers at gaps, copy on hover/context menu, tool calls as one secondary line.
- P1 iOS type scale (13.5/15/17/22). Fix: 13 body and rows, 11 meta, 15 title, no bold selection, 24pt segmented controls.
- P1 Flow card overload: 7 decisions, 11 controls, 3 zones. Fix: during an approval show only question, preview, Don't Allow / Allow; Later/Archive to toolbar with keys; drop Mark as Read.
- P1 Red as attention colour x4 + Slack monogram avatars. Fix: blue unread dot, grey counts, symbol avatars.
- P2 Preferences as in-window modal with tabs in a pane and a palette picker. Fix: separate Settings window, grouped forms.
- P2 Empty states as essays (Learn). Fix: ContentUnavailableView.

Detector: 5 findings (3 side-tab in chat.css Slack quote/attachment bars, 2 bounce-easing in components.css springs), all judged false positives or intended.

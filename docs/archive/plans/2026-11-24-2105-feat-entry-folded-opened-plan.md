---
title: One head for every entry, folded or opened - Plan
type: feat
date: 2026-11-24
topic: entry-folded-opened
execution: code
---

# One head for every entry, folded or opened - Plan

## Why

Since the item components drew mail (969eddbe, 2026-11-12), an opened mail borrowed the Slack message row: name, time,
address and "to you, cc …" ran together on one small grey line with nothing cut off, the time sat mid-line while the
folded mails above it kept their date at the right edge, and a folded mail had no picture, so its name started 40px
left of the opened one's. The owner asked for the shared component to be fixed for every source, and for words for
the two states (2026-11-24).

## Decision

An **entry** has one **head** in both states: the face, the name, and when it was sent at the right edge.

1. **Folded**: the head and one line, the body's first words. Pressing it opens it.
2. **Opened**: the head with its detail after the name (a mail's address), its line (who a mail went to) and its body.

The words are in glossary.md (Entry; Folded, opened).

## What changes

1. `MessageEntry` (`app/src/item/message-entry.tsx`) takes `when`, `detail` and `line` in place of `note` and
   `status`, and draws them as the head and the line. `FoldedEntry` beside it draws the same head with one line, as
   one button.
2. A mail (`ItemMail` in `app/src/item/outside-rows.tsx`) is a `FoldedEntry` or a `MessageEntry`. Its date is the
   clock today and the day otherwise, the same in both states. Mails are parted by a hairline.
3. Slack and Jira entries carry their time at the right edge, with the day before it when the day changed mid-run
   ("Yesterday at 9:52 AM").
4. The face has a border and a fill that show on a dark window.

## Decisions for review

1. **Slack's time leaves the name's side** for the right edge, so every source follows one rule. Slack itself keeps
   it beside the name.
2. **Your own mail is an entry like anyone's**, named You, with where it went on its line. It was a tinted block
   with no face. The block was the only use of that branch of `MessageEntry`, so it is gone.
3. **A folded mail is two lines, not one**, about 20px taller each, so that folded and opened read as one thing.

## Not in this plan

The phone's list and the older `MailThread` (drawn when the item components are off) are untouched.

## Tests

`test/item-entries.test.ts`: the order of the head's parts and the line, no head later in a run, your own mail, the
folded entry. `test/item-outside.test.ts`: a folded and an opened mail share a head; your own mail.

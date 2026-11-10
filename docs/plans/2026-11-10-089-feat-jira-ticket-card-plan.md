# Plan 089: a Jira card shows the ticket, and Flow's settings name Jira

2026-11-10 · changes plan 2026-11-10-1451 (KTD14, KTD17; the Key Decisions "a ticket is the thread, an event is a
message" and "no new preference for Jira's later time")

## Why

A Jira card drew its ticket as an activity log: comments and field changes as one stream of lines, with no description
and no status, assignee or priority. The person wants the card to read like the ticket in Jira: its summary, its
description, its fields, and its comments.

Preferences › Flow names chats, email and Slack for what read and later do, and its help never mentions Jira. A Jira
card borrowed Slack's later time without saying so. The person wants Jira there like the other kinds, which reverses
plan 1451's choice of no Jira setting.

## What

**The card**

1. **Header:** the ticket's type, key and project on the first line, with the reach tag and "open in jira"; the
   summary as the title.
2. **Fields:** status, assignee, reporter, priority, sprint and labels, each shown only when the ticket has it. A field
   someone else changed since the card was last read is marked new, with what it was, who changed it and when.
3. **Also changed:** a change to a field the card does not show (rank, story points, anything else) is one line under
   the fields naming those fields, who and when, so a card never comes back for nothing the person can see.
4. **Description:** the ticket's description as text, folded after six lines with "show more". An edit to it since the
   last read is marked new.
5. **Comments:** oldest first, with the New line before the first comment not yet read, "load earlier", and the
   comment box, as now. Field changes are no longer lines in this list.
6. **The phone** shows the same parts, in sentence case, without the reach tag, as for every card there.
7. **The owner's tools and the hand-off** read the ticket the same way: summary, fields and description first, then
   the comments, then the field history.

What brings a card is unchanged (plan 1451, R6–R9, R27): any event by someone else on a watched ticket.

**Preferences › Flow**

8. **Later** gains a Jira row beside chats, email and Slack, a day unless the person picks another. A Jira card rests
   for its own time.
9. **Read, Archive and the page's help** say what they do to a Jira card: read ends it, archive and labels do not
   apply, and its cards are the watched tickets someone else changed.
10. **Older Macs and older files:** a set of return times without a Jira entry reads as having the default, so a paired
    Mac on an older loki and a saved file keep working.

## Decisions

1. **The card view returns the ticket, not a log.** It reads the issue's fields and description in one call, and the
   comments and history as now. Comments are the card's messages; field changes become the fields' "new" marks.
2. **Fields are a fixed set** (status, assignee, reporter, priority, sprint, labels, plus type and project in the
   header). The sprint is the site's field named "Sprint", found once per site; a site without one shows none. Custom
   fields beyond that are not shown; their changes reach the "also changed" line.
3. **A field's "new" mark is the newest change to it by someone else after the card's dealt mark**, with its "was"
   value being the value before the first such change, so two changes since the last read show as one.
4. **The description is plain text** from Jira's document format, as comments are (plan 1451, KTD15).
5. **Jira gets its own later time** (`later.jira`), default a day; `read_first` gains nothing, since read ends a Jira
   card.

## Tests

1. `test/jira-view.test.ts`: the card view returns summary, type, project, the fields, the description and the comments
   only; a status changed by someone else after the mark is new with its old value, who and when; two changes to one
   field show once with the first old value; the person's own change is not new; a change to an unshown field is in
   "also changed"; an edited description is marked; a site without a sprint field shows none.
2. `test/jira.test.ts`: the issue read asks for the fields and finds the sprint field by name once per site.
3. `test/outside-threads.test.ts`, `test/inbox-card.test.ts`, `test/phone.test.ts`: the card draws the header, fields
   with their new marks, the folded description and the comments with the New line; Gmail and Slack cards unchanged.
4. `test/rest.test.ts`, `test/settings*.test.ts`: a Jira card is its own kind with its own later time; a stored set
   without Jira reads with the default; the page lists Jira under later.
5. `test/account-tools.test.ts`, `test/handoff.test.ts`: the ticket text starts with summary, fields and description.

## Not built

1. Editing fields or the description from the card (plan 1451 keeps Jira's writes to the person's comment).
2. Rich text in the description (tables, images, panels): it reads as plain lines.
3. A Jira row under "read rests a card for": read ends a Jira card, so there is no rest to set.

---
title: The phone's Home finds chats by label, and its attention rows are one line
date: 2026-10-20
status: active
---

# The phone's Home finds chats by label, and its attention rows are one line

## Why

Plan 027 made a chat row one line on the Mac and the phone. Two pieces of the phone's Home were left for the person
to decide (2026-10-20):

1. **Needs your attention** kept its two-line rows (the agent's face, "Friday · finished", a dot). The person chose to
   keep the section and give it the same one-line rows.
2. **Labels.** The Mac lists a label's chats (`label:infra` in "Find a chat…", or a chip clicked); the phone can only
   set labels, from a chat's actions. The person files chats by hand in their titles ("[Long] - …") and will move
   that to labels themself: loki renames nothing.

## What changes

1. **Attention rows are one line**, read by the same rules as every other row (`deskRowState`): the chat's name,
   bold while it is new; after it, quietly, its agent (the section mixes agents); on the right the count while it
   waits on you, the pulsing dot while it runs, else the time. "n more in Inbox" loses its icon, as rows have none.
2. **Home's filter knows labels everywhere.** The `label:` terms (core/labels.ts `labelQuery`) narrow Needs your
   attention as they already narrow the agent sections (the Mac's `sidebarModel`): a chat shows when it carries every
   label named and its name or agent holds the words left.
3. **Picking a label.** Home's menu shows every label as a chip, in its colour, under the filter field; a tap adds
   `label:<name>` to the filter, a second tap takes it out.
4. **What is on, as pills.** Over the list, one pill per label in force (in its colour) and one for the words, each
   clearing only itself.

Nothing renames a chat or sets a label.

## Tests

1. `homeSections` (`test/phone.test.ts`): `label:long` keeps only attention items carrying it, two labels want
   both, and words still match names and agents.
2. `toggleLabelTerm` (`test/chat-rows.test.ts`): a chip adds its term and a second tap takes it out, the rest kept.
3. An attention row reads `deskRowState`, already tested; its look is checked by hand.
4. By hand: the demo phone, Home with a label picked, and Needs your attention, dark and light.

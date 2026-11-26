---
title: Preferences, grouped, on one page template
date: 2026-10-21
status: active
---

# Preferences, grouped, on one page template

## Why

On 2026-10-21 the person asked for a redesign of Preferences. Every page was rendered on a demo Mac and read side by
side:

1. **Fifteen pages in one list, in no order you could guess**: Usage between loki and Inbox, Labels between Chat and
   Files. Nothing says which pages belong together.
2. **Every page says its title twice**: the page heading, then the same word again over a description column that
   takes a third of the width, even on a page with one setting (`Section`, `app/src/settings/layout.tsx`).
3. **Controls do not agree**: pill chips for choices, a green filled button, a blue outlined one, grey outline ones,
   a switch.
4. **The machinery is on the surface**: temporary paths, `npx …` commands, all 42 providers in a list whether one is
   connected or not.
5. **"loki 2026.10.11 · browser tab" closes every page.**

The look stays Slack's (the redesign of 2026-10-18 was judged worse and dropped): Slack's Preferences is a large
modal with a grouped list down its left and plain sections on the right. So this changes Preferences inside that
look, one rendered step at a time, each checked before the next.

## What changes

1. **The list is the groups, and a group's pages are tabs** (`GROUPS`, `app/src/settings/pages.ts`). Fourteen pages
   under six headings made a list taller than the box, and its scrollbar sat over the rows; one row per group is six
   rows. A group opens on its first page, and its pages are a row of tabs under its title (`TabRow`, as Learn's views
   and an agent's pages are):
   1. General: Appearance, Chat, Keyboard shortcuts (was Keys).
   2. Models and tools: Providers, Engines, MCP servers (was MCP), Skills.
   3. Your devices: Macs, Phone.
   4. Inbox and Learn: Inbox, Learn.
   5. Labels.
   6. loki: About (was loki, and now holds Files), Usage.

   Preferences opens on Appearance when no page is remembered. ↑↓, Home and End in the list walk the groups; ←→ in
   the tabs walk a group's pages; ⌘[ ⌘] step every page in order, across groups.
2. **A filter over the list**: typing keeps the groups with a page whose name, group or words match (the words ⌘K
   search already had, now kept with the pages: "pair" finds Your devices). Enter opens the first page that matched;
   Esc clears the filter, then closes Preferences as before.
3. **One page template** (`Block`, `Setting`, `Segmented` in `layout.tsx`): the title once, in the header; a page
   is blocks, each an optional heading over rows divided by hairlines; a row is the setting's name with its help in
   muted type under it on the left, its control on the right.
4. **One rule per kind of control**: a switch for on or off; a segmented control for two to four values; one
   filled button for a page's main action; plain buttons for the rest; red only for what removes something.
5. **The version line leaves the page foot**; About already says the version and where loki runs.

Pages move to the template one step at a time:

1. The list, the filter, and Appearance and Chat.
2. Providers: connected ones first; "add a provider" opens a picker with a search.
3. Engines and MCP servers: a status row each, the commands and paths behind "details".
4. Macs and Phone.
5. Inbox and Learn: the order's explanation behind "how the order works".
6. About, Usage and Keyboard shortcuts (with a search over the keys); Files folds into About as "where loki keeps
   things", and Skills and Labels take the template too.
7. One row per group, the pages as tabs (above), after the list of fourteen pages under headings proved too tall.

The phone keeps its own grouped rows (More, Preferences, Connection details, About loki): every page in the Mac's
groups but Appearance is the Mac's alone, so the same groups there would be empty. What changes on the phone, and
in every message that names a page (the daemon's included), is the name: "Settings › phone" is "Preferences › Phone",
and so on for each page.

## Tests

1. The groups hold every page once, and `PAGES` is them in order; a page with no saved choice opens Appearance, and
   the old Files page opens About.
2. The filter matches names, group names and words, case aside; an empty filter is every page.
3. The arrow keys walk the groups the filter left, landing on the first page it kept in each.
4. The list is one tab per group, the chosen group the one tab stop.
5. By hand, each step on the demo Macs, light and dark.

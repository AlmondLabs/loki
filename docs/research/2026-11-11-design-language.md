# A design language of loki's own — research (2026-11-11)

The Slack look (plan 012, plan 013, 2026-09-23) has run its course: loki borrows another product's identity, and
the user wants one of its own, built from the ground up. This note gathers what we have, what other systems do
well, and a way to get there that avoids what went wrong on 2026-10-18. It decides nothing; the questions at the
end are the user's.

**Scope (corrected the same day).** This is a component-level overhaul, not a new theme. The colours, type and
radii (the "paint", and the look lab artifact that explores it) are one input; the work is redesigning what each
component is and how it behaves: the thread, a turn of agent work, an approval, a Flow card, a list row, the
composer, the shell's panes. Sections 2.3, 3.2 and 4 carry that scope; section 4 is the process.

## 1. What went wrong last time

On 2026-10-18 a full redesign (plans 023 and 024: one job per colour, coral for waiting, eight agent hues, a calm
pass with tonal chips and no hairlines) was built across the whole app in 14 commits and judged worse; all of it
was dropped unpushed. Three lessons carry over:

1. **Words did not predict the result.** Direction rounds were written descriptions and sketches; the user could
   not name what felt off until it was on screen, and by then the whole UI had moved.
2. **Everything moved at once.** Colour, density, grouping, chips and layout changed together, so nothing could be
   kept from the attempt and nothing isolated what made it feel worse.
3. **Some things are fixed.** The labelled icon rail and chats grouped by a choice stay. Rejected directions are in
   memory (card file, line map, airport yellow, signal flags, desk object and the rest) and are not re-offered.

So the method below compares rendered options on the real app, one layer and one screen at a time, each behind a
switch that can be turned back.

## 2. What loki's look is made of today

### 2.1 What makes it read as Slack

Paint (cheap to change):

1. Slack's exact values: the `#1a1d21` grey ground, panels a step lighter, `#1d9bd1` link blue, the `#e01e5a` red
   badge, the `#007a5a` green send and affirm, the mention wash and its amber bar.
2. One system sans with weight as the only hierarchy, no character of its own.
3. Rounded 6 / 8 / 12 chrome with compact shadows.

Anatomy (costly to change, and some of it is simply good):

1. The `#` before a chat's name, the 48px pane header with a tab row under it.
2. The thread: a 36px face and bold name opening each run, time after the name, the sticky day pill, the red
   "New" line.
3. Rail, list column, pane (the rail stays, by the user's decision).
4. The message box after Claude's, the green round send.

Most of the "Slack feeling" is the paint plus the thread anatomy. The shell layout is shared by most desktop
apps (Linear, Notion, Discord) and is not what makes it Slack.

### 2.2 The foundation, measured

1. **Tokens.** `app/src/kit/tokens.css` (503 lines) holds the roles, two families (loki's own and Tokyo Night)
   with day and night sides, a type scale, radii, shadows and springs. The role idea is sound: blue interaction,
   red attention, green affirm, surface tokens for well, bubble and code.
2. **Two systems.** The phone redeclares every role in `app/src/phone/phone.css` (3,248 lines) with its own text,
   radius and space scales. A new look today means painting twice.
3. **Names carry history.** `--loki-brass-soft`, `--loki-brass-glow`, the `brass` button tone, and the
   `--loki-display` / `--loki-label` aliases all date from the drafting table. `--loki-mention` and
   `--loki-mark-slack` name Slack in the roles themselves.
4. **No desktop spacing scale.** 651 inline `style={{…}}` blocks in 75 of 116 `.tsx` files, with spacing written
   as bare numbers: 8 (90 uses), 6 (51), 10 (37), 4 (34), 12 (27), 14 (15), 16, 9, 18, 5, 24, 28. The tokens test
   cannot check what has no scale.
5. **An odd type scale.** 9.5 · 10.5 · 11 · 12 · 13.5 · 15 · 17 · 22 · 28. Half-pixel steps were tuned to Slack's
   metrics; 13.5 body and 12 meta carry almost everything (31 inline uses each).
6. **Good machinery to keep.** Springs and their rules, the focus flash, reduced-motion handling, hover only for
   a fine pointer, the primitives in `components/`, `LAYER`, and `test/tokens.test.ts` as the fence.
7. **A switch already exists.** `data-palette` swaps a whole colour family before first paint. Today it is colour
   only (type and radii are shared), but it is the right shape for trying a new look without taking the old away.

### 2.3 The components to redesign

Slack's components were made for people messaging people. loki is one person supervising several agents, and
most of its components still wear the messaging shape. The inventory, by family, with what each is borrowed from:

1. **Primitives** (`app/src/components/index.tsx`): Button, IconButton, NavButton, Chip, Field, TextArea, Row,
   Sheet, Popover, Kbd, Meta, Title, Dot, Empty, Banner, Notices, Switch, ListIcon, and the Slack layout's ListRow,
   ListSection, TabRow, PaneHeader and EmptyPane.
2. **Shell** (`shell/`): the rail, the list column, the title strip, the pane header with its tab row (Slack's),
   search (⌘K), the keys sheet, Preferences as a sheet.
3. **Conversation** (`chat/`): the transcript and message (Slack's runs of face and bold name), tool steps (after
   Claude's apps), the approval, question and suggestion cards, quick replies, link cards, inline widgets, and the
   composer with its model picker, permission mode and slash palette (after Claude's).
4. **Flow** (`desk/catch-up*.tsx` and the cards): the deck, the card head, and the outside cards, which copy
   their sources on purpose (Slack threads with reactions, Gmail threads, Jira tickets), reply proposals, the
   return picker, lanes.
5. **Canvas** (`desk/surface.tsx`, `widget-frame.tsx`, `module-widget.tsx`): the sheet, widget frames, the camera.
6. **Agents** and **Learn**: the agents column and its pages (profile, memory, changes, reflection, skills); the
   review deck and leads.
7. **Phone** (`phone/`): its own tab bar, rows, sheets, conversation and Flow screens, following Slack's iOS app.

The objects loki actually has, which a redesign can give components of their own instead of fitting them into
messages: a **chat** (a place with an agent at work), an **agent**, a **turn** (what the agent did between two of
your messages: words, steps, files, widgets), a **thing waiting on you** (an approval, a question, a Flow card, a
due lesson), a **widget**, and a **lesson**. Today a turn is several unrelated rows, and the four kinds of waiting
thing are four different components.

## 3. What other systems do well

1. **Linear** — themes from three inputs: a base colour, an accent and a contrast level, generated in LCH because
   it is perceptually uniform, so every surface step (background, panel, dialog) and a high-contrast theme fall
   out of the same function instead of 98 hand-set values. They moved surfaces first and themes later. Take: a
   generated ramp from few inputs; the staged rollout. ([Linear][linear], [Linear, engineering][linear-eng])
2. **Radix Colors** — every hue is 12 steps, each with a job: 1–2 backgrounds, 3–5 component fills and their
   hover and pressed states, 6–8 borders, 9–10 solid fills, 11–12 text. Dark and light are separate scales tuned
   for each. Take: steps named by use, so a component never picks a hex. ([Radix, the scale][radix])
3. **Vercel Geist** — the identity is mostly a typeface of its own (Geist Sans and Mono, open licence), black and
   white, one blue, tight tracking at display sizes. Take: a typeface is the strongest single identity lever and
   costs nothing in colour. ([Vercel design.md][geist])
4. **Apple HIG** — already the source of loki's motion. Its materials, SF's optical sizes and the restraint of
   Notes, Things and Mail remain the reference for "calm and native" on the Mac and phone.
5. **Material 3** — tonal palettes generated from a seed colour; useful as a mechanism, not as a look.
6. **The W3C design tokens format** — first stable version 2025.10 (October 2025): one JSON file of tokens with
   types, aliases and themes, from which tools write CSS, Swift or anything else. Take: one source that writes
   the desktop's and the phone's CSS and the native window's ground, instead of four hand-kept copies.
   ([DTCG 2025.10][dtcg])

What gives a product its own look, from these: a typeface, the colour of the ground (pure grey or tinted), one
signature hue used sparingly, shape (radius and line weight), density, the icon set, a motion signature, and
the voice of the words. Slack's look in loki changes several of these at once; a new one should pick its few
strong moves and leave the rest quiet.

### 3.1 More sources for inspiration

Products whose look is their own, each worth studying for the one or two moves that make it so:

1. **Raycast** — a dark, quiet base with one red used only as punctuation; built its own controls because stock
   ones did not suit a keyboard-first app, as loki's are. ([Raycast, technical deep dive][raycast])
2. **Granola** — "calm AI": the AI stays out of the way, and the AI's words are grey while yours are black, so
   whose words are whose reads at a glance. Close to loki's own problem of agent speech beside the user's.
   ([Granola's design philosophy][granola], [a review noting the grey AI text][granola-review])
3. **Nothing OS** — a dot-matrix face (Ndot) as the signature, used sparingly; with OS 5 the system face became
   Geist and the dots were kept for the places that carry character. A model for a characterful face on a few
   things and a readable one everywhere else. ([Nothing community][nothing])
4. **Linear** — density and a keyboard-first feel as identity, beyond its colour system (above).
5. Worth opening directly: Things 3, Superhuman, Arc and Dia, Notion Calendar, the Claude apps (loki's message box
   already follows Claude's), Teenage Engineering's product UIs.

Writing on craft:

1. **Rauno Freiberg, "Invisible Details of Interaction Design"** — why gestures and animations feel right, tied to
   physical behaviour; the source of several of loki's motion rules. ([rauno.me][rauno])
2. **Emil Kowalski** — on animation and polish; already behind loki's springs (the `emil-design-eng` skill holds
   his rules).

Galleries:

1. **Mobbin** and **Refero** — libraries of real product screens and flows, searchable by pattern; both can be
   queried from an agent over MCP. ([Mobbin vs Refero][mobbin])
2. **The Component Gallery** (component.gallery) — one component as dozens of design systems draw it.
3. **Design Systems Surf** (designsystems.surf) and **Adele** (adele.uxpin.com) — indexes of public design
   systems; [awesome-design-systems][awesome] is the long list.

Tools for colour:

1. **OKLCH picker** (Evil Martians) — see the space and its sRGB and P3 limits. ([Evil Martians][oklch])
2. **Huetone** — build a scale by setting lightness and chroma curves per step.
3. **Adobe Leonardo** — ask for a contrast ratio against a background and it solves for the colour; the right tool
   for the AA guarantees `test/tokens.test.ts` already checks. ([Leonardo][leonardo])
4. **Harmony** (Evil Martians) — a ready OKLCH palette with equal contrast within each lightness step.
   ([npm][harmony])

Typefaces (loki ships on GitHub and bundles what it uses, so the licence matters):

1. **Google Fonts** — families under the SIL Open Font License, free to bundle and redistribute.
2. **Geist** — Vercel's sans and mono, open licence.
3. **Fontshare** (Indian Type Foundry) — fine UI grotesques such as Satoshi and General Sans, but under ITF's own
   free licence, which restricts redistribution; check it before bundling. ([ITF][fontshare])

### 3.2 References by component family

1. **A turn of agent work.** [Vercel AI Elements][ai-elements] breaks agent output into separate components:
   reasoning (folding), chain of thought, a tool call with status and folding input and output, a plan, a task,
   a confirmation for an approval, a checkpoint. A useful checklist of the parts a turn has, whatever it looks
   like. The Claude apps fold a stretch of work into one line, which loki's tool steps already follow.
2. **Waiting on you.** Practice in agent tools has settled on a few patterns
   ([HatchWorks][agent-ux], [jacar.es][jacar]): long work runs in the background with visible progress instead of
   holding the conversation; approvals are tiered by risk (routine passes, a change to shared work shows a preview
   or diff, anything sent, paid, deleted or public always stops and asks); the proposed change is shown in its own
   form (a diff for files, a rendered preview for a message); every action leaves a receipt with an undo.
3. **AI patterns at large.** [Shape of AI][shape-of-ai] (Emily Campbell) catalogues them by kind: identifiers
   (how the AI is marked), wayfinders (suggestions, nudges), prompts, tuners, governors (approvals, controls),
   trust builders. Useful for naming what each loki component is for.
4. **Triage (Flow).** Superhuman frames each message as "today, another day, or done", splits the inbox by
   source, and its ⌘K shows each command's key so the palette teaches the keys
   ([split inbox][superhuman-splits], [a design reading][superhuman-design]). Linear's inbox and Things' Today are
   worth opening directly.
5. **Shell and lists.** Linear and Raycast: dense rows, everything reachable by key, the command menu as the spine.
6. **Canvas.** tldraw and Figma for frames, selection and the camera; worth opening directly.
7. **Primitives.** The Component Gallery shows one component (a tab row, a chip, a toast) as dozens of design
   systems draw it; Mobbin and Refero show whole screens and flows from shipped apps.

## 4. The process: a UI library from scratch

The textbook order is bottom-up: tokens, primitives, components, screens. For a new language that order misleads:
primitives built before the screens are known come out generic, and a button or a colour cannot be judged out of
context. The 2026-10-18 attempt (also component-level: two-line rows, tonal chips, grouping, a centred thread)
failed by moving everything at once from descriptions. So the language is found top-down, on a few signature
pieces, and the library is then built bottom-up from what those pieces used. Every phase ends on a rendered
result the user approves before the next begins.

### 4.1 Find the language (top-down)

1. **Principles and objects.** Three to five principles particular to loki (what it would do that Slack would
   not), and the objects the interface draws (2.3): chat, agent, turn, waiting item, widget, lesson. Every
   component answers to one of them.
2. **Interface inventory.** Every component on screen today, screenshotted and grouped by job, so duplicates show
   (four kinds of "waiting on you", three kinds of row). The output is the target list: what merges, what stays,
   what goes. Section 2.3 is the first pass.
3. **Signature pieces, designed whole.** A turn of agent work with its approval, a Flow card, a list row: two or
   three different anatomies of each, rendered and interactive in a component lab artifact, until one feels right.
   The language comes out of these: density, shape, how one thing is set apart from the next, how motion behaves.

### 4.2 Build the library (bottom-up)

4. **Tokens in three tiers,** extracted from what the signature pieces used: raw scales (colour ramps, type,
   spacing, radii, elevation, motion), roles (surface, ink, accent, attention and the rest), and component tokens
   only where a component needs its own. One source file, in the W3C tokens format (3, item 6), writes the
   desktop's and the phone's CSS and the native window's ground. A desktop spacing scale arrives here.
5. **A behaviour layer.** Focus, keyboard handling, popover positioning, the modal focus trap, typeahead and roving
   focus are the hard part. loki owns this today; the alternative is an unstyled library (React Aria, Base UI)
   styled by loki. The trade is a dependency against fewer accessibility bugs, weighed against the speed and
   memory objective.
6. **Primitives, each with a spec:** anatomy (its named parts), variants, sizes, every state (rest, hover, focus,
   pressed, selected, disabled, loading, error, empty), keyboard behaviour, roles for assistive tech, and the
   rules for the words inside it. Small parts that compose, rather than one component with many props.
7. **Composed components,** loki's own, built from the primitives: the turn, the waiting item, the card, the row,
   the composer, the pane.

### 4.3 Make it real

8. **A workbench.** A dev-only page in the app that draws every component in every state, day and night, desktop
   and phone, with made-up data shaped like real data. It is where visuals are approved, so it replaces
   describing them. This is the first thing to build: it makes every later decision something to look at.
9. **Checks.** `test/tokens.test.ts` extended so nothing leaves the new scales; screenshots of the workbench
   compared on each change; an accessibility checker (axe) over it; a redraw budget for the thread.
10. **Migration.** The new library in its own folder beside the old, behind a switch in Preferences, one surface
    at a time: the thread, Flow, the sidebar, Agents, Learn, Preferences, the phone. Each surface that moves deletes
    the old code it used; renames go by codemod where they are mechanical.
11. **Upkeep.** A one-off becomes a component the third time it is needed; `docs/design.md` becomes the library's
    spec and changelog; a new component gets its spec before its code.
12. **Paint last.** The look lab's levers (type, ground, accent, shape, density) are settled on the finished
    components, since the same colour reads differently on a different anatomy.

### 4.4 Where loki stands

1. Done or started: the inventory's first pass (2.3), loki's own behaviour layer (`components/`, `kit/`), the
   tokens test, the springs and motion rules.
2. Missing: written principles, a workbench, a desktop spacing scale, one token source for desktop and phone, a
   spec per component.
3. First steps: the principles and object list (decided in words), the workbench, and the component lab for a
   turn of agent work.

## 5. Questions for the user

1. Which components bother you most today: the thread, Flow cards, the sidebar rows, the composer, the cards for
   approvals and questions, the shell's headers and tabs?
2. Should a turn of agent work become one component (words, steps, files and widgets together), rather than the
   separate rows it is now?
3. Should everything that waits on you (approvals, questions, Flow cards, due lessons) share one component?
4. Do Flow's outside cards keep copying their sources (Slack, Gmail, Jira), or take loki's own anatomy?
5. Should the phone and the desktop share one set of components, or keep the phone closer to iOS?
6. Is "a memory palace your agent furnishes" (the subject line of `docs/design.md`) still the idea, or is there
   a better one now that Flow is the home?

[linear]: https://linear.app/now/how-we-redesigned-the-linear-ui
[linear-eng]: https://linear.app/blog/how-we-redesigned-the-linear-ui
[radix]: https://www.radix-ui.com/colors/docs/palette-composition/understanding-the-scale
[geist]: https://vercel.com/design.md
[dtcg]: https://www.w3.org/community/reports/design-tokens/CG-FINAL-format-20251028/
[raycast]: https://raycast.com/blog/a-technical-deep-dive-into-the-new-raycast
[granola]: https://www.cognitiverevolution.ai/calm-ai-for-crazy-days-inside-granola-s-design-philosophy-with-co-founder-sam-stephenson/
[granola-review]: https://wondertools.substack.com/p/granolaguide
[nothing]: https://nothing.community/d/61774-nothing-os-evolution
[rauno]: https://rauno.me/craft/interaction-design
[mobbin]: https://mobbin.com/blog/mobbin-vs-refero
[awesome]: https://github.com/alexpate/awesome-design-systems
[oklch]: https://evilmartians.com/chronicles/exploring-the-oklch-ecosystem-and-its-tools
[leonardo]: https://medium.com/@NateBaldwin/accessible-color-for-design-systems-just-got-easier-40e8420a8371
[harmony]: https://www.npmjs.com/package/@evilmartians/harmony
[fontshare]: https://www.indiantypefoundry.com/news/introducing-fontshare
[ai-elements]: https://github.com/vercel/ai-elements/releases
[agent-ux]: https://hatchworks.com/blog/ai-agents/agent-ux-patterns/
[jacar]: https://jacar.es/en/ui-design-for-agents-principles-were-starting-to-understand/
[shape-of-ai]: https://www.shapeof.ai
[superhuman-splits]: https://help.superhuman.com/article/441-splits
[superhuman-design]: https://blakecrosley.com/guides/design/superhuman

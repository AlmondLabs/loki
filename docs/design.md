# loki · visual direction

**Subject.** A memory palace your agent furnishes. One person's chats, seen at a
glance: what the agent built here, who built it, what is waiting on you.

**Direction: Apple's Human Interface Guidelines with Liquid Glass, day or night (plan 2026-11-12-1505).** loki looks,
reads and is driven like a native Apple app, so on a Mac it sits beside Mail, Notes and Messages as one of them, and on
the phone as an iOS app. Glass goes only on what floats over content and steers: the sidebar, toolbar control groups,
menus and popovers, sheets, decisions and the message box. Messages, turns, cards and pages are solid. Where glass
would cost too much, or the person asked for less transparency or more contrast, the same shapes are drawn solid. The
colours are Apple's semantic roles in one palette; blue is the accent and also marks what waits on you, as Mail's
unread dot does; red is for failures and the Dock. Controls speak in Apple's title case and words, decisions are
questions, and keys live in the menu bar and in tooltips rather than on buttons. One icon set, Lucide, everywhere,
the Mac's native pop-up menus included.

It was built one screen at a time from 2026-11-12, each screen approved rendered before the next, behind a switch in
Preferences › Appearance beside the Slack look; on 2026-11-14 (U11) the Slack look, Tokyo Night and the switch were
removed. What it reversed is under [Tried and dropped](#tried-and-dropped).

## Tokens (`app/src/kit/tokens.css`)

The structural stack is the ground `--loki-bg`, panel `--loki-panel`, raised header `--loki-panel-header`,
then `--loki-hover` and neutral `--loki-selection`. `--loki-border` is a quiet divider; `--loki-control-border`
is deliberately stronger and stays at least 3:1 against control surfaces. `--loki-fg` and `--loki-muted` stay
AA on every working surface. The roles:

- `--loki-accent` — the system blue, at a shade that passes AA (links, focus, toggles, a chosen pick, chart series),
  with `--loki-accent-soft` (a pressed or chosen fill) and two tints whose names are kept from the drafting table
  to avoid churn: `--loki-brass-soft` (the quiet blue wash behind accent ink) and `--loki-brass-glow` (the
  highlight halo).
- `--loki-attention` / `--loki-on-attention` — what waits on you: the same blue as the accent, as Mail's unread dot,
  and its ink. Only a dot or a count, never a panel.
- `--loki-affirm` / `--loki-on-affirm` — the default button's fill and its ink: the accent, as a Mac's default button
  is (Allow, Send).
- `--loki-glass`, `--loki-glass-strong`, `--loki-glass-hi`, `--loki-glass-edge`, `--loki-glass-blur` — the material:
  a translucent fill (strong for menus and sheets), its highlight and edge, and the blur behind. The glass utilities
  in `styles.css` read only these, so one media block turns every surface solid under Reduce Transparency or
  Increase Contrast, and `data-glass="solid"` does the same where the platform's budget says so (Linux, `GLASS_ON` in
  `theme.tsx`). In the Mac app the window is transparent over the system's sidebar material (`data-vibrant`), which
  the sidebar lets through and everything right of it paints over.
- `--loki-monogram-top`, `--loki-monogram-bottom`, `--loki-on-monogram` — an agent with no picture: Messages' grey
  monogram. `--loki-segment` — the chosen segment of a segmented control, raised off its grey track.
- `--loki-positive` / `--loki-negative` — status inks (a pass, a failure, a destructive action).
- `--loki-mention` / `--loki-mention-bar` — a mention's wash and the bar at its left edge, on a Slack message that
  brought its card into the Inbox (plan 077). Only behind a message, never a control.
- Inputs, agent speech, user speech and inline code each have their own surface token (`--loki-well`,
  `--loki-bubble`, `--loki-user-bubble`, `--loki-code`) instead of borrowing selection or accent.
- `--loki-label-0` … `--loki-label-7` — the eight chat-label colours, each a mark that reads at 3:1 or more on
  `--loki-bg`, `--loki-panel` and `--loki-well` on both sides (the tokens test checks).
- `--loki-grid` is the canvas's dot grid, `--loki-veil` the dim behind a sheet, and `--loki-focus-flash` the colour
  the focus ring flashes in where a surface sets one (the phone's link colour); unset, it is the accent.

No literal colour appears in a component; the agent chip's hue is the one computed colour. `data-theme`
selects dark or light values, and the saved `system` preference follows the operating system; there is one palette.
An inline initializer applies it before first paint; the grounds are repeated in `index.html`, the web manifest and
the native window (`src-tauri`).

Type scale, the Mac's as AppKit sets it, read through `--loki-text-*` (Tailwind's `text-micro` to `text-hero`):
**10** micro and fine print · **11** tag, meta, label (`.loki-label`) · **13** body and list rows · **15** a window or
section title · **22** a pane's large title · **26** hero. The phone keeps a step larger scale (9.5 to 28) for a
phone held closer. One face: the system sans (`--loki-font`); `--loki-display` and `--loki-label`
are aliases of it, kept so older call sites resolve. SF Mono (`--loki-mono`) only for code, data and key hints.
Weight carries the hierarchy (400 reading, 600 labels and names, 700 titles); no tracking, no uppercase.

Radii: `--loki-radius-sm` **6** fields, icon buttons, dense rows · `--loki-radius-md` **8** buttons, rows,
plates · `--loki-radius-lg` **12** cards, sheets, popovers, panels · `--loki-radius-pill` **999** chips, badges,
toasts; circles use half their size. A radius with a role is written as its token (`"var(--loki-radius-md)"`), never
as the number; the tokens test fails a bare 6, 8, 12 or 999 outside the phone. Shadows: `--loki-shadow-sheet` (modals), `--loki-shadow-float` (popovers),
`--loki-shadow-panel` (the chat), `--loki-shadow-low` (small plates). Stacking: `LAYER` in
`app/src/kit/layers.ts` (panel 100, bubble 101, rail 110 (the sidebar toggle), modal 200, strip 250, toast 300), never arithmetic
on one; small inline z-indexes are for stacking inside one component only.

Focus flashes, one rule in `tokens.css`: when focus moves by keyboard, a 2px accent-blue ring appears and
fades over a second, so you see where focus went without a box sitting there. Controls (buttons, rows, tabs,
links, selects, checkboxes) settle on a 2px muted ring, since nothing else shows which one Tab or Enter acts
on; text fields settle on nothing, the caret shows them. The ring is inset (so a clipped list never cuts it
off) and offset on links. Only the colour animates, so under reduced motion the settled ring shows at once.
Nothing sets `outline: none`, and a rule that turns a ring off also says `animation: none`. Reduced motion means less
movement, not none: it zeroes every CSS duration *and delay*, then lets what appears (sheets, popovers, a chat's
arriving rows and words, widgets, the phone's banner) fade in over 150 ms with no move or scale, so nothing cuts in
hard. JS-driven moves ask `prefersReducedMotion()` or `glide()` in `app/src/kit/motion.ts`.

Hover belongs to a mouse: every `:hover` rule sits inside `@media (hover: hover) and (pointer: fine)`, so a tap on the
phone never leaves a control looking hovered. A rule that also answers focus or a press keeps that half outside it.
Asked for less transparency, the phone's floating navigation is solid with no blur; asked for more contrast, it is
solid too and every hairline (`--loki-border`) takes the controls' stronger edge.

Motion is springs, the way Apple's is (the phone first; the desktop follows). `app/src/kit/spring.ts` holds three,
named after SwiftUI's: *smooth* (no bounce, sheets, screens, and menus, pills and banners that appear without being
thrown), *snappy* (a trace of bounce, for what a finger let go of or pressed: a card springing home, a button) and
*bouncy* (small confirmations only: the send button, the inbox badge). `node --experimental-strip-types scripts/springs.ts`
writes them into `tokens.css` as `--spring-<name>` (a `linear()` curve) and `--spring-<name>-ms`; each looks settled by
~300 ms. The rules, from Rauno Freiberg's and Emil Kowalski's essays: only transform and opacity move, so it runs on the
compositor while agents stream; a finger's speed carries into the spring it lets go of (`spring(name, velocity)`);
a release is judged by where it was going, not where it stopped: its speed (zero if the finger rested first) is
projected forward as a scroll view slows, and it commits when that lands past the line, so a pull that turns back
stays (`kit/let-go.ts`, for sheets, the edge swipe and the Inbox card); a thing caught mid-motion is held where it is
on screen;
anything can be caught mid-motion; light things happen during a drag and lasting ones on release; nothing done
from the keyboard, nor a tab switch, animates. On the phone: pressed controls give to 97%, bottom sheets rise, follow
a finger down and leave however they close (`components/sheet-motion.ts`) while the screen behind recedes; pages push
and pop, the Inbox card zooms into its conversation (View Transitions, `phone/transitions.ts`); and a swipe from the
left edge goes back (`phone/edge-swipe.ts`). The chat shows agents at work: a streaming reply's words fade in as
they arrive, rows that come in while you read rise into place, "thinking" is three rising dots, and scrolled up,
the chip counts what is new. Lists that change under you glide (`kit/use-flip.ts`): a row moving, even between
sections, springs to its place, a row leaving fades while the rows below slide up. Undo springs in and out
(`kit/leave.ts`); and a swipe an approval refuses shakes the card. Waiting has a shape: a list or card still being
read shows placeholder rows or a placeholder card after a beat, a light passing over them (`SkeletonRows`,
`SkeletonCard`); the end of an Inbox visit springs its check in; the Mac-unreachable banner slides down and back up; and the
message box rides up and down with the keyboard (`phone/viewport.ts`). A Learn card turns over to its answer, is
thrown right for Got it and left for Again, and the next rises into its place.

The desktop is quieter than the phone. A button or chip gives to 97% under the pointer (not under a key: Space on
a focused button is pressed too, and stays still). Popovers opened by a click grow from the corner they hang from, and sheets
opened by a click fade and rise (search, the keys sheet and anything else a key opens are just there); a chat opened by a click fades in; a count badge springs in when its
count goes up; the camera glides to a widget on the smooth spring, and a wheel, pinch or drag stops it
(`desk/camera-glide.ts`); a widget its agent rewrites glows once, on a layer that fades rather than an animated
shadow. The chip row, the switch's knob and the catch-up bar move by transform; the chat's width changes at once.

The agent's work reads the way Claude's apps show it (`chat/tool-steps.tsx`, wording in `shared/tool-steps.ts`): a
stretch between two messages (tool calls, background-task notices, skills it loaded) is one quiet line in the thread,
"Worked 14 min · 10 background tasks, 3 commands, 11 tools · 1 failed" ("Ran 3 commands" when the rows carry no
times; "Working" breathing while the last step waits). When a step failed, its name sits under the closed line in red
("✕ Deploy approved Dealshield image and ECS routing failed"), and a click opens the stretch at it. Canvas activity and
compactions stay rows of their own. Opened (inline on the desktop, a bottom sheet on the phone), every step is a line
in one flat list, in order: background tasks, commands, agents and anything that failed in full, led by what the agent
said they were for; reads, edits, searches and skills quieter. Past 8 steps, chips filter it: All, Failed, Steps,
Files and search. A step opens its description, command
and output under it, one at a time (on the phone, in the same sheet with a way back); a background task opens its
result. Each tool row keeps its input and output (capped at `TOOL_TEXT_MAX`, 4,000 characters, in
`core/harness.ts`) and whether it failed. The live stream carries them; a history page travels lean, without a tool
row's input and output (`core/attention/transcript.ts`), and the row fetches them when it opens.

`test/tokens.test.ts` fails `npm test` when a style leaves these scales. It reads every `.tsx`, `.ts`
and `.css` under `app/src` (colours, sizes, radii, tracking, faces, shadows, layers, outlines). The radius check
allows the scale and the geometric radii for circles and hairlines it lists (1, 3, 4, 9, 24); the shadow check covers
inline `boxShadow` only. The desktop has no spacing scale to check; the phone has its own, `--phone-space-1` to
`--phone-space-6`. It fails a Mac key symbol (⌘, ⌥, ⇧ …) in any app string outside `MAC_SYMBOL` in
`shell/keymap.ts`, so keys are formatted for the viewer's system. It checks that
every `var(--loki-*)` is defined and used and every `loki-*` class has a rule, that `index.html`, the manifest
and the native window carry `--loki-bg`, that both sides define the attention and affirm roles with AA ink, that the
glass turns solid under the media block and `data-glass`,
and that no serif or condensed face, no tracking and no display/label face is left in a stylesheet. Inline
styles are held to the same: no `letterSpacing`, no `textTransform: uppercase`, and no face but the sans or
mono (the display and label aliases never appear in a view). Mono inline is for code, diffs, file bodies,
paths and commands shown as data, commit and task ids, and key hints; timestamps, counts, status words, names
and meta lines are the sans. Label and heading strings are written in sentence case, since nothing transforms
them (`sentence()` in the primitives capitalises one built from an id); a control's label is Apple's title case
(docs/style.md).

## Primitives (`app/src/components/`, 2026-09-08)

The chrome is built from one vocabulary, with every state in `components/components.css` and never inline:
**Button** (tone quiet · paper · brass · positive · negative; size sm 28 · md 36 · touch 44; bare, block,
kbd), **IconButton** (24 · 28 · 36 · 40; danger goes red on hover), **NavButton**, **Chip** (active is
neutral, brass the blue pick, attention the badge for what waits on you, tone for a status badge, static, tag, touch, label,
float), **Field** / **TextArea** (sm · md · touch; mono, bare, large, inline), **Row** (selected, dense, touch,
flush), **Sheet** (veil, aria-modal, Escape, click-out, focus returned; top or bottom), **Popover**, **Kbd**,
**Meta** (sans 12 muted; brass, negative for a small error, wrap; a div that is a meta line takes the
`loki-meta` class instead of a hand-set fontSize and colour), **Title**, **Dot**, **Empty**, **Banner**, and
**Switch** (an on/off switch with its label), **ListIcon** (an icon in a list row's avatar place), and
**Notices** with `notify` (the window's notices, on [Sonner](https://sonner.emilkowal.ski): a line for four seconds,
or one that stays with an action and a cancel button; one stack, top right under the window's top bar, in loki's
colours; never a
hand-built toast).

The tone names predate this look and are kept for compatibility. What they render now: `quiet` muted ink
on a hairline · `paper` fg ink · `brass` the accent blue ink (an interactive action) · `positive` the default
button, the accent filled with white ink · `negative` red ink. Buttons are semibold; a label takes a capital
(`capitalChildren`) and a `kbd` goes into the tooltip ("Archive (⌘E)"), not onto the face. Chips, meta, banners and labels are the sans at 12, no caps, no tracking; titles are sans bold. Kbd
stays mono. Selection and hover use distinct neutral steps; neither the accent nor the badge is spent on a
selection. A one-off is `className`/`style` on the primitive; a one-off that repeats becomes a modifier.
Button and Field share one height scale (sm 28 · md 36 · touch 44); a field and the button beside it always
share a size. Widgets on the sheet keep `@loki/kit`; app chrome never ships into that surface. What stays
hand-built: the sidebar toggle (`.loki-rail`), the chat bubble, the phone's tab bar.
The list-and-detail layout has its own blocks (2026-09-23): **ListRow** (a lead, the title bold when unread, a preview,
the time or the count, hover actions; `aria-current` on the chosen one), **ListSection** (a folding
heading with a count and actions), **TabRow** (an ARIA tablist with roving focus, the underline tabs),
**PaneHeader** (the pane's name line and tab row) and **EmptyPane**.

## The chat pane and Flow's cards (shadcn and AI Elements, plans 096 and 097)

The desktop chat pane and Flow's cards are built on a second vocabulary; the rest of the app keeps the primitives
above. The phone keeps its own thread and cards.

**Foundation.** [shadcn](https://ui.shadcn.com) components on Base UI (a custom trigger is `render=`, not `asChild`)
and Vercel's [AI Elements](https://ai-sdk.dev/elements) live in `app/src/ui/` and `app/src/ui/ai-elements/`, copied
in and owned: no `ai` runtime, icons from Lucide. Tailwind v4's `@theme inline` maps shadcn's names (`background`,
`muted-foreground`, `primary`, …) onto loki's tokens, so day, night and the phone follow. Each piece is bent to
the rules here: focus is loki's flash, motion stops under reduced motion and uses only transform and opacity, overlays
take loki's layers rather than numbered z values, and type stays on loki's scale (`text-micro` to `text-hero`), never
Tailwind's defaults. `cn` (`app/src/lib/utils.ts`) knows those sizes and loki's shadows, so a size beside a colour
never drops the colour. `test/tokens.test.ts` fences all of it: off-scale classes, `outline-none`, focus rings,
numbered layers, default sizes, tracking and hard-coded keys fail the build.

**One item.** A chat, a Slack thread, an email and a Jira ticket draw with the same twelve components in
`app/src/item/` (plan 097): **ItemHeader** and **ToolbarTitle** (a chat's and a Flow card's header is a Mac toolbar:
the name over a grey line of its facts, the moves a glass group of symbols at the trailing edge, their names and keys
in their tooltips; an outside card's header keeps its flags only while they hold), **ActionBar** (an outside card's
moves under its box: the finishing move last, filled, the rest quiet capsules before it, keys in tooltips),
**Timeline** (time told at gaps of a quarter of an hour), **MessageEntry** (yours a bubble at the trailing edge with no
label, its time in its tooltip; the agent's prose, copy beside it on hover), **AgentTurn** (no name on screen: the
header says only how long it worked and, while it is not simply done, where it stands, with the Loader while working;
a New line or a day that falls inside a turn is drawn inside it), **Work** (AI Elements' ChainOfThought: one summary line, opened to steps,
a step to its Tool or Task; finished steps at full strength, never AI Elements' half-faded "pending"), the agent's
**Plan** (folded to "plan as before" when it repeats unchanged) and **Thought** (Reasoning, folded), **EventEntry** (one quiet line; a compaction
a Checkpoint), **ContentParts**, **Reactions** (Slack only), **Proposal** (above the box, in the thread's column; an
approval is a question, "Allow friday to run “edit”?", with Deny, Always Allow… and Allow, the default last as a Mac
alert's, and ⌘Return allows; no key typed alone into the box acts, so a bare Return only sends and a digit is a digit) and **Composer** (Messages' box: "+" in a glass circle outside a one-line
capsule that grows with the text, the microphone or the accent up-arrow inside it, the Queue above it; "+" only
attaches files, and the model and the permission mode are ⌘K's). **Brief** is designed and not
built.

**Layout.** One centred column, `max-w-3xl`, for the thread, the proposals and the Composer. The header floats over
the thread as a toolbar and the dock of decisions and the box floats at the foot; the thread pads itself by their
measured heights (`shared/use-height-var.ts`) and scrolls on beneath them.

## Signature

The window has no native title bar (2026-09-23): the title bar is an overlay with its title hidden, the
traffic lights sit in the sidebar's top row, and loki draws the top edge itself — a 28px **title strip** that drags the
window and zooms on a double click, with nothing interactive in it (`TitleStrip`, 0px in a browser tab). The
window title is still set, for the Window menu, Mission Control and screen readers: the chat's name (with
"· archived" or "· deleted"), "Inbox · n waiting", "Agents", or "Preferences" while Preferences
is up. There is no top bar of search or history. Each pane draws its own header instead: a chat's is a Mac toolbar
(plan 2026-11-12-1505, U13), its name over a grey line of its facts, Messages and Canvas as a glass segmented control
and its moves as a glass group of symbols; other panes keep a name line with a quiet aside and a tab row. The name line drags the window too, so anything clickable in it is a real
button. A chat's header carries its agent with the live word (working, writing, needs approval, asked you), and on the
Canvas tab a "More chat actions" menu of the sheet's own actions with their keys (arrange, fit, the chat toggle).
What works on the chat as a whole (rename, folder, pin) lives on the sidebar row, with Label, Mark as Read and
Archive also in the toolbar; model and mode are ⌘K's. Dropped on 2026-09-28 as copies: the header's pin and archive buttons, and from its
menu Mark as read, Rename…, Change folder…, New chat…, Find (⌘F), Change model and Change permission mode (their
keys stay; ⌘⇧↵ still marks the open chat read). Two earlier forms were dropped on 2026-09-06: a
drafting title block (DESK · DRAWN BY · STATUS · SCALE) and then a custom 40px bar with a header line.

**Windows and Linux (preview, plan 014).** There the window is undecorated and the strip is loki's for those
systems: 32px, the height Windows gives its caption buttons, on `--loki-panel`. At its left a ☰ button opens the Mac's menu bar as a strong-glass popover: the menu titles (the `menuSpec()` groups), each opening its items
beside it, keys written Ctrl, Alt, Shift, with the header menus' keyboard manners; at its right minimise, maximise (Restore, with the two-square glyph, while maximised) and close,
46px wide, flat and full height, square because they run to the window's edge. Hover is `--loki-hover`; close
alone hovers red, because that is what close does on both systems. The strip sits on `LAYER.strip`, above sheets, so the window buttons stay usable while a dialog is
up, as a system title bar would. The strip drags; double click maximises. The rest of the window is the Mac's.

The conversation is the signature surface: see [the chat pane and Flow's cards](#the-chat-pane-and-flows-cards-shadcn-and-ai-elements-plans-096-and-097).
**Widget rows** sit among the messages by time, one quiet line with a tile icon: "friday added Revenue chart · 14:49",
the widget's title in the link blue while it is still on the canvas; choosing one opens the Canvas tab framed on that
widget. Under a widget's latest row the widget itself is drawn, live (`chat/inline-widget.tsx`,
`chat/use-inline-widgets.tsx`, 2026-10-09): the same kit component or module the canvas draws, in a card as wide as
the thread allows, with "Show on canvas"; using it there is using it on the canvas (a `set` gesture on the widget's own
desk, recorded for that desk's agent). Earlier rows for the same widget stay one line each, so a widget edited ten
times is drawn once. Every chat surface draws them: the desk's chat, the Flow card (which asks the mod for that chat's
widgets, `desk_get`) and the phone, where kit widgets draw read only and a custom module says to open the chat on the
Mac. While the agent works and the box is empty, send becomes **Stop** (a filled round with a square), which ends the
turn where it is — an approval it waits on too — through the `chat_abort` frame; typing brings send back (it queues).
**The model and permission mode** are changed in ⌘K (⌘⇧M, ⌘⇧P): its Models scope opens on the agent's Usual, filters
every harness and provider as you type, and takes the effort with ←→; its Permissions scope lists the chat's modes.
The phone keeps the Claude-style box (2026-09-24): one rounded field with "+", the model pill and the mode chip, the
mic and a round send, and Select model as a bottom sheet.

## Shell (2026-09-06; one sidebar 2026-11-12)

List and detail, as Mail's: one **sidebar** on the Mac's material, inset from the window's edge, and the **pane** in
the rest.

Vocabulary (2026-09-27): a conversation in the list is a chat; the widget surface inside it is its Canvas tab.
Internals keep the name desk.

- **Places.** The sidebar's first rows (plan 2026-11-12-1505, U12) are Chats, Flow, Agents and Learn, each a symbol
  in the accent, its name and a grey count (what waits in Flow, the cards due in Learn), the one showing filled and
  never bold. Preferences is not a row: it is ⌘, and the menu bar's, and in the Mac app a window of its own. A quiet
  "Update Available" row sits at the foot while a newer loki is out. The pane is the window's one `main`; the places
  are its navigation.
- **Lists.** Under the places, each section's own list (`ListColumn`), 260px by default, dragged or arrowed on its
  edge between 220 and 420, shown or hidden with ⌃⌘S (Ctrl B off the Mac; ⌘⇧D is Flow's Deny alone) or the toggle beside the traffic
  lights, which stays while the sidebar is hidden.
  A window under 1100 wide folds it away until asked for, without touching the saved choice. Each section's
  list mounts on first visit and then stays, hidden, so its scroll and folds survive switching. Each list's heading
  is a source-list heading under the places, small and grey, with its "+".
- **Chats sidebar.** A filter ("Find a chat…", by chat or agent name; ↓ into the rows, ↑↓ between them, ↵ opens
  the first match), then **Pinned**, then one folding section per agent with its own "+", then a folded
  **Archived**. A row is the chat's name: a grey count (and bold) when it waits on you, a green dot while
  its agent works, and for a chat whose agent has finished a small ring after the name, bold as well while there
  is news since you last looked. **Viewed is not read, and read is not done**: opening a chat views it
  (un-bolds it), the ring stays until you act or Mark as read, and only archiving takes the chat out of the Inbox;
  bold and ring is new, the ring alone is "viewed, not read", neither is read. The phone reads the same marks
  through the mod. Hover shows pin and archive; a right click opens the row menu (open, Mark as read or unread,
  Rename…, Change folder…, pin, archive or restore). When a chat that waits on you is scrolled out of view, a "Needs you"
  pill at the top or bottom edge scrolls it back. Scroll and folds are kept across restarts. The sidebar
  replaced the desks tree drawer (2026-09-23, approved by the user); the tree went with Tasks (plan 049).
- **Chat pane.** A chat opens on **Messages** with the composer focused, from anywhere (the sidebar, search,
  the Inbox's Enter or O, Agents, Learn). **Canvas** is the tab beside it: today's sheet edge to edge with the
  chat as a viewport **inset** (framing centres in the uncovered part, toggling the chat slides the sheet by its
  width), the camera, arranging and the widget keys unchanged. The Canvas tab hides the sidebar. Esc, or the Messages tab, returns to the thread at the scroll it was left at, and focus to what it last
  held there. Both views are one conversation with one draft: a half-written reply follows you across the tabs.
  Only the view on screen draws the composer. Each chat remembers its tab for ⌘[ ⌘]; an open always lands on
  Messages. The pane stays mounted, hidden, behind the other sections, so the mod link, the camera and the
  thread's scroll keep their state; its panels inherit that hiding and never set themselves visible.
- **Agents** lists agents as Messages lists people (face, name, live dot, the last thing it said, a count of what
  waits in Flow); the pane shows the chosen agent with a tab row for its pages (Profile, Memory,
  Changes, Reflection, Skills). **Learn** lists Review, Leads, All cards and Deleted. With nothing chosen, a pane shows one quiet line saying what to pick.
- **⌘K.** A floating panel of strong glass, nothing dimmed behind it, over chats, agents, labels, waiting Flow
  items and the app's pages, the menu bar's commands for the screen showing, and the open chat's models and modes
  (plan 2026-11-12-1505, U21, U23); it does not search message text, and says so in its foot line. An empty query lists
  recent places; ↑↓ move, ↵ opens the top result, Esc or ⌘K closes it.
- **Preferences.** In the Mac app Preferences is a window of its own (U18); elsewhere a large sheet over the whole
  window: a named page list on
  the left (an ARIA tab list; focus follows the page), the page on the right, sentence case, confirmations as sheets. ⌘, (or ⌘6) toggles it, ⌘1, ⌘2, ⌘4 and ⌘5 close it
  and go, ⌘[ ⌘] step its pages; every other dialog still blocks the shell's keys.
- **Flow** is one card at a time, the card a solid page with the chat's toolbar; Enter or O on a card opens its chat
  on Messages.
  Once two agents have cards waiting, pills over the deck filter the visit by agent (All, then each agent, busiest
  first, with its count); a pill that is on stays at 0 when its cards are archived, and undo takes back that
  agent's last decision.

## Phone (2026-09-23; Liquid Glass 2026-11-12)

The phone is its own presentation, not the desktop shrunk: an iOS app in iOS's colours and materials (plan
2026-11-12-1505, U9), on the rows, sheets and navigation of plan `docs/plans/2026-09-22-012`. The boundary is
the `.loki-phone` root. Everything below applies under it and nowhere else. Shared chat pieces take phone looks
only through optional props (`touch`, `layout`, `draft`) that default to the desktop chat's behaviour; the message
box is one for both, its sizes set by `touch`.

- **Tokens.** `app/src/phone/phone.css` owns them. `.loki-phone` redeclares every `--loki-*` role with iOS's
  dark values (a black ground, grouped surfaces a step lighter) and `:root[data-theme="light"] .loki-phone` with its
  light ones, and adds the `--phone-*` scales
  (text 11 · 13 · 15 · 17 · 20 · 28, radii 8 · 12 · 24 · pill, space 4–24, the 44 touch size, layers, durations).
  On a touch screen the text follows the size set in iOS, as Dynamic Type does: `-apple-system-body` sets the
  document's rem and the text scale keeps its proportions to it (the default draws the px above), clamped from a step
  below to about half again above so rows built around 44px still hold; spacing, touch sizes and the tab bar's
  labels and badge (`--phone-text-tab`) stay fixed, as iOS keeps its tab bar.
- **The dock is a material.** The floating navigation, search and compose buttons are iOS's bar material with
  `blur(20px) saturate(180%)` behind, so the list shows through as it scrolls under; the badge's ring is solid panel,
  so it never shows the list. The accent is the system blue, the unread badge is red as iOS's are, affirmative is the
  accent; the faces are the system sans, mono only for code. System, Light and Dark are the phone's only choices.
  `test/tokens.test.ts` fences the file (literal colours only in custom properties, sizes and radii on the
  scales, every selector under `.loki-phone`, no serif or mono presentation).
- **Safe areas.** Each bottom inset has one owner. On a tab the floating dock (tab-bar.tsx) sits on the home
  indicator and publishes `--phone-nav-clearance`; the one scroll owner adds it once at its end
  (`.loki-phone-scroll::after`) and a fixed bottom stops above it (`.loki-phone-above-nav`). With the navigation
  hidden — a conversation, the Inbox deck, any page — the composer or the decide buttons pad themselves with
  `--phone-safe-bottom`. Nothing else adds bottom space, so there is never a band under the capsule.
- **One scroll owner.** The document never scrolls (`html:has(.loki-phone-shell)` pins it); the shell is
  `100dvh` over `100svh` over fixed inset. Each screen has exactly one vertical scroller: the page's
  `Scroll`, or the thread inside a conversation or card. Headers, notices, composers and decide buttons are
  intrinsic flex rows outside it, with `min-height: 0` on the column so the scroller is the part that gives.
- **Keyboard.** Where the on-screen keyboard only shrinks the visual viewport (iOS), `viewport.ts` sets
  `data-keyboard` with `--phone-viewport-top` and `--phone-viewport-height` from `visualViewport`, and the shell
  fits the visible part with no bottom inset; the notice steps aside and a question or approval scrolls inside
  itself before the box would leave the screen. Without `visualViewport` the layout still works at the
  shrunken layout height.
- **Controls.** One icon set, Lucide's (`app/src/shared/icons.tsx`, which the phone's `icons.tsx` wraps; 1.75
  stroke), the same as the desktop's; no text glyphs or emoji as controls.
  Every target is 44 × 44, a smaller glyph getting its area from an `::after`. Focus flashes as on the Mac, in the
  link colour; a field's flash goes round its whole pill (Search, the composer). The routes' one `main` holds
  whatever screen is up; the dock is the `primary` navigation beside it. Gestures (swipe a card, long-press a
  row) always have a visible button that does the same.
- **Messages.** Under every message, yours and the agent's, its copy button (as markdown), always there, and its
  time beside it (the name above no longer carries one); a long
  press on a message opens its actions (`app/src/phone/use-message-actions.tsx`): Copy, and Select text, which
  shows the message on its own where selection works (the thread keeps the browser's selection and callout off so
  the press is ours). A finger that moves (a scroll, a card swipe) is not a hold. The desktop has the same copy button under
  each message, faint until the row is hovered; the hover toolbar it replaced is gone.
- **Learn.** As the desktop's column lists it: Learn opens on its lists — Review, Leads, Lessons under way,
  Deleted — each its own page (`#/learn/<page>`), so the deck and the leads never share a screen. A lead is a
  card of its own: where it came up, its title, the moment quoted, Start the lesson (the conversation opens and
  the brief goes out as your first message), Not this, and Where it came up.

## Rules

- Blue is for interaction, for what waits on you and for the default button; red is for failures (and the phone's
  and the Dock's badges, as Apple's are). No colour is decoration.
- Glass only on what floats and steers (the sidebar, toolbar groups, menus, popovers, sheets, decisions, the box);
  content is solid. Glass turns solid under Reduce Transparency, Increase Contrast and `data-glass="solid"`.
- Structure encodes truth: no numbering, eyebrows, or dividers that do not carry information.
- Chrome is rounded on the radius scale; nothing on screen is a square plate unless it runs edge to edge.
- Apple's title case on controls, sentences everywhere else (docs/style.md); keys in the menu bar and tooltips, not on
  buttons; sans for every label, mono only for code, data and keys.
- Motion is springs, only transform and opacity, never for the keyboard; reduced motion keeps only short fades; focus is a 2px accent-blue flash that settles on a muted ring (controls) or nothing (text fields).
- No real money amounts on screen, in the repo, or in recordings (R9), but for the agents' estimated spend on the
  usage page (plan 019, KD2); its fixtures and screenshots use made-up numbers.

## Tried and dropped

- **Slack's look (2026-09-23 to 2026-11-14).** The desktop and the phone wore Slack's look and layout: a neutral grey
  ground, a labelled rail of five sections down the left (Preferences among them), a `#` before each chat, a 48px
  name line over a tab row, the red badge for what waits on you and green for the affirmative button, a pill and a
  mode chip under the message box, Flow's keys printed on its buttons and a key legend under the deck, and the
  thread in Slack's anatomy (a face and bold name at the start of each run). Retired for Apple's Human Interface
  Guidelines with Liquid Glass (plan 2026-11-12-1505), by the person's decision: loki borrowed another product's
  identity. Reversed with it: PRODUCT.md's "no glass panels"; red for attention (now blue, as Mail's unread dot);
  green for the affirmative (now the accent, as a Mac's default button); lowercase desktop controls and the phone's
  sentence case (now Apple's title case); keys on buttons (plan 097 KTD9; now tooltips and the menu bar); the
  labelled approval card (now a question); and loki's hand-drawn icons (now Lucide's, native menus included).
- **Tokyo Night (2026-10 to 2026-11-14).** A second colour family, chosen in Preferences › Appearance, Night by night
  and Day by day on the same roles. Retired with the Slack look: loki has one palette on Apple's roles.
- **The new chat pane as a preview (plans 096 and 097, 2026-11-11 to 2026-11-14).** A switch in Preferences ›
  Appearance drew the chat pane and Flow's cards on the new components while the old thread stayed the default. It
  became the only desktop pane with Liquid Glass; the switch went with the old look.
- **The New chat sheet (to 2026-11-14).** ⌘N asked for the agent, folder and name in a sheet. ⌘N now opens an empty
  chat in place with a To: line, created by its first message (U20).
- The drafting table (2026-09-06 to 2026-09-23): brass `--loki-accent` for anything that needs the human,
  verdigris and oxblood, New York for display, Avenir Next Condensed caps tracked 0.14em for title-block
  labels, mono meta tracked 0.06em, square plates with only sheet things rounded, a 1px inset brass focus
  hairline. Retired on 2026-09-23 for Slack, by the user's decision, on the desktop as on the phone.
- Blue `#5b7cfa` as the accent (before 2026-09-06): read as any dark dashboard next to the drafting table.
  Slack's blue came back with Slack's whole system, where it reads as Slack, not as a dashboard.
- Oxblood `#c0665b` (drafting table): 4.20:1 on a panel, under AA for the 12px error strings it carried. Lifted to `#cf7266`
  (4.97:1 on panel, 4.62:1 on panel-header) on 2026-09-08.
- Dimming *text* with opacity (kbd hints at 0.6, done cards at 0.6): the muted grey fell to 2.75:1. Text that
  is secondary is `--loki-muted`; opacity is for icons at rest.
- A blurred veil under the new-chat sheet, and a square sheet: the only glass and the only square dialog in
  the product; both fell in line with the other sheets.
- Side stripes (a 3px red border on the phone's banner, a 2px accent one on a settings note): a leading
  dot or nothing carries the same meaning.
- "arrange" as a title-block cell labelled "sheet": an action inside a block of facts; moved to a plate.
- The native title bar as the only header (2026-09-06 to 2026-09-23): the window's own bar named the view and
  loki drew no chrome above the sheet. Retired with the Slack layout, by the user's decision: the title bar is
  hidden, loki draws a drag strip, and each pane has a header with its name, actions and tabs.
- The desks tree as a drawer over the sheet (2026-09-06 to 2026-09-23): ⌘K or the rail's desk icon opened a
  centred list of every desk (waiting, pinned, recent, the rest), filtered by agent chips, with ⌘P pin, ⌘E
  archive and ⇧↵ open-with-chat. Replaced by the always-there sidebar, now Chats (grouped by agent, pinned on top) and
  ⌘K search; the tree survived as Tasks' picker until Tasks was retired (plan 049).
- A desk that opened on its canvas (to 2026-09-23): the conversation floated on the widgets and switching
  desks meant summoning the drawer. A chat now opens on Messages; the canvas is its Canvas tab (called the Desk tab until 2026-09-27).

- The item's moves in its header (plan 097, U8, 2026-11-12): ItemHeader and ActionBar as one bar, the moves at the
  title's end. Moved back under the box the same day, by the user's decision: a reply and its move go together (⌘]
  and ⌘E send with the reply), the eye is at the box after reading down, and the header is for what the item is.
- A "done" badge on every finished agent turn (plan 097, U4, 2026-11-12): dropped the same day at the user's ask. Nearly
  every turn ends done, so it said nothing and dulled the badges that matter; a finished turn shows its name and time.

## Backlog

The review of 2026-09-08 (`docs/research/2026-09-08-ui-review.md`) scored 26/40 on heuristics and 13/20 on
the code audit. Closed the same day: the primitive vocabulary; focus rings; contrast; reduced motion; the
mod's desk block and the harness's skill bodies rendering as the user's words (they are event rows now); modal
sheets (aria-modal, Tab loop, initial and return focus); the combobox pattern on the desks tree and the model
picker; keyboard access to board cards (roving tabindex in per-column listboxes) and widget frames (arrows
nudge, Alt-arrows resize, Enter frames the camera, a polite announcement). Left, in order: confirmations for
forget / remove / disable and an undo on archive; the jargon and error-string pass; the archive fold inside
the Tasks picker's listbox was unreachable while its search box owned Tab, until Tasks was retired (plan 049). The
desktop's 1100-wide floor (R31 of plan 013) holds: the Flow card fits beside the sidebar.

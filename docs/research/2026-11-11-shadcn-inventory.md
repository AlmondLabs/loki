# shadcn as loki's component library — inventory and fit (2026-11-11)

The user chose [shadcn/ui](https://ui.shadcn.com) as the root of loki's new component library (the component
overhaul in `2026-11-11-design-language.md`). This note takes stock of what loki has, what each piece becomes in
shadcn, and where shadcn meets loki's own rules. It decides nothing; the open choices are at the end.

Counts are from `main` at `b1adc7ad`: uses as JSX in `app/src`, then the number of files using it.

## 1. The stack: how ready loki already is

1. **Tailwind v4 is already installed** (`tailwindcss`, `@tailwindcss/vite`), with `app/src/styles.css` as its
   entry and an `@theme inline` block that exposes the loki tokens as utilities (`bg-loki-panel`). The shadcn CLI
   detects it ("tailwindVersion v4", CSS file `app/src/styles.css`). Today only the agents' widgets use Tailwind;
   the app itself uses none of it.
2. **React 19 with the React Compiler, Vite 7, TypeScript.** All supported by shadcn's Vite setup.
3. **How the app is styled today:** 1,269 `loki-*` class uses (in `components.css`, `chat.css`, `phone.css`,
   `desk-sidebar.css`, `search-sheet.css`), 651 inline `style={{…}}` blocks in 75 files, and 59 raw `<button>`s
   outside the primitives. Moving to shadcn means moving all of this to Tailwind utilities and shadcn variants,
   surface by surface; it is most of the work.
4. **No `components.json`, no `cn()` helper, no `@/` alias.** The only path alias is `@loki/kit` (the widget kit the
   agents' files import), which the CLI picked up as the import alias; shadcn must not use it (see 3, item 8).
5. **No primitive library.** loki's own `components/index.tsx` (913 lines) does focus traps, return focus, Escape,
   roving focus, popover placement and the combobox pattern by hand. shadcn brings either Base UI or Radix for this.
6. **Sonner is already the toast** (`Notices`, `notify`), which is what shadcn's Radix base uses.
7. **The npm runner is `npx`** (the repo has `package-lock.json`).
8. **The macOS floor is 13.0** (`src-tauri/tauri.conf.json`). Tailwind v4 targets Safari 16.4 and later (macOS
   13.3); on 13.0 to 13.2 some of its CSS (`@property`, `color-mix()`) degrades. Worth raising the floor to 13.3.

## 2. Component by component

**Fit:** _direct_ — a shadcn component does the same job; _adapt_ — a shadcn component, restyled or extended;
_compose_ — built from several shadcn components; _own_ — stays loki's, built on shadcn's tokens.

### 2.1 Primitives (`app/src/components/index.tsx`)

| loki                          | Uses     | shadcn                                                                 | Fit     | Notes                                                                                                         |
| ----------------------------- | -------- | ---------------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------- |
| Button                        | 164 / 53 | Button                                                                 | adapt   | Tones map: quiet → outline or ghost, paper → secondary, brass → link or ghost, positive → default, negative → destructive. Heights 28 · 36 · 44 set in its `cva` sizes. |
| IconButton                    | 17 / 11  | Button `size="icon"`                                                   | direct  | Sizes 24 · 28 · 36 · 40 as icon sizes.                                                                        |
| NavButton                     | 0        | —                                                                      | drop    | Unused.                                                                                                       |
| Chip                          | 37 / 20  | Badge, Toggle, ToggleGroup                                             | adapt   | One loki component does three jobs: a status tag (Badge), a chosen pick (Toggle), a filter row (ToggleGroup). Split by job. |
| Field                         | 7 / 6    | Input, InputGroup                                                      | direct  | Name clash: shadcn's `Field` is the form-row wrapper (label, control, description), not the input.            |
| TextArea                      | 5 / 4    | Textarea, InputGroupTextarea                                           | direct  |                                                                                                               |
| Row                           | 20 / 10  | Item                                                                   | adapt   | shadcn's Item (media, title, description, actions) is the list row.                                           |
| Sheet                         | 21 / 18  | Dialog, Sheet, Drawer, AlertDialog                                     | adapt   | loki's one Sheet is a centred dialog, a top sheet or a bottom sheet. Split: Dialog (centre), Drawer (bottom, phone), AlertDialog (confirmations, which the backlog asks for). |
| Popover                       | 3 / 3    | Popover, DropdownMenu, ContextMenu                                     | direct  | The row menus (right click) become ContextMenu; header menus DropdownMenu.                                    |
| Kbd                           | 9 / 5    | Kbd                                                                    | direct  |                                                                                                               |
| Meta                          | 77 / 18  | —                                                                      | own     | A text style (12px muted). Becomes a utility class or a two-line component; no shadcn piece.                 |
| Title                         | 5 / 4    | CardTitle, typography                                                  | adapt   |                                                                                                               |
| Dot                           | 15 / 14  | Badge (dot variant)                                                    | own     | A status dot; small enough to keep as a Badge variant.                                                        |
| Empty, EmptyPane              | 10 / 5   | Empty                                                                  | direct  |                                                                                                               |
| Banner                        | 4 / 1    | Alert                                                                  | direct  |                                                                                                               |
| Notices, notify               | sonner   | Sonner (Radix base) or Toast (Base UI base)                            | direct  | Depends on the base (4, item 1).                                                                              |
| Switch                        | 5 / 4    | Switch inside Field                                                    | direct  |                                                                                                               |
| ListIcon                      | 2 / 2    | Avatar, ItemMedia                                                      | direct  |                                                                                                               |
| ListRow, ListSection          | 1 / 1    | SidebarMenuItem, SidebarMenuButton, SidebarMenuBadge, SidebarGroup     | adapt   | The Slack layout's list blocks.                                                                               |
| TabRow                        | 2 / 2    | Tabs (`variant="line"`)                                                | direct  |                                                                                                               |
| PaneHeader                    | 1 / 1    | —                                                                      | compose | A header bar with Breadcrumb, Tabs and Buttons.                                                               |

### 2.2 Shell (`app/src/shell/`)

| loki                                   | shadcn                                              | Fit     | Notes                                                                                                   |
| -------------------------------------- | --------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------- |
| Rail and list column                   | Sidebar (collapsible "icon"), nested sidebars block | adapt   | shadcn's nested-sidebar block is an icon rail beside a second column, loki's shape. The labelled rail stays. |
| List column drag to resize (220–420)   | Resizable                                           | direct  |                                                                                                         |
| Title strip, Windows and Linux strip   | —                                                   | own     | Window chrome; shadcn has no piece. The ☰ menu becomes Menubar or DropdownMenu.                         |
| Search (⌘K)                            | Command inside Dialog (CommandDialog)               | direct  |                                                                                                         |
| Keys sheet                             | Dialog with Kbd                                     | compose |                                                                                                         |
| Preferences sheet                      | Dialog with a Sidebar inside (settings-dialog block)| compose |                                                                                                         |
| Chats sidebar filter, sections, rows   | SidebarInput, SidebarGroup, SidebarMenu*, Collapsible | adapt |                                                                                                         |
| Row menu (right click)                 | ContextMenu                                         | direct  |                                                                                                         |
| "Needs you" pill at the list's edge    | Button                                              | compose |                                                                                                         |

### 2.3 Conversation (`app/src/chat/`)

shadcn now ships chat primitives for both bases: MessageScroller, Message, Bubble, Attachment, Marker, Trace and
CodeBlock. They cover most of what loki built by hand.

| loki                                        | shadcn                                                          | Fit     | Notes                                                                                                           |
| ------------------------------------------- | --------------------------------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------- |
| Transcript scroll, follow, "new" chip       | MessageScroller (+ Viewport, Content, Item, Button)             | direct  | Streaming follow, anchoring and jump-to-latest are built in; loki's hand-written scroll logic goes.             |
| Message rows (face, name, time)             | Message                                                         | adapt   | The anatomy is the redesign's choice (Turns, Console, Briefing), not Slack's runs.                             |
| Agent and user speech surfaces              | Bubble                                                          | direct  |                                                                                                                 |
| Tool steps ("Worked 14 min · …", opened)    | Trace, TraceLine, TraceCollapsible                              | adapt   | The closest match in shadcn: one Trace per stretch of work, a line per step. The filter chips past 8 steps stay loki's. |
| Day pill, "New" line, widget rows, compaction | Marker                                                        | direct  |                                                                                                                 |
| Attachments (+ in the box)                  | Attachment                                                      | direct  |                                                                                                                 |
| Code, diffs, tool output                    | CodeBlock                                                       | direct  |                                                                                                                 |
| Composer (chat-input)                       | InputGroup, InputGroupTextarea, InputGroupAddon, Button         | compose |                                                                                                                 |
| Model picker                                | Popover + Command (desktop), Drawer + Command (phone)           | compose |                                                                                                                 |
| Permission mode                             | Select or DropdownMenu                                          | direct  |                                                                                                                 |
| Slash palette                               | Command                                                         | direct  |                                                                                                                 |
| Approval, question, suggestion cards        | Card, Button, RadioGroup, Alert                                 | compose | The redesign may merge these into one "waiting on you" component.                                               |
| Quick replies                               | Button group or ToggleGroup                                     | direct  |                                                                                                                 |
| Link cards, inline widgets                  | Card, Item                                                      | compose | The widget inside stays the kit's.                                                                              |
| Find bar                                    | InputGroup                                                      | direct  |                                                                                                                 |

### 2.4 Flow, Canvas, Agents, Learn, Preferences

| Area        | loki                                                      | shadcn                                                       | Fit     |
| ----------- | --------------------------------------------------------- | ------------------------------------------------------------ | ------- |
| Flow        | Deck and cards, card head                                 | Card, Item, Avatar, Badge                                    | compose |
| Flow        | Slack, mail and Jira threads; reactions; mentions         | Message, Bubble, Badge, Toggle; mail HTML stays its own      | compose |
| Flow        | Reply proposal                                            | Card, InputGroupTextarea                                     | compose |
| Flow        | Return picker (snooze)                                    | Popover + Calendar, or DropdownMenu                          | compose |
| Flow        | Lanes, agent filter pills                                 | ToggleGroup or Tabs                                          | direct  |
| Canvas      | Sheet, camera, widget frames (react-zoom-pan-pinch)       | —, Card for the frame, ContextMenu                           | own     |
| Agents      | Column, profile, memory, changes, reflection, skills      | Sidebar, Tabs, Card, Item, Table                             | compose |
| Learn       | Review deck, leads                                        | Card, Progress, Button                                       | compose |
| Preferences | Pages of settings, accounts, engines, usage, MCP, lanes   | Field, FieldGroup, FieldSet, Switch, Select, RadioGroup, Table, AlertDialog, Separator | compose |
| Charts      | Recharts (kit's ChartCard, usage bars)                    | Chart (wraps Recharts)                                       | adapt   |

### 2.5 Phone (`app/src/phone/`)

| loki                                      | Uses    | shadcn                         | Fit     | Notes                                                                                                  |
| ----------------------------------------- | ------- | ------------------------------ | ------- | ------------------------------------------------------------------------------------------------------ |
| TopBar, BackButton                        | 15 / 10 | —                              | own     | iOS-style navigation bar.                                                                              |
| Scroll                                    | 13 / 8  | ScrollArea, or plain overflow  | own     | The "one scroll owner" rule stays.                                                                     |
| Bottom sheets (sheet-motion, let-go)      | —       | Drawer                         | adapt   | Drawer follows a finger, but loki's springs and its projected let-go are its own; keep them or accept Drawer's feel. |
| ConfirmSheet                              | 0       | AlertDialog or Drawer          | direct  | Unused today.                                                                                          |
| Avatar, RowIcon                           | 13 / 9  | Avatar                         | direct  |                                                                                                        |
| PhoneRow, RowSection, RowGroup, MenuRow, FactRow | 42 / 13 | Item, ItemGroup, Separator | adapt   | iOS-grouped lists.                                                                                     |
| SkeletonRows, SkeletonCard                | 9 / 6   | Skeleton                       | direct  |                                                                                                        |
| Tab bar (the floating dock)               | —       | —                              | own     | The blurred material dock.                                                                             |

### 2.6 Icons

loki draws its own icon family (`shared/icons.tsx`, about 40 outlined icons, 24 box, 1.8 stroke), wrapped again by
`phone/icons.tsx`. shadcn components import icons from one configured library (Lucide by default; Tabler,
Hugeicons, Phosphor and others offered). Lucide's style (outlined, 24 box, 2 stroke, round caps) is close to
loki's own.

### 2.7 The tally

1. **Direct** (about 30 pieces): buttons, inputs, popovers and menus, Kbd, Empty, Alert, toasts, Switch, Tabs,
   Command for search and the slash palette, Resizable, the chat scroller, Marker, Attachment, CodeBlock, Skeleton,
   Avatar.
2. **Adapt** (about 15): Chip split three ways, Sheet split four ways, Row and the phone rows as Item, the sidebar,
   Message, Trace for tool steps, Drawer, Chart.
3. **Compose** (most screens): the composer, model picker, approval cards, Flow cards, Preferences, Agents, Learn.
4. **Own** (a handful): Meta and Dot as small styles, the title strip, the canvas, the phone's top bar and dock.

Nothing in loki is impossible in shadcn; the cost is in moving 75 files of inline styles and the hand-written
behaviour to it, and in the rule clashes below.

## 3. Where shadcn meets loki's rules

1. **Doc comments on every export** (AGENTS.md, `eslint-plugin-jsdoc`). shadcn's files have none, so `npm run lint`
   fails on each added component. Either each added file gets its doc comments, or the shadcn folder is exempt.
2. **`test/tokens.test.ts`** reads every `.ts`, `.tsx` and `.css` under `app/src` for literal colours, sizes,
   radii, tracking, shadows and layers. shadcn writes styles as Tailwind classes, which the test does not read,
   and some components carry what loki bans (`tracking-widest` on menu shortcuts). In Tailwind v4 the scales
   themselves can be the fence: reset the default theme in `@theme` (`--color-*: initial`, a spacing step, the
   radius and text scales) so only loki's values exist as utilities. The test then checks the theme and a few
   class patterns instead of inline numbers.
3. **Focus.** shadcn draws a 3px ring on `focus-visible`; loki flashes a 2px accent ring that settles to a muted
   one (or nothing on text fields). The ring classes in each component change to loki's rule, or the rule changes.
4. **Motion.** shadcn animates overlays with `tw-animate-css` keyframes (fade, zoom, slide). loki's rule is springs
   (`--spring-*` linear() curves), transform and opacity only, nothing animated from the keyboard, short fades only
   under reduced motion. The overlay classes need loki's springs, and the keyboard rule needs a data attribute the
   overlays can read.
5. **Layers.** shadcn overlays use `z-50`; loki stacks by `LAYER` (panel 100, modal 200, the Windows strip 250
   above sheets, toasts 300). Map the layers into the theme (`--z-*`) and set them in the overlay components.
6. **Dark mode.** shadcn switches on a `.dark` class; loki on `data-theme` (plus `data-palette` and the phone's
   `.loki-phone` scope). A custom variant (`@custom-variant dark (&:where([data-theme=dark], [data-theme=dark] *))`)
   and shadcn's variables defined from loki's roles keep loki's switching as it is.
7. **Hover.** Tailwind v4's `hover:` applies only where the device can hover, which is loki's rule already.
8. **The widget surface.** "Widgets on the sheet keep `@loki/kit`; app chrome never ships into that surface."
   shadcn's components go in their own folder under a new alias, never under `@loki/kit`. Whether the agents'
   widgets may also use shadcn is a separate choice.
9. **Names and files.** shadcn's files are kebab-case with named exports, as loki requires. Its `Field` and
   `Sheet` mean different things from loki's, so the old primitives are retired rather than renamed alongside.
10. **Speed and memory.** Base UI or Radix and the Tailwind classes add weight; loki's objective is the snappiest
    app at least cost. Measure bundle size and redraws on the thread before and after the first surface moves.

## 4. Choices for the user

1. **Base: Base UI (decided 2026-11-11).** Base UI over Radix. What follows from it: triggers and closes take
   `render={<Button />}` instead of `asChild`, and a `render` that makes a non-button element adds
   `nativeButton={false}`; shadcn's Base UI toast replaces Sonner, so `Notices` and `notify` move to it and the
   `sonner` dependency goes; Select takes an `items` prop, ToggleGroup a `multiple` flag, Slider a single value.
   The table rows in section 2 that say "Sonner (Radix base) or Toast (Base UI base)" now mean Toast.
2. **Icons: Lucide (decided).** `lucide-react` becomes loki's icon family; `shared/icons.tsx` and the phone's
   wrapper retire as the surfaces move.
3. **Doc comments: the shadcn folder is exempt (decided).** Lint skips `app/src/ui/`, so upstream updates diff and
   merge cleanly; AGENTS.md and `docs/style.md` say so.
4. **Where it lives:** shadcn's source in `app/src/ui/` with a `@/` alias to `app/src`, beside
   `app/src/components/` until the old primitives are gone (the default, not yet confirmed).
5. **First surface: the thread (decided).** The chat components replace the most hand-written code there.
6. **Phone sheets: shadcn's Drawer as it is (decided).** loki's own sheet motion (`components/sheet-motion.ts`,
   `kit/let-go.ts` for sheets) goes; Drawer's drag feel is accepted. This reverses the spring and let-go rules in
   `docs/design.md` for bottom sheets.

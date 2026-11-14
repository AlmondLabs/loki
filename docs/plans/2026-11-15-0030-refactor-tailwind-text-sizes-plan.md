---
title: Tailwind's text sizes and root - Plan
type: refactor
date: 2026-11-15
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
execution: code
---

# Tailwind's text sizes and root - Plan

---

## Goal Capsule

- **Objective:** anyone writing a loki screen, or an agent writing a widget, sizes text with Tailwind's own four classes and nothing loki-specific. The app reads with four sizes instead of six.
- **Means:**
  - loki's nine text-size tokens and its 15px root go away, and every use moves to `text-xs`, `text-sm`, `text-base` or `text-2xl` by role (KTD1, KTD2).
  - The token test allows only those four (KTD6).
- **Authority:**
  1. The Product Contract's Requirements.
  2. Then the Key Technical Decisions.
  3. Then the units.

  `docs/design.md` follows this plan.
- **Stop conditions.** Stop and ask if:
  1. A Tailwind default value (a size, a line height, the spacing step) would need changing anywhere, phone included.
  2. A screen breaks rather than just reads larger: text clipped or overlapping, a row that no longer fits its control, or a layout that wraps where it didn't.
- **Execution profile:** front-end only, many files, mechanical renames plus three config removals. It ships as one PR (`refactor/tailwind-text-sizes`) after PR #269 merges, and this plan ships in it.

---

## Product Contract

### Summary

Size all of loki's text with Tailwind's default `text-xs`, `text-sm`, `text-base` and `text-2xl`, at Tailwind's default 16px root. Remove loki's nine `--loki-text-*` tokens, the `text-micro` … `text-hero` classes, the 15px root and the `--spacing` override. Hold the result in `test/tokens.test.ts` and `docs/design.md`.

### Problem Frame

loki has nine text-size names for six sizes: 10, 11, 13, 15, 22 and 26px. They are drawn against a 15px root, so Tailwind's own sizes don't mean what Tailwind says, and `--spacing: 4px` exists only to undo that root.

The phone redefines the same nine names at its own sizes. The token test's `FONT_SCALE` is a stale mix of desktop and phone numbers. shadcn's components in `app/src/ui` were rewritten to loki's names (`text-meta`, `text-body`) instead of their upstream classes.

Agents' widgets are told Tailwind classes work, yet in loki `text-sm` is 13.1px rather than 14.

### Requirements

**Sizes**
- R1. Every font size in loki's own views and stylesheets, desktop and shared, is one of Tailwind's `text-xs` (12px), `text-sm` (14px), `text-base` (16px) or `text-2xl` (24px). A stylesheet rule uses the matching theme variable (`var(--text-xs)` …). Phone-only rules keep the phone's `--phone-text-*` scale.
- R2. loki defines no text-size tokens: no `--loki-text-*`, and no `--text-*` of its own in `styles.css`.
- R3. Today's sizes map by role: 10 and 11 → `xs`, 13 → `sm`, 15 → `base`, 22 and 26 → `2xl`.

**Tailwind as shipped**
- R4. The desktop page uses the browser's default root (16px). loki sets no `--spacing` and no other root size. The one exception is the phone's existing Dynamic Type root (`font: -apple-system-body` on touch iPhones), which stays, so shared parts' text and spacing on the phone follow the iPhone's Text Size. Tailwind's sizes, line heights and spacing step are used unchanged in all shared and desktop code. Phone-only rules keep `--phone-text-*` and `--phone-space-*`.
- R5. shadcn's components in `app/src/ui` use Tailwind's size classes (`text-xs`, `text-sm` …), as upstream does.

**Fence and guide**
- R6. `npm test` fails any other text-size class, any `--loki-text-*`, and any literal font size in desktop or shared code.
- R7. `docs/design.md` describes the four sizes and the default root.

### Key Decisions

- **Four sizes, Tailwind's defaults, no loki tokens.** (session-settled: user-directed — chosen over loki-named sizes and over taking Tailwind's names with loki's values: one vocabulary for screens and widgets.) Governs R1, R2.
- **Tailwind's default root and values as they ship.** (session-settled: user-directed — chosen over keeping loki's 15px root: the user accepts that loki reads slightly larger.) Governs R4.
- **The phone takes Tailwind's defaults too.** (session-settled: user-directed — chosen over the phone mapping Tailwind's four sizes onto its capped Dynamic Type steps and keeping a fixed 4px spacing step. Shared parts' text and spacing on the phone now follow the iPhone's Text Size, uncapped.) Governs R4.
- **The mapping is by role.** (session-settled: user-approved — chosen over keeping six sizes: 10 and 26 carried no distinct role.) Governs R3.

### Scope Boundaries

- Phone-only rules in `phone.css` keep `--phone-text-*` and `--phone-space-*`. The touch ternaries that pick `var(--phone-text-body)` stay.
- Font weight, family and colour are unchanged.
- Considered and not built: restoring a 1.5 line height on reading text in `item/` that loses it to Tailwind's paired line heights. The user accepted a slightly different look; evidence of clipped or crowded text would change this.

#### Deferred to Follow-Up Work

- Checking the phone at the largest accessibility Text Size. Shared parts' text, gaps and Tailwind sizing classes (`h-*`, `size-*`, touch targets) now scale uncapped by decision, so layouts may need their own fixes there.

---

## Planning Contract

### Key Technical Decisions

- KTD1. **Stylesheet rules swap the variable, and keep their line height.** `font-size: var(--loki-text-meta)` becomes `font-size: var(--text-xs)`, and so on by R3. A rule's own `line-height` stays. Where it set none, it keeps inheriting 1.5 from the root. Tailwind's paired `--text-*--line-height` applies only through the classes. Governs R1, R3.
- KTD2. **Classes swap name, and take Tailwind's paired line height.** `text-meta` and `text-tag` become `text-xs`, `text-body` and `text-row` become `text-sm`, and `text-display` and `text-hero` become `text-2xl`. Variant prefixes such as `group-data-[size=sm]/card:` are kept. These elements now get Tailwind's line heights (xs about 1.33, sm about 1.43, 2xl about 1.33) instead of an inherited 1.5. That is accepted (Scope Boundaries). Inline `lineHeight` and `leading-*` still win. Governs R1, R5.
- KTD3. **Inline styles swap the variable string.** `fontSize: "var(--loki-text-body)"` becomes `"var(--text-sm)"`. Touch ternaries keep their phone branch. Governs R1.
- KTD4. **Remove the three overrides last, in one commit.** These are:
  - the `font: 15px/1.5 …` size in `app/index.html`, keeping the family and 1.5 line height
  - the `--spacing: 4px` and the nine `--text-*: var(--loki-text-*)` lines in `app/src/styles.css`
  - the nine `--loki-text-*` in `app/src/kit/tokens.css` and their redefinitions in `app/src/phone/phone.css`

  The phone's Dynamic Type root in `phone.css` (`@supports (font: -apple-system-body)`) stays (R4). This happens after every use has moved, so no commit renders with a missing token. Governs R2, R4.
- KTD5. **The four theme variables are always emitted, from the first commit.** Tailwind writes a theme variable only when something in its source graph uses it. `chat.css`, `shell/*.css` and `phone.css` are imported from JS, outside that graph, and nothing uses a `text-base` class today. So U1 adds `@source inline("text-xs text-sm text-base text-2xl")` to `styles.css` before any `var(--text-*)` rewrite. That makes `--text-xs` … `--text-2xl` defined for every stylesheet and inline `var()` use. The paired line heights still apply only through the classes (KTD1). It changes no value. Governs R1, R4.
- KTD6. **The fence checks values, not pixel numbers.**
  - `FONT_SCALE` goes. A desktop or shared CSS `font-size` must be `var(--text-(xs|sm|base|2xl))`, `inherit` or `var(--phone-text-*)`. An inline `fontSize` string must be one of those `var()` forms.
  - A numeric font size fails wherever it appears: `fontSize:` in a style object, a JSX `fontSize={…}` prop, or a numeric `size` constant that feeds `fontSize`. The only exemption is AgentFace's computed `Math.max(9, …)` line, not the whole `desk/agent-chip.tsx` file.
  - Any `--loki-text-` in `app/src` fails.
  - The class fence fails Tailwind's other sizes (`text-lg`, `text-xl`, `text-3xl` and up) and the retired names (`text-micro` … `text-hero`). Without that, a retired name would silently do nothing. It also covers `ui/`.
  - The retired-name pattern is anchored so a word character or hyphen can't come before it (`(?<![\w-])text-(micro|…|hero)\b`). The kept `var(--phone-text-body)` strings then pass, while `text-meta` and a variant-prefixed `hover:text-meta` fail.
  - `test/shell-look.test.ts`'s type-scale tests are replaced with assertions that none of R2's tokens exist, `styles.css` has no `--spacing`, and `index.html` sets no root size.

  Governs R6.
- KTD7. **Widgets need no migration notice.** `skills/loki/SKILL.md` names no text token; it tells agents to use Tailwind classes. A widget on a user's disk that used `var(--loki-text-*)` falls back to its inherited size, a graceful degradation. Widget frames copy the page's CSS, so they move to the 16px root with the app. Governs R2.
- KTD8. **`cn`'s font-size extension goes.** `app/src/lib/utils.ts` teaches tailwind-merge loki's size names, and it is already stale (it lists `card`, not `title`). With only default sizes there is nothing to teach. Governs R2.

### Sequencing

U1 adds the `@source inline` (KTD5), then writes the fence first as the worklist and commits it last. U1 to U3 move every use while the old tokens still exist and the new variables are already defined, so the app renders throughout. U4 removes the overrides, and U5 lands the fence and the guide.

---

## Implementation Units

### U1. Move the stylesheets' sizes

**Goal:** every desktop and shared stylesheet rule sizes text with `var(--text-*)`.

**Requirements:** R1, R3 (KTD1)

**Dependencies:** none

**Files:**
- `app/src/components/components.css`, `app/src/chat/chat.css`, `app/src/shell/search-sheet.css`, `app/src/shell/desk-sidebar.css`
- `app/src/kit/tokens.css` (`.loki-label`, `.loki-widget-body`)
- `app/src/styles.css` (the `@source inline` only)
- `test/tokens.test.ts` (fence written here and run locally, committed in U5)

**Approach:**
1. Add KTD5's `@source inline` to `styles.css`.
2. Write KTD6's fence and its self-tests, and run them to get the worklist.
3. Swap every stylesheet `var(--loki-text-*)` by R3, keeping each rule's line height.

**Test scenarios:** Test expectation: none -- a size rename. The fence written here holds it, and screenshots verify it.

**Verification:** no `var(--loki-text-` remains in a stylesheet outside the token definitions.

### U2. Move the views' inline sizes

**Goal:** inline `fontSize` in views uses the `var(--text-*)` strings.

**Requirements:** R1, R3 (KTD3)

**Dependencies:** U1

**Files:** about 40 `.tsx` files under `agents/`, `chat/`, `desk/`, `kit/`, `recall/`, `settings/` and `shell/` that set `fontSize: "var(--loki-text-…)"`. The fence lists them. They include `kit/index.tsx` (the hero Stat), `kit/chart-view.tsx`, `desk/widget-frame.tsx`, `settings/settings.tsx` and `shell/welcome.tsx`.

Also these numeric sizes, which the old fence didn't see:
- AgentChip's default `size = 10.5` in `desk/agent-chip.tsx` (a tag role, so `var(--text-xs)`)
- the desktop branch `12` of `const size = touch ? "var(--phone-text-body)" : 12` in `desk/mail-address.tsx` and `desk/outside-card.tsx` (typed body text, so `var(--text-sm)`)
- the chart's axis `fontSize={11}` in `kit/chart-view.tsx` (meta, so `var(--text-xs)`)

**Approach:**
1. Swap each string and numeric size by R3 and the list above.
2. Keep the touch ternaries' phone branch.

**Test scenarios:** Test expectation: none -- a rename held by the fence.

**Verification:** no `--loki-text-` remains in a `.tsx` file.

### U3. Move the classes, shadcn's included

**Goal:** every size class in loki's source is one of Tailwind's four.

**Requirements:** R1, R5 (KTD2, KTD8)

**Dependencies:** U1

**Files:**
- `app/src/item/*.tsx` (proposal, work, composer, message-entry, event-entry, reply-box, timeline, thought, agent-plan, agent-turn, content-parts, outside-rows)
- `app/src/ui/**` (about 90 uses across ai-elements and the shadcn primitives)
- `app/src/dev/workbench.tsx`
- `app/src/lib/utils.ts`
- `test/cn.test.ts`

**Approach:**
1. Rename each class by KTD2, keeping variant prefixes.
2. Drop `cn`'s font-size extension and update its test to Tailwind's names.

**Test scenarios:**
- `cn("text-sm", "text-xs")` keeps only `text-xs`. tailwind-merge already knows Tailwind's own sizes.

**Verification:** `rg -P '(?<![\w-])text-(micro|fine|tag|meta|body|row|title|display|hero)\b' app/src` finds nothing.

### U4. Remove the overrides

**Goal:** loki uses Tailwind's root, spacing step and sizes as shipped.

**Requirements:** R2, R4 (KTD4, KTD5, KTD7)

**Dependencies:** U1, U2, U3

**Files:** `app/index.html`, `app/src/styles.css`, `app/src/kit/tokens.css`, `app/src/phone/phone.css`

**Approach:**
1. Remove the overrides by KTD4.
2. Rewrite the comments that explain the old 15px root and `--spacing`. That includes `phone.css`'s Dynamic Type comment, which says spacing and touch sizes stay fixed: they now follow Text Size in shared parts.

**Test scenarios:** covered by U5's assertions on these files.

**Verification:** at 1440 in the browser, `getComputedStyle(document.documentElement).fontSize` is 16px. A `gap-2` measures 8px. `.loki-meta` text measures 12px, body text 14px, the toolbar title 16px and a pane's large title 24px.

### U5. The fence and the guide

**Goal:** `npm test` holds R6, and the guide says what is true.

**Requirements:** R6, R7 (KTD6)

**Dependencies:** U4

**Files:** `test/tokens.test.ts`, `test/shell-look.test.ts`, `docs/design.md`

**Approach:**
1. Commit U1's fence.
2. Replace `shell-look`'s type-scale tests by KTD6.
3. Retarget the `.loki-meta` and `.loki-label` tests to `var(--text-xs)`.
4. In `docs/design.md`, rewrite:
   - the type scale (four sizes, by role)
   - the spacing paragraph's note on the 15px root and `--spacing`
   - the line saying views never use Tailwind's default sizes
   - the phone paragraph's rule that spacing and touch sizes stay fixed: in shared parts they now follow Text Size, and phone-only rules keep `--phone-space-*`

**Test scenarios:**
- A CSS `font-size: var(--loki-text-body)` fails.
- `font-size: 13px` fails.
- `font-size: var(--text-sm)` passes.
- `fontSize: "var(--phone-text-body)"` passes.
- `text-meta` fails, `text-lg` fails, and `text-xs text-sm text-base text-2xl` pass.
- `"var(--phone-text-body)"` passes the class fence.
- A JSX `fontSize={11}` fails.
- `styles.css` declaring `--spacing` fails.
- `index.html` setting a px root fails.
- Each case is seen to fail on its bad input.

**Verification:** `npm test` passes, and each new case fails on its bad input.

---

## Verification Contract

| Check | When | Done signal |
|---|---|---|
| `npm run lint:fast`, `npm run typecheck`, `npm test` | each unit | clean; the fence's remaining failures shrink to zero by U4 |
| `npm run format:check && npm run lint && npm run typecheck && npm test && npm run test:node` | before pushing, with CI's toolchain (newest Node 22, npm 10, `SHELL=/bin/bash`) | all pass |
| `npm run build:app && npm run build:mod && npm run smoke` | before pushing | all pass |
| Sandbox screenshots and measurement | before any change and after U4 | the 84 Mac screens at 1440 light and dark plus the phone home screen. Every screen differs, as decided. Measured sizes match U4's verification, and no screen shows clipped or overlapping text (stop condition 2) |
| PR CI, Windows included | after pushing | green |

---

## Definition of Done

- Every unit's verification holds, and the Verification Contract's checks pass.
- `rg -P -- '--loki-text-|(?<![\w-])text-(micro|fine|tag|meta|body|row|title|display|hero)\b' app/src` finds nothing.
- `docs/design.md` describes the four sizes and the default root.
- No abandoned attempt or scratch file is left in the diff. This plan is in the PR.
- The PR body shows before and after screenshots and names what was not checked by hand: the phone's screens beyond its home screen (its views can't pair with the sandbox daemon), the phone at large Text Size, the Mac app window and Windows.

---

## Appendix

### Sources

- Token definitions: `app/src/kit/tokens.css` (`--loki-text-*`), `app/src/styles.css` (`--text-*: var(--loki-text-*)`, `--spacing: 4px`), `app/src/phone/phone.css` (the phone's redefinitions; the Dynamic Type root under `@supports (font: -apple-system-body)`), and `app/index.html` (`font: 15px/1.5`).
- Use counts from the research:
  - stylesheet and inline `var()` uses: meta 102, body 64, title 13, tag 12, row 12, display 9, fine 5, micro 3, hero 2
  - class uses: meta 87 (38 in `ui/`), body 71 (53 in `ui/`), row 4, tag, display and hero 1 each
- Tailwind 4.3's theme (`node_modules/tailwindcss/theme.css`):
  - `--text-xs` 0.75rem with a line height of 1/0.75
  - `--text-sm` 0.875rem with 1.25/0.875
  - `--text-base` 1rem with 1.5
  - `--text-2xl` 1.5rem with 2/1.5
  - The default `--spacing` is 0.25rem.
- Agent guidance: `skills/loki/SKILL.md` tells widgets to use Tailwind classes and loki's colour tokens, and names no text token.

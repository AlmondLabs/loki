# Plan: Redesign the Desktop Agents Section (Apple HIG + Liquid Glass)

## Context

The desktop **Agents** section (`app/src/agents/`) was wired into the three-column shell without receiving the Apple HIG / Liquid Glass redesign applied to **Chats**, **Flow**, **Learn**, and **Preferences**:

- Switching to `Profile` collapsed the middle list column (`agentsHasList`), shifting the header and content horizontally across the window.
- `+` (**New Agent**) lived in the middle list column's toolbar even when that list showed *Memory*, *Changes*, *Reflection*, or *Skills*, and vanished on `Profile`.
- Five tabs crowded `PaneHeader`, and `Reflection` combined a per-agent commit filter with global settings for every agent.
- Page actions (*Ask to Update*, *Revert*, *Write*, *Install*, *Refresh*, *Remove*) sat inside scrolled content strips instead of `PaneHeader`'s trailing glass `ToolbarGroup`, and feedback hijacked the header subtitle via a custom `flash()` timer.
- `ProfilePage`, `NewAgent`, and `SkillsPage` used inline borderless fields, raw `<datalist>` / `<select>`, inline red/bordered boxes, and `<Chip>` radio toggles instead of Preferences' grouped `.loki-settings-block` cards, `PopUp`, `Switch`, `Segmented`, `ModelChoices`, and `Sheet` confirmations.

## Design

1. **Navigation & Column Stability (`pages.ts`, `selection.ts`, `sidebar.tsx`, `agents-column.tsx`)**:
   - Reduce Agents tabs to 4 (`Profile`, `Memory`, `Changes`, `Skills`) and default first visits to `Profile`; migrate saved `"reflection"` tab state to `"changes"`.
   - Keep the three-column layout stable across all tabs (`agentsHasList` true whenever `agentCount > 0`), showing the agent's live chats in the middle list column on `Profile`.
   - Add an optional section header action to `PlaceSources` so `+` (**New Agent**) lives on the **Agents** heading in the sidebar and opens `NewAgent` in a `Sheet`.

2. **Global Reflection Settings in Preferences (`settings/pages.ts`, `settings/reflection.tsx`, `settings/settings.tsx`)**:
   - Move global reflection and fallback-provider toggles out of Agents into **Preferences › Flow and Learn › Reflection** using `Block`, `Setting`, `Switch`, and `Segmented`.
   - Replace the per-agent `Reflection` tab with `FilterPills` (`All`, `Reflection`, `Doctor`) in **Changes**.

3. **Toolbar Actions & Notices (`agents.tsx`, `use-agent-details.ts`)**:
   - Move page actions into `PaneHeader`'s trailing `ToolbarGroup` (*Main Chat* / *New Chat* on Profile, *Ask to Update* on Memory, *Revert* on Changes, *Write Skill* / *Install Skill* / *Refresh* / *Remove Skill* on Skills).
   - Route agent action notices through Sonner `notify()` instead of mutating the `PaneHeader` subtitle.

4. **HIG Forms, Model Picker & Lists (`model-select.tsx`, `profile-page.tsx`, `new-agent.tsx`, `changes-page.tsx`, `memory-page.tsx`, `skills-page.tsx`)**:
   - Add `ModelSelect` reusing `ModelChoices` in a `Popover` (shared by `ProfilePage` and `NewAgent`).
   - Rebuild `ProfilePage` with a clean hero header (including Lucide star for favourites) and Preferences `.loki-settings-block` groups (`Identity`, `MCP servers`, danger zone), `PopUp` for `Lives on`, and a confirmation `Sheet` for agent deletion.
   - Move `SkillsPage` Write/Install/SourceAsk/Remove confirmation into `Sheet`s, rename `"Other"` to `"Installed"`, and link directly to **Preferences › Skills**.
   - Show full commit headers and a framed diff card in `ChangesPage`, file metadata headers in `MemoryPage`, search (`onQuery`) on Memory/Changes/Skills lists, and `divided` rows on multi-line lists (`Changes`, `Skills`).

## Verification

- `bun run format:check && bun run lint && bun run typecheck && bun run test && bun run test:node`
- `bun run build:app && bun run build:mod && bun run smoke`

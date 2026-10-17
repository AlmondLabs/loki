---
title: Model Picker by Harness - Plan
type: feat
date: 2026-10-17
topic: model-picker
execution: code
---

# Model Picker by Harness - Plan

## Goal

- **Objective:** Select model follows how the person thinks about the choice: first the **harness** a chat runs on
  (loki, Claude Code, any other ACP agent), then that harness's **model**, then the model's **effort** when it offers
  more than one level. The same three steps work for every harness, including Claude Code's effort levels.
- **Why now:** plan 020 put the ACP agents' models in the picker's flat list. loki's recent models and
  `acp:claude-code/…` handles sit side by side, More models files Claude Code under a provider heading called
  `acp:claude-code`, and an ACP chat has no effort control even though the Claude adapter offers one (its `Effort`
  config option, category `thought_level`, with levels that depend on the model).
- **Execution profile:** One branch per unit, each from `main` after the one before has merged, each its own PR with
  every check run on CI's toolchain.

## Decisions

All user-directed, 2026-10-17, in the brainstorm.

- **KD1. The harness is a row of tabs at the top of Select model.** `loki | Claude Code | …`, one tab per ACP agent
  in Settings › Engines. A tab shows that harness's models below it. (Chosen over a first page of harnesses, which
  costs a click every time, and over one list under harness headings.)
- **KD2. Effort is a row of levels under the model list,** shown only when the checked model offers more than one.
  It replaces the Effort › page. (Chosen over keeping the page and over levels on the model's row.)
- **KD3. The pill names the harness only when it is not loki.** A loki chat reads `Fable 5 · Medium`; a Claude Code
  chat reads `Claude Code · Sonnet 4.6 · Medium`. (Chosen over always naming it, and over a harness icon.)
- **KD4. A new chat starts on the agent's own model, as today.** Picking another harness's tab and a model before
  the first message moves the chat there. (Chosen over the last harness used anywhere, and over a per-agent default
  engine.)
- **KD5. Plan 020's lock holds.** After the first message the other harnesses' tabs stay visible but disabled, with
  the reason in their tooltip ("fixed once the chat has started; start a new chat to change"). Model and effort can
  still change within the chat's harness.

## Requirements

- R1. Select model opens on the chat's harness tab, with that harness's models below. loki's tab keeps its quick
  picks (recent, featured, the current model) and More models ›; an ACP agent's tab lists the models it offers.
- R2. Choosing a tab only shows that harness's models; the chat moves when a model is picked (KD4). Picking a
  harness's model before the first message moves the chat to that harness, as `chat_model` does today.
- R3. The effort row shows the checked model's levels in loki's words (`effortLabel`), and choosing one applies it
  to the chat and closes the picker, as picking a model does.
- R4. An ACP chat's effort is the agent's `thought_level` option. loki remembers each agent's levels per model (in
  `state/acp-offered.json`, beside its models), so the row shows them before the agent next runs. A model the agent
  has not reported levels for shows no row; levels outside loki's `ReasoningEffort` are left out.
- R5. The pill shows harness · model · effort per KD3, on the desktop and the phone.
- R6. The phone's sheet has the same three parts: tabs as a segmented control, the list, the effort row.
- R7. Keys: ←→ move between tabs when a tab has focus, ↑↓ move through the list and into the effort row, Enter
  picks, Esc closes. The tabs are a `tablist`; the effort row is a radio group.
- R8. Words on screen follow docs/style.md §6; the manual's model picker section describes the three steps.

## Scope Boundaries

- Not in scope: switching harness mid-chat (plan 020, KD4); a per-agent default engine (KD4); the effort of a
  background pass.
- Not changed: how loki's models are listed (list_models, recent, featured), the model handles (`acp:<agent>/<model>`),
  the mode chip.

## Mechanism

- **Harness of an entry.** A model entry's harness is read from its handle (`acp:<agent>/` or loki); a small
  `harnessOf(handle)` in `core/models.ts` and a `harnesses(entries, engines)` list (loki first, then each ACP agent
  in the Engines order) drive the tabs. `pickableEntries` becomes "which tabs are enabled" (KD5).
- **ACP efforts in the daemon.** `Offered` in `daemon/acp/chats.ts` gains `efforts: Record<model, string[]>`,
  filled from the session's `thought_level` option for its current model whenever config options arrive.
  `AcpChats.models()` emits one entry per known level (with `reasoning_effort`), the way loki's own presets are
  listed, so the picker's grouping needs no new case. `chat_model` with an ACP handle and a `reasoning_effort` sets
  the option on the open session, or keeps it on `ChatEngine` (gains `effort: string | null`) for the next session.
  `daemon/chats.ts` reports it as the chat's `reasoning_effort`, so the desk info and the pill read it as for loki.
- **The picker.** `ModelChoices` gains a harness state (initially the chat's), a `tablist` over the body, a filtered
  list, and an inline radio group for efforts in place of the Effort › page; `PickerView` loses `"effort"`.
  `ModelPill` takes the harness name. Phone and desktop share `ModelChoices` as today.

## Units

1. **ACP effort in the daemon** (`daemon/acp/chats.ts`, `daemon/kernel/index.ts`, `daemon/chat-backend.ts`,
   `daemon/chats.ts`, `test/fixtures/fake-acp.mjs`, tests): the fake agent offers a `thought_level` option that
   depends on its model; tests cover levels remembered per model, effort entries in `models()`, effort applied to an
   open session and carried to a new one, and the chat's info reporting it.
2. **The picker by harness** (`core/models.ts`, `app/src/chat/model-picker.tsx`, `chat.css`, `conversation.tsx`,
   phone, `docs/manual.md`, tests): tabs, the filtered list, the inline effort row, the pill, keys, the lock's
   tooltip. Screenshots of desktop and phone in the PR, light and dark.

## Verification

- Each unit's tests plus the full checks on CI's toolchain, Windows included; React Doctor no worse than `main`.
- By hand in the browser pane against a scratch daemon with the fake agent: switch harness before the first message,
  pick a model and an effort on each, send, see the other tab locked, change effort mid-chat; then once with the
  person's real Claude Code to see its levels arrive.

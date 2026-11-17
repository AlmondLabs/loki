---
title: One sentence of help in Preferences - Plan
type: fix
date: 2026-11-15
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
execution: code
---

# One sentence of help in Preferences - Plan

---

## Goal Capsule

- **Objective:** every grey note under a Preferences group, and every setting's own help, says one sentence, as System
  Settings' notes do, so a page reads at a glance.
- **Means:** rewrite the notes in `app/src/settings` that run to two sentences or more; no layout or behaviour changes.
- **Authority:** the Requirements, then the Key Technical Decisions.
- **Stop conditions.** Stop and ask if a cut would drop something the manual does not say.
- **Execution profile:** copy in `app/src/settings`; one PR.
- **Who finishes:** `ce-work` on branch `fix/settings-help-copy`.

---

## Product Contract

### Requirements

- R1. A group's note is one sentence: Lanes, Engines, Learn, Flow, Macs, Phone's Route, MCP servers, Labels, Skills,
  Providers, Accounts and Connect an Account.
- R2. A setting's help is one sentence: Flow's Read, Later, Later Brings a Card Back After, Archive, A Reply and Focus;
  the chat panel's Position; Phone's A New Phone; Gmail's own Google app; Jira's connect form.
- R3. Nothing a person needs to act on the page is lost: what is cut is already in `docs/manual.md`.

---

## Planning Contract

### Key Technical Decisions

- KTD1. **Keep what you act on, cut how it works.** Each note keeps what the group is for and the one fact that changes
  what you do there (Learn is off until you turn it on, a key stays in the keychain, plain http on Wi‑Fi, a Jira card
  done once read, which is why it has no Read Rests row). How long a rest lasts, the second Later asking when, and how
  chats reach another Mac stay in the manual, which already says each. (R1–R3)
- KTD2. **Phone's Route says what matters for the route chosen.** "Anyone on the lit route can open the page" went
  with the safety line into one sentence that differs for Tailscale and Wi‑Fi. (R1)

---

## Verification Contract

`npm run format:check && npm run lint && npm run typecheck && npm test && npm run test:node`, then
`npm run build:app && npm run build:mod && npm run smoke`. In the worktree's Vite: Preferences' pages show the new notes.

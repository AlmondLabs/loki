---
title: Fewer tools - Plan
type: refactor
date: 2026-11-11
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
execution: code
---

# Fewer tools - Plan

Plan 094 · follows plan 017 (U10, the file tools and the Skill tool), plan 049 (suggestions) and plan 067 (reply
proposals)

---

## Goal Capsule

- **Objective:** An agent on loki's own engine is offered fewer tools, none of which merely repeats another or tells
  the agent what its own conversation already says. Every turn costs fewer tokens, and the model has fewer near-twins to
  choose between.
- **Means:** nine tools leave the model's list: `image_view`, `ls`, `find`, `grep`, `skill`, `suggestion_list`,
  `suggestion_withdraw`, `reply_list` and `reply_withdraw`. What made the file tools worth having moves where it
  belongs: `read` shrinks pictures as `image_view` did, and the approval gate weighs a read-only shell command as a
  read.
- **Authority:** this plan's Requirements, then its KTDs. The person chose the nine tools on 2026-11-11, judged by what
  each does, not by how often it is called.
- **Stop conditions:** stop and ask if `read` cannot shrink pictures before they reach the store, or
  if a read-only command cannot be told from others without running it.
- **Execution profile:** one branch, one PR. The person raises and merges it.

---

## Product Contract

### Summary

Forty-one tools of loki's own become thirty-two. Pictures, folders, searches and skills are reached with `read` and
`bash`, which the agent already has. Suggestions and reply proposals are made as before, and the agent hears what
became of each as it does now; it no longer lists or takes them back.

### Problem Frame

Each tool's definition is sent with every turn, about 5,000 tokens for all of loki's. Some tools repeat another:
`read` already shows pictures, `bash` already lists, finds and searches, and a skill is a file `read` can open. Others
manage what the agent made itself: its suggestions and reply proposals are in its own conversation, the person acts on
each card, and a notice tells the agent the outcome. A model offered two ways to do one thing spends attention choosing.

### Requirements

- R1. `image_view` is gone. `read` of a PNG, JPEG, GIF or WebP file returns the picture shrunk as `image_view` shrank it
  (plan 029: over 300 KB, 1600 px on the long edge), so a store does not grow on whole pictures again.
- R2. `ls`, `find` and `grep` are no longer offered to the model. Scripts keep them, as script-only tools.
- R3. A `bash` command made only of read-only programs (`ls`, `find`, `rg`, `grep`, `cat`, `head`, `tail`, `wc`,
  `pwd`), perhaps piped one into the next, is weighed as a read: it runs without asking in the standard and
  acceptEdits modes, as `ls`, `find` and `grep` did. Anything the check cannot be sure of asks as a command.
- R4. `skill` is gone. The prompt's skills section says where each skill's `SKILL.md` is, by folder, and the agent
  reads it with `read`.
- R5. `suggestion_list`, `suggestion_withdraw`, `reply_list` and `reply_withdraw` are gone, from loki's engine and from
  ACP chats alike. The person still accepts, edits or rejects every card; an approved Jira comment still waiting in its
  card's box is removed by the person there.
- R6. Old chats keep showing their calls to the removed tools as they were.

### Scope Boundaries

- Not in scope: the background tools, the memory tools (reflection runs with only those), `account_*` against the
  Google script tools, a page-fetching tool. The person may take these up later.
- No change to how suggestions and reply proposals are made, shown or decided.

---

## Planning Contract

### Key Technical Decisions

- **KTD1. `read` gets loki's image processor.** pi-durable's coding tools take an `ImageProcessor` for the pictures
  `read` returns (`createCodingTools({ images })`); loki's runs `shrinkImage`'s `sips` steps on the bytes, converts a
  BMP to JPEG, and refuses what still does not fit. `read`'s definition stays pi-durable's. Before this, `read` passed
  a picture whole, so the store grew on it; now both ways in are shrunk.
- **KTD2. Read-only commands are recognised by a small, closed parser** (`daemon/read-only-command.ts`). The command is
  split into words with shell quoting; outside quotes any of `; & > < ` $ ( ) { } \` or a line break makes it a
  command. Each piped part must start with a listed program by its bare name, with none of the flags that make it write
  or run something: `find`'s `-exec`, `-execdir`, `-ok`, `-okdir`, `-delete` and `-fprint*`/`-fls`, and `rg`'s `--pre`.
  It errs toward asking: a false "command" costs a card, a false "read" would run something unasked.
- **KTD3. The file tools become script-only** (`callers: ["tools"]`), so scripts keep a sandboxed `ls`, `find` and
  `grep` and the script tool's rule that a script never starts a process holds. They are loki's own, so the registry's
  check that shows the script tool only beside a mod's script-only tool is unchanged.
- **KTD4. The skills section names folders, not each file.** Listing every skill's path would cost more than the tool
  it replaces; one line per root ("in `<dir>/<name>/SKILL.md`") does not.
- **KTD5. Old names stay in `RENAMED_TOOLS`.** `view_image` → `image_view` and `Skill` → `skill` record how saved
  history was renamed; the window draws those calls by name, so it keeps knowing `skill` and `image_view`.

### Verification

- Tests: `read` shrinks a picture and passes a text file through; the read-only command parser, both ways, quoting and
  flags included; the gate lets a read-only `bash` call run in standard mode and asks for `ls; rm x`; the extensions
  test's tool list; the skills section names folders; the removed tools are absent from loki's engine and ACP chats.
- By hand: in a standard-mode chat, `ls` and `rg` run without a card and `rm` asks; a skill is loaded with `read`; a
  picture is read and the store's copy is shrunk.

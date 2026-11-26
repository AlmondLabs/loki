# loki board: tasks for later, on beads — plan of record

Decided 2026-09-06 with Deepak. While talking to one agent he keeps needing to note work for
later — for this thread, another, or a new one — and loki had nowhere to put it. The answer is
a Jira-like board backed by **beads** (`bd` 1.0, embedded Dolt), one shared board for every
agent and folder, a `loki_task` tool for agents, and a Board segment in the app where tasks
are selected and assigned to a conversation.

## Decisions

- D1 **One shared board**: `~/.letta/loki/board/.beads` (prefix `lk`). Never per-repo: the
  conversations span many folders; the project is a label, not a database.
- D2 **Agents go through `loki_task`, never raw `bd`.** The Desktop harness does not carry
  our environment; the embedded Dolt engine wants a single writer; and the source stamp
  (agent, conversation, desk, folder) must be reliable. The mod runs `bd` with `BEADS_DIR`
  set and serialises calls.
- D3 **Assign ≠ dispatch.** Assign (⏎) is metadata: assignee = agent, `metadata.conversation`
  and `.desk` = the target; nothing is sent. The agent learns of it at the next turn in that
  thread through a `<loki-tasks>` block the mod attaches. Dispatch (⌘⏎) assigns *and* posts a
  message with the tasks; the agent starts now. The picker's button names which one you do.
- D4 Tasks are created only when asked: an agent addressed by the user calls the tool; the
  user presses "+" on the board or ⌘J anywhere. No mining of threads, no inbox-card path.
- D5 Every task carries the same stamp in `metadata`: `{ by: "agent" | "you", agent, agentId,
  conversation, desk, folder }` plus a project label derived from the folder's name.
- D6 Reads poll: `bd list --json` when the Board opens, after each mutation the mod makes,
  and every 20 s while the Board is showing. Dolt has no file to watch.

## Shape

    agent ── loki_task create/close/comment ──▶ mod/tasks.ts ── bd (BEADS_DIR) ──▶ board
    app   ── tasks_list / task_create / task_assign / task_close ──▶ mod ──▶ bd
    mod   ── turn_start: <loki-tasks> assigned to this conversation ──▶ agent

Board segment (⌘4):

    ┌──────────────────────────────────────────────────────────────────────────┐
    │ ● ● ●                          Board · 14 open                           │
    ├────┬─────────────────────────────────────────────────────────────────────┤
    │ ▣  │ open (9)              in progress (3)      blocked (1)   done (7d)  │
    │ ✉3 │ ┌──────────────────┐  ┌──────────────────┐ ┌──────────┐ ┌────────┐ │
    │ ▦  │ │▣ rotate SSO creds│  │ EICE trace       │ │ …        │ │ …      │ │
    │    │ │ ● friday · aws   │  │ ● friday · ssm   │ └──────────┘ └────────┘ │
    │    │ │ P1 · 2h          │  │ → FMOS-11309     │                         │
    │ ⚙  │ └──────────────────┘  └──────────────────┘  2 selected · ⏎ assign  │
    └────┴─────────────────────────────────────────────────────────────────────┘

Keys on the board: type to filter · ↑↓←→ move · X or click select · ⇧-click range · ⏎ assign
(picker: desks tree + new desk) · ⌘⏎ dispatch · D done · ⌫ close as won't do · + / ⌘J new task.

## Steps

1. `mod/tasks.ts`: `bd` wrapper (execFile, `BEADS_DIR`, serial queue, JSON), `create`,
   `list`, `assign`, `close`, `comment`; `formatTasksContext(tasks)` for turn_start. Tests.
2. `loki_task` in `mod/tools.ts`; turn_start block in `mod/mod.ts`; bridge frames.
3. App: `app/src/board/` (Board, TaskCard, AssignPicker, capture), rail icon, ⌘4, ⌘J,
   Settings row for the board path. `useDesk` requests for the frames.
4. Skill entry in `skills/loki/SKILL.md`; README section.

## Not doing

- Dependencies, epics, gates, swarms: beads has them; the board hides them until needed.
- Sync of the board across machines (Dolt remotes) — personal, one Mac.
- Notifications when an agent closes a task; the normal turn-finished card already lands.

# Glossary

The words loki's code and docs use for its own concepts. The UI's words come first; where the code keeps an older
name, it is given. `docs/architecture.md` explains how these fit together.

**Chat**: one conversation with an agent, as loki shows it. The code and the mod's wire protocol call it a _desk_.
Its id keeps the form Letta used (`local-conv-…`, or `default` for an agent's main chat), so chats imported from
Letta keep theirs.

**Thread**: a chat's rows in order: your messages, the agent's, tool steps and quiet harness events. The `Thread`
component draws it; the ThreadModel builds it.

**ThreadModel** (`core/attention/thread.ts`): the one module that builds a chat's thread. It folds steps into rows,
attaches tool results and approval requests to their calls, shows your own message the moment you send it, and
reconciles a loaded history page with the live tail. Every chat surface reads its rows from here. _Avoid_:
transcript converter, toTranscript.

**Step**: one thing the harness reports, in a neutral shape the ThreadModel folds: a user message (raw, harness markup
included), assistant text (a whole message or one streamed chunk), a tool call, an approval request, or a tool
result. Steps are what cross from a source adapter into the ThreadModel.

**Source**: where steps come from. There are two, each with an adapter that only parses its own dialect into
steps:

1. **Stored entries**: the chat's pi-durable entries, read into steps by `entrySteps` (`core/attention/pi-steps.ts`)
   in the daemon's ChatProjection and served as history pages. The primary history, because it keeps turns that
   compaction has dropped from the agent's context.
2. **Stream**: the daemon's live `chat_event` pushes (`daemon/chat-events.ts`).

Letta's old `messages.jsonl` logs are read only by the import, and by its check (`daemon/import/letta-log.ts`).

**Tail**: the rows that streamed in since the last history page was loaded.

**Handoff**: what happens when a history page arrives. Tail rows that the page already contains (a call by its id,
other rows by role and text from the end) lend it their arrival times and go. Of the rest, a row stays after the page
only if it is still pending (queued, a running slash command, the streaming reply) or arrived after the page's newest
row, so nothing that streamed during the load is lost and nothing the harness never echoes lingers.

**Open call**: a tool call with no result yet and no text after it, among the live rows or at the end of the last
history page. An approval request for the same tool attaches to it instead of adding a row.

**Frame**: one message on the mod's socket (`/ws`), the only protocol loki's clients speak, chats included. Three kinds:

1. **Request**: the app asks and waits; it carries a `requestId` and is answered by exactly one reply frame or one
   `error` frame.
2. **Send**: the app tells the mod something and does not wait; any effect comes back as a push (a mark → `seen`).
3. **Push**: the mod tells the app or every socket something unasked (`desk`, `widgets`, `recall_changed`).

**Frame table** (`core/frames.ts`, `FRAMES`): every frame declared once — its kind, its reply, whether a paired
phone may send it, and the parser that turns the raw object into a typed payload. The mod's router, the app's
`request()`, the phone allow-list and the protocol's documentation all read it. _Avoid_: REPLY_FRAMES,
PHONE_FRAMES (now derived from it).

**Frame handler**: the mod module for one feature (Learn, the board, agents, folders, the phone listener, …) that
answers that feature's frames; a request handler returns its reply or an error, and the router sends it.

**Chat event** (`core/attention/model.ts`, `ChatEvent`): what happens in a chat while it runs, in loki's own words:
an approval or question, the chat's mode and folder, running or idle, a step, an error, a slash command, the reply
settling, the turn ending. loki's daemon pushes them (`chat_event`), and the app's chat client (`FrameChatClient`) hands them to the attention
model.

**Daemon** (`daemon/main.ts`): loki's one long-running Node process, started and restarted by the shell. It holds
every agent's chats, the tools, approvals, memory, reflection and the mods. _Avoid_: harness (for the process),
app-server, server.

**Agent store** (`daemon/kernel/`): one agent's chats in one pi-durable Harness over one SQLite file,
`~/.loki/stores/<agentId>.sqlite`. Only `daemon/kernel/` imports pi-durable.

**ChatProjection** (`daemon/chats.ts`): the daemon's synchronous view of every chat, its details and its entries as
steps, kept current from each store's commits. The mod reads chats through it (`mod/chat-source.ts`), because it
needs answers at once and pi-durable answers asynchronously.

**Mod**: code that extends every chat through loki's mod API (`daemon/mods/api.ts`, version 1): tools, prompt
sections, a say before a tool runs, a transform of your message, turn events. loki's own mod is `mod/index.ts`;
others are files in `~/.loki/mods`. Letta mods do not load.

**Permission mode**: which tool calls ask you first, per chat. On loki's daemon (`daemon/approvals.ts`):

| Mode | Asks before |
|---|---|
| strict | every tool, reads included |
| standard | edits and commands; reads run freely |
| acceptEdits | commands; edits and reads run freely |
| unrestricted | nothing (the default) |

Reads are `read`, `grep`, `find`, `ls`, `view_image`, `desk_state`, `loki_camera`, `web_search`, `Skill`,
`TaskOutput`, `Monitor`, `schedule_list` and a mod's
tools marked read-only; the memory tools and `Agent` (a helper, whose own calls are asked about) count as reads too.
Edits are `write` and `edit`; anything else is a command. An edit inside loki's widget folder never asks,
and a question card (`AskUserQuestion`) is never a permission.

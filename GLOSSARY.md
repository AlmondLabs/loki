# Glossary

The words loki's code and docs use for its own concepts. The UI's words come first; where the code keeps an older
name, it is given. `docs/architecture.md` explains how these fit together.

**Chat**: one Letta conversation as loki shows it. The code and the mod's wire protocol call it a _desk_.

**Thread**: a chat's rows in order: your messages, the agent's, tool steps and quiet harness events. The `Thread`
component draws it; the ThreadModel builds it.

**ThreadModel** (`core/attention/thread.ts`): the one module that builds a chat's thread. It folds steps into rows,
attaches tool results and approval requests to their calls, shows your own message the moment you send it, and
reconciles a loaded history page with the live tail. Every chat surface reads its rows from here. _Avoid_:
transcript converter, toTranscript.

**Step**: one thing Letta reports, in a neutral shape the ThreadModel folds: a user message (raw, harness markup
included), assistant text (a whole message or one streamed chunk), a tool call, an approval request, or a tool
result. Steps are what cross from a source adapter into the ThreadModel.

**Source**: where steps come from. There are three, each with an adapter that only parses its own dialect into
steps:

1. **Local log**: the local backend's `messages.jsonl`, read by the mod. The primary history, because it keeps turns
   that compaction has dropped from the agent's context.
2. **App-server history**: `conversation_messages_list`; the fallback when the mod has no log (cloud mode).
3. **Stream**: the app-server's live `stream_delta` events.

**Tail**: the rows that streamed in since the last history page was loaded.

**Handoff**: what happens when a history page arrives. Tail rows that the page already contains (a call by its id,
other rows by role and text from the end) lend it their arrival times and go. Of the rest, a row stays after the page
only if it is still pending (queued, a running slash command, the streaming reply) or arrived after the page's newest
row, so nothing that streamed during the load is lost and nothing Letta never echoes lingers.

**Open call**: a tool call with no result yet and no text after it, among the live rows or at the end of the last
history page. An approval request for the same tool attaches to it instead of adding a row.

**Frame**: one message on the mod's own socket (`/ws`), as opposed to Letta's app-server protocol. Three kinds:

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
settling, the turn ending. loki's daemon pushes them (`chat_event`); Letta's app-server events are read into them.

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

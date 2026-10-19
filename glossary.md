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

Chats imported from Letta keep its off-path replies as `loki.branch` entries: shown in the thread, never sent to the model.

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
phone may send it, its **peer meaning** (how it crosses to another paired Mac: routed by the chat, desk or home it
names, whether it re-reads that Mac's chats, how long it may take; for a push, whether it is relayed and whether it
changes the lists), and the parser that turns the raw object into a typed payload. The mod's router, the chat
router, the remote chats, the app's `request()`, the phone and peer allow-lists and the protocol's documentation all
read it. _Avoid_: REPLY_FRAMES, PHONE_FRAMES, PEER_FRAMES as hand-kept lists (all derived from it), a string set of
frame names kept beside it.

**Frame handler**: the mod module for one feature (Learn, Tasks, agents, folders, the phone listener, …) that
answers that feature's frames; a request handler returns its reply or an error, and the router sends it.

**Chat event** (`core/attention/model.ts`, `ChatEvent`): what happens in a chat while it runs, in loki's own words:
an approval or question, the chat's mode and folder, running or idle, a step, an error, a slash command, the reply
settling, the turn ending. loki's daemon pushes them (`chat_event`), and the app's chat client (`FrameChatClient`) hands them to the attention
model.

**Daemon** (`daemon/main.ts`): loki's one long-running Node process, started and restarted by the shell. It holds
every agent's chats, the tools, approvals, memory, the background passes and the mods. _Avoid_: harness (for the process),
app-server, server.

**Engine** (`ChatInfo.engine`, plan 020): what a chat runs on. loki's own engine is pi-durable with a provider's
model; an **ACP agent** (`daemon/acp/`) is a program loki starts and talks to over the Agent Client Protocol, such
as Claude Code. Chosen in the model picker before a chat's first message, fixed after it. The agent the chat
belongs to (its name, memory, Tasks) stays the same either way. _Avoid_: backend, harness (both taken).

**Background pass** (`daemon/passes.ts`): a job the daemon runs on a chat once it has been quiet for half an hour
and holds new material past the job's cursor, as the agent in that job's hidden chat, one run at a time. There are
two: reflection, which keeps the agent's memory, and Learn, which writes the person's cards. Same process, different
objectives. _Avoid_: worker, sweep (the mod's Learn worker and its timer before plan 018).

**Agent store** (`daemon/kernel/`): one agent's chats in one pi-durable Harness over one SQLite file,
`~/.loki/stores/<agentId>.sqlite`. Only `daemon/kernel/` imports pi-durable.

**ChatProjection** (`daemon/chats.ts`): the daemon's synchronous view of every chat, its details and its entries as
steps, kept current from each store's commits. The mod reads chats through it (`mod/chat-source.ts`), because it
needs answers at once and pi-durable answers asynchronously.

**Label** (`ChatInfo.labels`, plan 022): a topic word the person puts on a chat (`infra`, `client-x`) to gather
related chats across agents: lowercase letters, digits and dashes, up to eight a chat, each with a colour from an
eight-colour palette (`state/labels.json`). Only the person sets them; the agent is told them. _Avoid_: tag (the
agents' own `tags`), category, folder (a chat's working directory).

**Paired Mac** (`mod/peers.ts`, plan 023): another of the person's Macs running loki, paired with a code over the
tailnet. Named by its install id (`state/device-id`). _Avoid_: peer in UI copy; the code says peer.

**Home** (`home_mac` on an agent record, `home` on a chat row): the Mac an agent lives on, where its new chats start
and where its chats go when it moves; and the one Mac a chat lives on, which alone writes it, runs its tools and reads
it for reflection and Learn. Other Macs reach a chat through its home. A chat is a single-writer actor at its home:
frames are its messages, and the peer link carries them one hop.

**Chat directory** (`mod/chat-directory.ts`, plan 023 addendum B): where each chat lives, as this Mac knows it. Its own
chats from its store, and each paired Mac's word about its own: the chats that Mac lists, and its `chat_left` push
when one moves away. A chat it does not know is asked of the paired Macs in reach. A Mac that let a chat go keeps a
forwarding note and answers a stale frame with a redirect. Addresses only: what the lists show is the remote chats'
job. _Avoid_: inferring a chat's home from a list row.

**Placed** (`placed` in a chat's info, addendum A2): a chat put on a Mac on purpose (moved by hand, or started away
from its agent's home); the hand-over of an agent's chats to its home leaves it there.

**Group** and **invite** (`mod/peer-group.ts`, plan 023 addendum D): every paired Mac paired with every other. A
Mac paired with two Macs introduces them; the Mac being joined mints an invite (single use, for that Mac only, two
minutes) and the joining Mac pairs with it directly. _Avoid_: transitive pairing (frames never go through a Mac).

**Peer link** (`mod/peer-link.ts`): one Mac's socket to a paired Mac's `/ws`, over which it asks (requests by
`request_id`) and hears (that Mac's pushes); a paired Mac's frames are limited to `PEER_FRAMES`.

**Conflicts note** (`conflicts/sync.md` in an agent's memory, `daemon/memory-sync.ts`): the other side of each clash
when two Macs changed the same lines of a memory note apart; the note keeps the home's text, and reflection folds
this in.

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

Each of loki's tools declares its kind (`daemon/tool-kinds.ts`). Reads are `read`, `grep`, `find`, `ls`, `view_image`,
`desk_state`, `desk_camera`, `web_search`, `skill`, `background_output`, `background_watch`, `schedule_list`, and a
mod's or an MCP server's tools marked read-only; the memory tools and `subagent` (a helper, whose own calls are asked
about) count as reads too. Edits are `write` and `edit`; anything else is a command. An edit inside loki's widget
folder never asks, and a question card (`ask_user`) is never a permission.

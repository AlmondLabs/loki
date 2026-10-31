# Glossary

The words loki's code and docs use for its own concepts. The UI's words come first; where the code keeps an older
name, it is given. `docs/architecture.md` explains how these fit together.

**Chat**: one conversation with an agent, as loki shows it. The code and the mod's wire protocol call it a _desk_.
Its id is `local-conv-…`, or `default` for an agent's main chat, and stays the same for the chat's life.

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

A `loki.branch` entry holds a reply off the chat's main path: shown in the thread, never sent to the model.

**Tail**: the rows that streamed in since the last history page was loaded.

**Handoff**: what happens when a history page arrives. Tail rows that the page already contains (a call by its id,
other rows by role and text from the end) lend it their arrival times and go. Of the rest, a row stays after the page
only if it is still pending (queued, a running slash command, the streaming reply) or arrived after the page's newest
row, so nothing that streamed during the load is lost and nothing the harness never echoes lingers.

**Open call**: a tool call with no result yet and no text after it, among the live rows or at the end of the last
history page. An approval request for the same tool attaches to it instead of adding a row.

**Frame**: one message on the mod's socket (`/ws`), the only protocol loki's clients speak, chats included. Three kinds:

1. **Request**: the app asks and waits; it carries a `request_id` and is answered by exactly one reply frame or one
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

**Frame handler**: the mod module for one feature (Learn, suggestions, agents, folders, the phone listener, …) that
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
belongs to (its name, memory, skills) stays the same either way. In the daemon each is an adapter behind one
interface (`Engine`, `daemon/engine.ts`): `LokiEngine` and `AcpEngine`. _Avoid_: backend, harness (both taken).

**Background pass** (`daemon/passes.ts`): a job the daemon runs on a batch of one agent's due chats, as the agent in
that job's hidden chat, one run at a time. A chat is due once it has been quiet for half an hour (or, for reflection,
just compacted) and holds new material past the job's cursor. A batch reads up to 80k characters (`MAX_BATCH_CHARS`),
and an agent's batches for a job are at least two hours apart (`BATCH_EVERY_MS`) unless a chat was compacted or the
last batch left some for later. There are two: reflection, which keeps the agent's memory, and Learn, which writes
the person's cards. Same process, different objectives. _Avoid_: worker, sweep (the mod's Learn worker and its timer
before plan 018).

**Pass chat**: a pass's hidden chat for one agent, cleared before each run: `reflection-<agent>` or `recall-<agent>`
(Learn's writer), and `doctor-<agent>` for a memory review. On an ACP agent (plan 061) it is the same id with `-acp`
after it (`ACP_PASS_SUFFIX`, `daemon/memory.ts`), so the prefix still names the job. It stays out of the chat list,
the inbox and the passes themselves.

**Agent store** (`daemon/kernel/`): one agent's chats in one pi-durable Harness over one SQLite file,
`~/.loki/stores/<agentId>.sqlite`. Only `daemon/kernel/` opens the Harness and the stores; other daemon modules use
pi-durable's extension and tool API.

**ChatProjection** (`daemon/chats.ts`): the daemon's synchronous view of every chat, its details and its entries as
steps, kept current from each store's commits. The mod reads chats through it (`mod/chat-source.ts`), because it
needs answers at once and pi-durable answers asynchronously.

**Label** (`ChatInfo.labels`, plan 022): a topic word the person puts on a chat (`infra`, `client-x`) to gather
related chats across agents: lowercase letters, digits and dashes, up to eight a chat, each with a colour from an
eight-colour palette (`state/labels.json`). Only the person sets them; the agent is told them. _Avoid_: tag (the
agents' own `tags`), category, folder (a chat's working directory).

**Purpose line** (`ChatInfo.purpose`, plan 049): one line the person writes on a chat, in its Rename dialog or
sheet, saying what the chat is for. It shows under the chat's name in its header, and agents read it through
`chat_list` to pick the chat a piece of work fits; only the person writes it. _Avoid_: description (an agent's own),
topic.

**Suggestion** (`mod/suggestions.ts`, plan 049): a message an agent writes for another chat, an open one of any agent
or a new one for an agent in a folder, made with `suggestion_create` whenever another chat fits the work better. It
is kept on the record of the chat it was made in, on that chat's home, and shows in that chat's screen, outside the
thread, until the person acts: **send now** (it goes as the person's message, with a link back), **save as draft**
(a **saved draft** in the target chat's message box, under anything typed there), **change chat**, or **reject**.
The home carries out every action, and the first one wins. Agents never send one. Suggestions replaced Tasks, the
beads-backed task list, in October 2026. _Avoid_: task, proposal, recommendation.

**History tools** (`daemon/history-tools.ts`, plans 062 and 063): `history_search` and `history_read`, which let an
agent find and read the turns of its own chat that a compaction summarized away. They read the ChatProjection, and
number rows as the thread does. ACP chats have them too.

**Canvas** and **widget** (`mod/widgets-fs.ts`): the canvas is the space beside a chat where its widgets sit, plus a
shared canvas every chat sees. A widget is one file under `~/.loki/widgets/<desk>/` (`shared/` for the shared one):
a kit widget is `<name>.json` (`type`, `title`, `data`) drawn by loki's kit, a custom one is `<name>.tsx`, a React
component. The agent writes the files and reads them back with `canvas_read`. _Avoid_: desk (for the canvas; the
code's desk is the chat).

**Inbox** (`app/src/desk/catch-up.tsx`; Catch Up in older code): the chats that wait on you, one card at a time,
highest score first (`core/attention/priority.ts`). Next reads a card and moves on (it rests, see Rest); archive is
done.

**Chat listing** (`mod/chat-listing.ts`): the one module that decides which of this Mac's chats show in the chat
list and the inbox, and builds each row. _Avoid_: a second filter over the chats anywhere else.

**Rest** (`core/attention/rest.ts`, plan 026): how long an Inbox card stays out after Next. A card with nothing new
rests longer each Next in a row (its **rung**), a card with something new ten minutes; anything new in the chat ends
it. _Avoid_: snooze, later (the removed key that did this by hand).

**Card**, **lead**, **lesson** and **writer** (Learn, `docs/learn.md`; "recall" in the code): a card is a question
and answer asked back on a spaced-repetition schedule; a lead is a concept that went by without being understood;
a lesson is the `[Learn]` chat a lead starts, taught by the agent that was there. The writer is Learn's background
pass, which reads quiet chats and writes cards and leads. _Avoid_: worker (its name before plan 018).

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

**Syncer** (`mod/peer-sync.ts`): one kind of thing kept current with the paired Macs (agents, memory, moves, tasks,
state, group, directory; `mod/peering.ts`), where `tasks` moves a Mac's old tasks into suggestions, with what wakes
it (a Mac coming into reach, a push by name) and the syncer it waits for.
_Avoid_: wiring a new trigger into the link's callbacks.

**Peer link** (`mod/peer-link.ts`): one Mac's socket to a paired Mac's `/ws`, over which it asks (requests by
`request_id`) and hears (that Mac's pushes); a paired Mac's frames are limited to `PEER_FRAMES`.

**Conflicts note** (`conflicts/sync.md` in an agent's memory, `daemon/memory-sync.ts`): the other side of each clash
when two Macs changed the same lines of a memory note apart; the note keeps the home's text, and reflection folds
this in.

**Mod**: code that extends every chat through loki's mod API (`daemon/mods/api.ts`, version 1): tools, prompt
sections, a say before a tool runs, a transform of your message, turn events. loki's own mod is `mod/index.ts`;
others are files in `~/.loki/mods`.

**Permission mode**: which tool calls ask you first, per chat. On loki's daemon (`daemon/approvals.ts`):

| Mode | Asks before |
|---|---|
| strict | every tool, reads included |
| standard | edits and commands; reads run freely |
| acceptEdits | commands; edits and reads run freely |
| unrestricted | nothing (the default) |

Each of loki's tools declares its kind on its own definition (`withKind`, or `kind` on a `ChatTool`); a mod's tool
or an MCP server's says so with a `readOnly` annotation, and `daemon/tool-kinds.ts` names only pi-durable's coding
tools, which loki cannot annotate. A tool that says nothing is a command. Reads are `read`, `grep`, `find`, `ls`,
`image_view`, `canvas_read`, `canvas_focus`, `web_search`, `skill`, `background_output`, `background_watch`,
`schedule_list`, `history_search`, `history_read`, `user_ask`, `mcp_search`, and a mod's or an MCP server's tools
marked read-only; the memory tools and `subagent` (a helper, whose own calls are asked about) count as reads too.
Edits are `write` and `edit`; anything else is a command. An edit inside loki's widget folder never asks, and
`user_ask`, `chat_list` and the suggestion tools never ask in any mode (`NEVER_ASK`): a question card is not a
permission, and what you do with a suggestion is already your decision.

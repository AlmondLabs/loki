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

**Open call**: a tool call with no result yet and no text after it. An approval request for the same tool attaches
to it instead of adding a row.

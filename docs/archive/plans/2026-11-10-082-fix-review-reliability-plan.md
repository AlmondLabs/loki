# Plan 082: reliability from the November review

2026-11-10

## Why

The same read of the codebase that led to plan 081 found places where work is lost or a chat gets stuck: a chat that
reads as busy for good, a message that vanishes during a move, an Inbox that says "all caught up" when the list never
came. This plan covers those. None changes what a control does; each makes a failure visible or recoverable.

## What changes

1. **A chat on an ACP agent never stays busy after a failed write.** The turn's first store write sits inside the
   turn's `try`, so a write the store refuses ends the turn like any other failure (`daemon/acp/chats.ts`).
2. **An agent that is removed takes its schedules and background tasks with it.** `Schedules.cancelAgent` and
   `BackgroundTasks.stopAgent`, called from `removeAgent`: a schedule that fired later opened a new, empty store.
3. **Background tasks end with the daemon.** `BackgroundTasks.killAll` at the process's exit ends every task's group at
   once, also one that ignored the stop's SIGTERM. A daemon that is killed outright still leaves its tasks behind.
4. **A chat is held from the moment its copy starts.** `ChatMoves.export` sets the hold before it copies the log, and
   lets go when the chat turns out busy or gone.
5. **A request is answered when its socket closes.** `RequestWaiters` (`app/src/desk/request-waiters.ts`) knows which
   socket each request went out on; a close answers those with an error at once instead of after each one's timeout.
6. **An Inbox list that did not come is not an empty Inbox.** `listInbox` answers null, the store keeps what it shows
   and asks again in 5 seconds (`LIST_RETRY_MS`).
7. **A failed decision or answer puts its card back; a failed send says so.** The approval and question cards return
   when the request rejects as well as when the daemon refuses, and a send that fails sets the chat's error line.
8. **A mail reply's id is made without `crypto.randomUUID`.** `newId` (`app/src/shared/new-id.ts`) uses
   `getRandomValues`, which a phone on plain http has.
9. **A thread that was read is read again after a reconnect.** `FrameChatClient.onReopened`; the store reads every
   thread it has read before, so rows that settled while the socket was down show without leaving the chat.
10. **The shell says when the daemon keeps stopping, and rotates its log.** Three exits in a minute set the daemon's
    error until it has run a minute (`crash_loop_note`); `daemon.log` past 10 MB becomes `daemon.log.1` before a start
    (`rotate_log`).

## Not in this plan

1. A held mail reply whose send fails after its card stopped waiting is still only logged: showing it as "not sent"
   needs a state on the card and a decision about retrying.
2. A stable release that fails after it is published still cannot be run again: that needs a draft-then-publish
   release path.
3. A chat move whose last step fails can still leave the chat on two Macs until the next contact: that needs the move's
   state kept on disk with a revision check.
4. One socket for the page's life, which would remove the reopen on every chat switch.

## Tests

`acp-chats`, `background-schedule`, `chat-backend`, `chat-moves`, `chat-store`, `request-waiters`, `new-id`, and the
shell's `harness` tests.

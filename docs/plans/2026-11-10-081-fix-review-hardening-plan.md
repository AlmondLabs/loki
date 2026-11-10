# Plan 081: hardening from the November review

2026-11-10

## Why

A read of the whole codebase on 2026-11-10 found places where what loki promises and what the code does differ. This
plan covers the ones that touch trust: who can pair, what can send or move mail, what a stranger's mail can do to the
daemon, and what the release build exposes. Reliability and speed findings from the same review are not in it.

## What changes

1. **A Mac's pairing code pairs one Mac.** `PairingCodes.spend` takes the code out with its first use; `Peers.accept`
   uses it. A phone's code still works more than once inside its ten minutes, as a Home Screen web app needs.
2. **"Over the tailnet" means this Mac's tailnet address.** `requestVia` takes the Mac's tailnet address from the
   Tailscale reader; a `100.x` caller counts only when it reached that address. A Wi-Fi that hands out `100.x`
   addresses is the Wi-Fi.
3. **The outbox sends only what the daemon held.** Each held reply is written with an HMAC made with a key from the
   keychain (`outboxKey`); `resume` drops an entry whose seal does not hold. Without a keychain nothing is sent after a
   restart.
4. **No move or undo trashes mail.** `NEVER_MOVED` in `mod/gmail-sync.ts` (TRASH, SPAM, SENT, DRAFT, CHAT) is left out
   of a picked label and of the change an undo carries.
5. **Mail's HTML is read in one pass.** `shownHtml` in `core/mail-text.ts` replaces three patterns that took minutes on
   a few hundred kilobytes of openers that never close.
6. **Recipients are written out again.** One escape-aware splitter (`splitMailboxes`, `core/mail-header.ts`) for every
   address header; `rfc2822` writes each To, Cc and Bcc entry from its parsed name and address, quoted or encoded, so a
   display name cannot add a recipient.
7. **The release build.** The jobs that run `npm ci` check out without credentials, and the Apple secrets leave the
   environment after the build step.
8. **The mail frame sends no referrer.** `mailDocument` sets `no-referrer` and takes out a mail's own referrer rules.

## Left for a decision

The review also questioned two choices the glossary records as deliberate, so they are unchanged: an MCP server's own
read-only hint decides whether its tool asks, and the memory tools count as reads.

## Tests

Each change has a test that fails without it: `pairing`, `peer-invites`, `lan`, `mail-reply`, `gmail-sync`,
`mail-text`, `mail-html` and `workflows`.

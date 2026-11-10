# Plan 082: mention people in Slack and mail replies

2026-11-10

## Why

The person wants to mention people from the Inbox's reply box, on Slack cards and mail cards, as they do in Slack and
Gmail.

## What

1. **The list.** Typing `@` and at least one letter in a reply box shows up to 8 (Slack) or 6 (mail) people who
   match, above the box. ↑ and ↓ move, Enter or Tab takes one, and Esc puts the list away until another `@` is typed.
   While the list shows, Enter picks and does not send.
2. **Slack.** The list is the workspace's people (not bots, not people who left), by handle and shown name. A pick
   writes `@handle `. When the reply is sent, the account's Mac turns each `@handle` of someone in the workspace into
   Slack's mention (`<@U123>`), so Slack notifies them. A handle that names no one, or people who could not be read,
   leaves the words as typed and the reply still goes.
3. **Mail.** The list is the people the account has mail with (plan 076's suggestions). A pick writes `@Name ` and
   adds the person to To when they are not already on the reply, as Gmail does.
4. **The phone** gets the same list in its reply box.

Also in this branch: the desktop Inbox now hands a card its reacting and emoji search (plan 079). It handed the card
only its reader, so the react button and pill presses never showed.

## Decisions

1. **The handle is what the box holds.** The box is plain text, held by the deck on the desktop, so a pick writes a
   word that reads as itself and that the Mac can resolve on its own: no hidden map travels with the text, and a handle
   typed by hand works too. The cost is that the box shows `@ravi.kumar` rather than "Ravi Kumar".
2. **People are read when a reply first asks**, all pages at once (up to 10,000), and kept for an hour per workspace.
3. **Mail mentions stay text.** The mail goes as `@Name` in its words; the person is on To, which is what notifies
   them.

## How

1. `core/frame-types.ts`: `SlackPerson`. `core/frames.ts`: `account_people_search` → `account_people`, by home, phone
   allowed.
2. `mod/slack.ts`: `users.list` (`usersList`); `postReply` takes `mentions` (handle → id) and applies them after
   escaping. `mod/slack-people.ts`: `SlackPeople` (read, keep, search), `withMentions`, `searchPeople`.
3. `mod/outside-threads.ts`: a Slack reply carries the workspace's handles; `searchPeople`. `mod/index.ts` wires it.
4. Client: `searchPeople` through chat-client, chat-store and use-attention; `threadSourceOf` passes it, with
   reacting, to the card.
5. `app/src/desk/mentions.tsx`: `useMentions`, `mentionAt`, `insertMention`. `OutsideReply` draws the list on the
   desktop and the phone.
6. `docs/manual.md`: the Mention people paragraph.

## Tests

1. `test/slack-people.test.ts`: handles to mentions, punctuation and email addresses; ranking; pages read once, bots
   left out, read again after an hour; no read for a reply without a handle; a failed read retried.
2. `test/slack.test.ts`: `usersList`; a reply's known handles become mentions, the rest escaped.
3. `test/outside-threads.test.ts`: a reply carries the handles; people who cannot be read leave the text; mail refused.
4. `test/mentions.test.ts`: the `@` being typed; a pick's text and caret.
5. `test/slack-view.test.ts`: the card's source carries reacting, emoji search and people search.
6. `test/frames.test.ts`: the new frame in the phone and home lists.

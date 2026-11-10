# Plan 080: Slack files on Inbox cards

2026-11-09

## Why

loki read a Slack message's words, its formatting and what an app attached, but never its `files`. A message that is
only an upload (an invoice, a screenshot) has no words, so its card drew an empty row and its header an empty line.
Mail already lists its files as chips (plan 078).

## What

1. **Chips.** Each file shared in a Slack message shows under it as a chip: its title, the kind Slack names it ("PDF")
   and its size. Pressing it opens the file's page in Slack, which holds the bytes; loki downloads nothing.
2. **Gone files.** A file deleted since, or hidden by the workspace's plan, shows a chip that says so and opens nothing.
3. **Plain text.** A message's plain text gains a `file: <name>` line per file, so the phone, a hand-off and the card's
   header name a message of only a file.

4. **Picture previews.** A shared picture draws as itself, fitted into 360 by 240 pixels, with its name under it;
   pressing it opens it in Slack. Slack serves a thumbnail only to a signed-in session, so the account's Mac fetches
   Slack's 360-pixel thumbnail once, as the person, and saves it in the folder a message's pictures use (plan 029).
   Every window, the phone's browser and a paired Mac then load it by name the way they load those pictures. A
   thumbnail that cannot be had leaves the file a chip.

### Decisions

1. **Fetch while reading the card, not when the picture is asked for.** The first read of a card with new pictures
   waits for their thumbnails (tens of kilobytes each, fetched side by side); later reads find them on disk. Fetching on
   request would keep the first read quick but needs a name-to-address table on the account's Mac and a way for a
   paired Mac's request to reach it.
2. **Named by account and address, not bytes.** A card read again finds its thumbnails without asking Slack. Slack
   never changes a thumbnail at an address, so the name still stands for one picture.
3. **The session goes only to files.slack.com.** Any other address is never asked, and a refusal never marks the
   account signed out. A thumbnail over 1 MB is not kept.
4. **Disk, not memory.** Thumbnails stay in `~/.loki/chat-images/` like a chat's pictures (about 20 to 60 KB each)
   and nothing is held in memory but their names. Nothing clears the folder yet; that is a trade to watch.

## How

1. `core/frame-types.ts`: `SlackFile {name, kind, size, link, gone?}` and `OutsideMessage.slack_files`.
2. `mod/slack-markup.ts`: `slackFiles(m)` reads `raw.files`; `readSlackMessage` returns them and adds them to `text`.
3. `mod/slack-view.ts` and `mod/outside-threads.ts` carry `slack_files` to the card; `mod/slack-sync.ts` names the
   files in a card's lines.
4. `app/src/desk/slack-thread.tsx`: `SlackFiles` draws the chips and `SlackPreview` the pictures; only an
   `https://` page opens.
5. `mod/slack.ts`: `fileThumb(url)` fetches a thumbnail with the session. `mod/slack-previews.ts`: `SlackPreviews`
   saves it under its name once; `mod/index.ts` gives it to the card's reader.
6. `docs/manual.md`: the Files sentence.

## Tests

1. `test/slack-markup.test.ts`: files read with title, kind, size and page; deleted and hidden ones; the plain text.
2. `test/slack-view.test.ts`: the card reads files; the chips and their facts; a deleted file.
3. `test/slack-sync.test.ts`: a message of only a file names it on its card.
4. `test/slack.test.ts`: a thumbnail is fetched with the session from files.slack.com only; a refusal or a page that
   is not a picture is none, and the account stays connected.
5. `test/slack-previews.test.ts`: fetched once and saved; found on disk after a restart; two reads ask once; a failure
   leaves nothing; two workspaces keep two files.
6. `test/slack-markup.test.ts` and `test/slack-view.test.ts`: a picture's thumbnail is read, asked for and drawn at
   its fitted size.

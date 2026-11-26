# Plan 079: emoji reactions on a Slack card

2026-11-09

## Why

The person wants to tell a sender "seen it" without writing a reply: a reaction, as in Slack. A Slack card showed
no reactions and could add none.

## What the person decided

1. **Any message.** A react button shows on the row under the pointer; ⌘⇧\, Slack's own key, opens the picker on the
   card's main message: the newest that brought the card, else its newest message.
2. **The card stays.** A reaction moves nothing on the card: read, later and archive are still the person's.
3. **Picker.** Five quick choices on 1 to 5 (👀 ✅ 👍 🙏 🙌) and a search over every emoji, the workspace's own included.
4. **Show them.** Each message shows its reactions as pills with counts, the person's own outlined; pressing one adds or
   takes back theirs.

## How

1. `mod/slack.ts`: `reactions.add` and `reactions.remove` join `SLACK_METHODS`; `react()` treats `already_reacted` and
   `no_reaction` as done.
2. `mod/slack-markup.ts`: `reactionEmoji()` reads a reaction's name (skin tone after `::`); `searchEmoji()` ranks the
   standard and workspace names by a whole match, a start, a word's start, then anywhere, each emoji once.
3. `mod/slack-view.ts`: each message carries `reactions` (count, whether the person is among them, the emoji).
4. `mod/outside-threads.ts`: `react()` and `searchEmoji()`, the workspace's emoji read once per account. Like a reply,
   only the person's own frame reaches them; no agent tool does.
5. Frames `account_thread_react` and `account_emoji_search`, routed to the account's Mac by `home`.
6. The card: `ThreadControls.react` changes the pill at once and puts it back when Slack refuses;
   `app/src/desk/slack-reactions.tsx` holds the pills and the picker; `inbox.react` is ⌘⇧\ in the keymap.
7. The phone shows nothing new yet: its rows stay plain.

## Tests

The client's calls and refusals, reading reactions, the emoji search, the frames' lists, toggling a pill, the main
message, the pills as drawn, and the key arriving as `\` or `|`.

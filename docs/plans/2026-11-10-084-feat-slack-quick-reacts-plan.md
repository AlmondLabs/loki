# Plan 084: Slack's quick reactions on hover

2026-11-10 · changes plan 079's react button

## Why

Plan 079 put a **react** word on the message under the pointer, which opened the picker. Slack shows a bar there
instead: the person's most-used emoji, one press each, and an add-reaction mark. The person wants it as Slack does it.

## What

1. **The hover bar.** On the message under the pointer, a bar at its top right holds the person's three quick
   reactions and the add-reaction face. An emoji reacts with it at once (or takes theirs back, as Slack does when it
   is already theirs); the face opens the picker. ⌘⇧\ still opens the picker on the main message.
2. **Quick reactions are the person's most used in Slack**, read from the counts Slack keeps in their own settings
   (`users.prefs.get`, `emoji_use`), so the bar matches Slack's. The picker's 1 to 5 are the same five. Where Slack
   keeps fewer than five, or a Mac on an older loki cannot say, loki's own (👀 ✅ 👍 🙏 🙌) fill in.

## Decisions

1. `emoji_use` is not part of Slack's documented API; the Slack client reads it, as loki already reads other
   session-only endpoints. A shape loki does not know gives no most-used emoji, and loki's own fill in.
2. An empty emoji search answers the quick reactions, so no new frame is needed; an older Mac answers none.
3. The most used are read when a Slack card first comes up for an account and kept ten minutes on the Mac.

## How

1. `mod/slack.ts`: `users.prefs.get` and `frequentEmoji()`.
2. `mod/outside-threads.ts`: `searchEmoji` with an empty query gives up to five most used, drawn (the workspace's own
   included), kept ten minutes.
3. `app/src/desk/slack-reactions.tsx`: `useQuickEmoji` and `quickChoices`; the picker takes `quick`.
4. `app/src/desk/outside-card.tsx` gives the card's controls `quick`; `app/src/desk/slack-thread.tsx` draws
   `HoverBar` in place of the react word.
5. `docs/manual.md`: the reactions sentence.

## Tests

1. `test/slack.test.ts`: most used read from `emoji_use`, as a string or an object; none for garbled or absent counts.
2. `test/outside-threads.test.ts`: an empty search gives the most used, drawn, at most five; kept ten minutes; none
   when unreadable, asked again next time.
3. `test/slack-view.test.ts`: the bar shows the first three and the add mark; no bar where the card cannot react;
   quick reactions filled to five.

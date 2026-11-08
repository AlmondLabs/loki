# A Slack card draws a message as Slack does (plan 075)

2026-11-06 · follows [plan 074](2026-11-06-074-feat-slack-card-body-plan.md)

## Why

A real bot thread on the card showed `:white_check_mark:` instead of ✅, a pull request's name with no link to it, a
person's @mention as ordinary words, and none of what the bot put in its attachment. Day pills ran Tuesday, Wednesday,
Yesterday, then Tuesday again, because the thread's replies came from later days than the channel messages after it.
loki read only a message's `text` and flattened Slack's markup into plain words.

## What changes

1. **The mod reads a message into blocks and spans** (`body` on the card's message) instead of only flat text:
   1. Blocks: ordinary lines, a `>` quote, a ```` ``` ```` code block.
   2. Spans: text (bold, italic, strike or code), a link with its address, a mention (a person, a channel, a group,
      @channel), an emoji.
   3. `text` stays plain, for hand-off and the phone, and now includes what a bot's attachment says.
2. **What a bot posted comes too**:
   1. A message made only of layout blocks (a header, sections, context) is read from those blocks, as Slack shows
      them, not from its `text`, which is then only a summary.
   2. Each attachment's lead line, title (linked), text and fields are drawn under the message behind a coloured bar.
3. **Emoji**: Slack's names become the emoji (the names Slack uses, from `emojibase-data`), skin tones included; the
   workspace's own emoji are read once per account (`emoji.list`) and drawn as small images. A name neither knows stays
   as typed.
4. **Day pills** come only from the channel's own messages, so they run in order. A reply posted on another day than
   the row above it shows that day beside its time ("Yesterday at 9:11 AM").

## Decisions

1. **Parsing happens in the mod**, where names, channels and the workspace's emoji are known; the card draws what it
   is given and parses nothing.
2. **A data package for emoji names** rather than a hand-kept table: one 48 KB file of it is bundled into the mod.
3. **Custom emoji are read once per account per daemon run**; one added later shows by name until loki restarts.
4. **Still left out**: files, images, reactions, edits, buttons.

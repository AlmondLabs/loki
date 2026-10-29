# Suggestions behind a chip in the message box

2026-10-29 · follows plan 049 (suggestions in place of tasks)

## Why

Plan 049 put a chat's suggestions in a stack of cards between the transcript and the message box. A chat with
several suggestions, or a long one, pushed the conversation up and could sit below the fold. The person asked for
the suggestions out of the way but easy to reach, in the chat and in the Inbox, on the desktop and the phone. A third
tab beside Messages and Canvas was weighed and left: a tab is out of sight, which is how Tasks went unused, and the
phone has no tabs.

## What

1. **A chip in the message box.** When a chat has suggestions waiting, the box's row shows a pill after the model
   and mode pills, on the left: "3 suggestions" on the desktop, "✦ 3" on the phone. Mic and send stay where they
   are. No suggestions, no chip: the row looks as it did.
2. **The cards open from it.** The chip opens the same cards as before (plan 049 U4: send now, save as draft, change
   chat, reject): in a popover above the box on the desktop, in a bottom sheet on the phone, as the model picker
   does. Esc, a click away, or the chip again closes it; focus goes back to the chip. The last card decided closes
   it. A refusal told after its card has gone keeps the chip, and its line, until dismissed.
3. **⌘⇧S** opens it from anywhere in a chat (chat.suggestions, beside ⌘⇧M and ⌘⇧P), and `/suggestions` in the box.
4. **In the Inbox.** The card's header says "3 suggestions" beside "draft", as a button that opens the chip's
   popover (desktop) or sheet (phone) in that card's box. The Inbox ranks as before.

## How

1. `app/src/chat/suggestion-card.tsx`: `SuggestionChip` and `SuggestionPanel` (popover or sheet, holding the
   existing stack), with an `open` state the Conversation owns. The stack keeps its logic; only where it is drawn
   changes.
2. `app/src/chat/conversation.tsx`: the stack leaves the card slot; the chip goes in `tools`; a
   `suggestionsTick` opens it, as `modelPickerTick` opens the model picker, routed the same way (shell, desk pane,
   chat window, Inbox, phone).
3. Inbox headers (`catch-up-parts.tsx`, `phone/inbox.tsx`) get the count and a press that bumps the tick.
4. `docs/manual.md`, `docs/design.md`: where suggestions are and the key.

## Checks

Unit tests for the chip's count and words (desktop lowercase, phone sentence case), the panel's open and close,
the tick opening it, the Inbox mark, and the keymap entry. Seen by eye before the PR, with the user's go-ahead for a
browser.

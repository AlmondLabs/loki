---
title: Chats that message each other, by the person's leave
date: 2026-11-04
status: active
---

# Chats that message each other, by the person's leave

## Why

A chat can reach another only through a suggestion (plan 049), and every suggestion waits for the person to send it.
That fits a finding the person should weigh, but not two agents working one problem from two chats (a repo chat asking
the infra chat whether a certificate was renewed, then going on with the answer): the person ends up carrying every
message across by hand. Letting agents message each other freely would let text from one chat, which may have come
from a web page, a file or a tool's output, start work in another chat with a different folder, mode or Mac. So
chats may message each other only along a link the person opened, for a time they chose.

## What changes

1. **A tool to message a chat.** `chat_message` takes an open chat (as `chat_list` names it) and the text. It sends
   at once when a live link allows this chat to message that one; otherwise it asks the person first (2). It never
   reaches a new chat or an archived one: a new chat is still a suggestion's job.
2. **The agent asks the person.** With no live link, the call shows a link card in the sending chat, where a tool's
   permission block would be, on the Mac, the phone and the chat's Inbox card. It names both chats and shows the
   message, and has two choices and two buttons:
   1. **direction**: **one way** (this chat may message that one) or **both ways** (each may message the other);
   2. **for**: **1 hour**, **1 day** or **until I take it back**, starting on the default from Preferences › Chat ›
      Chat links (1 hour unless changed);
   3. **allow** opens the link and sends the message; **deny** sends nothing, and the agent is told it was refused.

   The agent waits for the answer as it waits on a tool's approval. The card asks every time there is no live link,
   in every permission mode, unrestricted included, and "always allow" never covers `chat_message`: a link is opened
   only on this card.
3. **What the receiving chat gets.** The message lands as a row of its own, "from <chat>", with a link back to the
   sending chat; never as the person's message. It starts a turn there, or waits in the queue when one is running, as
   a message the person typed would. The receiving agent is told it comes from another agent, that it may decline,
   and how to answer: with `chat_message` when the link runs both ways, and otherwise not at all. In the sending
   chat the call shows as a step with its text.
4. **No borrowed power.** A turn a chat message starts runs in the stricter of the two chats' permission modes. A
   chat in standard mode cannot use an unrestricted chat to run what it would have had to ask for. The hold
   (`turn_cap` on the chat's record) is written before the message goes in and stays until the person next messages
   the chat while it is idle, so a queued turn cannot slip out of it; a held chat's own messages pass it on. A chat
   on an ACP agent keeps its own mode, which loki cannot lower for one turn, so a message to one with more power is
   refused instead.
5. **A cap per link.** A link carries at most 20 messages an hour into each of its chats (`CHAT_LINK_MESSAGES_PER_HOUR`
   in one place), counted by the Mac each chat lives on. Past it, `chat_message` is refused with the reason and the card shows nothing new: two agents
   answering each other cannot run up cost without bound. The person sees the refusal in both threads.
6. **Seeing and closing links.** A chat with a live link shows it in its header (an arrow for the way, the other
   chat's name and the time left) with **×** to close it, on the Mac and the phone. Preferences › Chat › Chat links lists every live link
   with its direction and expiry, each with **close**, and holds the default duration (on the Mac only). A closed or expired link
   asks again on the next message.
7. **Paired Macs.** A link may join chats on two Macs. The link is kept on both chats' homes, and the receiving home
   checks it before it delivers: a message the sending Mac says is allowed but the receiving Mac has no link for is
   refused. The new frames join the peer allow-list through the frame table, as every other frame does.
8. **Who cannot.** Reflection, Learn and doctor passes have no chat screen for the card, so they have no
   `chat_message`.

## Decisions for review

1. **The link is asked for at the first message, not set up ahead.** The person decides with the message in front of
   them, which is what they asked for; nothing needs configuring before two chats can work together.
2. **The card is not a tool approval.** It has its own choices and is the only way to open a link, so a mode, an
   "always allow" or an unrestricted chat can never open one by accident.
3. **Stricter of the two modes (4).** Asking for every tool in a turn a chat message starts would make links tiresome;
   using the receiving chat's mode alone would let a careful chat borrow a looser one's power. The stricter of the two
   gives neither.
4. **A rate cap, no hop count.** A hop count would end the back-and-forth that both ways is for; a visible cap per hour
   stops a runaway loop and leaves conversations alone.
5. **Suggestions stay as they are.** Letting a pair of chats send suggestions without asking was the other way to do
   this; links replace it, since a message between agents is not the person's. Suggestions remain for work the person
   should weigh and for new chats.
6. **The card is a question card underneath.** It travels as a `question` event whose input is the link, answered
   through `chat_answer`, so the Inbox, the phone and a client opening late treat it as something waiting on the
   person with no new plumbing; the app draws it as the link card.
7. **Durations.** 1 hour, 1 day and until taken back, with the default in Preferences. Other lengths can be added if a
   week of use asks for them.

## Tests

1. `chat_message` with no link asks; allow opens a link with the chosen direction and expiry and delivers; deny
   delivers nothing and tells the agent.
2. A live one-way link lets A message B without asking and makes B's `chat_message` to A ask; both ways lets both.
3. An expired or closed link asks again; the clock is injected.
4. The 21st message within an hour is refused, in both directions together.
5. A turn started by a chat message runs in the stricter mode of the pair, for each pair of modes.
6. Unrestricted mode and an "always allow" entry for `chat_message` still show the card.
7. A receiving home with no link refuses a message a peer claims is allowed.
8. The message rows render "to" and "from" with the link back; the header and Preferences list live links and close
   them.

## Checked by hand

1. Two chats on one Mac: A asks, allow both ways for an hour, B answers A, A goes on; close the link from B's header
   and A's next message asks again. On the phone too.
2. The same across two paired demo daemons, with made-up chats for any screenshot.

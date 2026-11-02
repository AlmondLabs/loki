---
title: Next sets a chat down for an hour
date: 2026-11-02
status: active
---

# Next sets a chat down for an hour

## Why

Working many chats at once leaves the person unable to hold any of them: replies get shallow, turns go on questions
the thread already answered. The last 30 days of analytics show how the Inbox feeds it:

1. 57% of the times you came back to a chat within three hours, you had messaged another chat in between; 18% of
   the time three or more. A third of active hours touched 4 to 8 chats.
2. You read a card for a median of 71 s before replying when you stayed in the chat, about 30 s after a switch.
3. Next rested a card for ten minutes, so a chat you had set aside came back, still half-loaded, before you had
   finished the one in front of you. A card back from that first rest was acted on 10 times in 33.
4. The ranking was tuned for engagement, which counts every reply as a win, a shallow one included. Engagement says
   the Inbox did well when you hopped the most.

A cap on chats in flight was considered and left for later: the longer rest is the smaller change, and the numbers
below say whether the cap is still needed.

## What changes

1. **Next rests a card for an hour by default.** Every Next rests at least the first rung, now an hour: a card with
   something new, a Next straight after replying, and the first Next on a stale card. A stale card climbs as before,
   three times longer each Next in a row (1 h, 3 h, 9 h, 1 d 3 h, 3 d 9 h, capped at a week), and a chat quiet longer
   than its rung rests at least that long again.
2. **Anything new still ends a rest.** An idle agent speaks only when a background task finishes or a schedule fires,
   and that is news. A Next straight after replying therefore still brings the card back the moment the answer lands;
   if the answer has already come and been read, the Next sets the chat down for the hour.
3. **The first rung is a setting.** Preferences › Inbox › Next rests a card for: 10 min, 30 min, 1 hour, 3 hours.
   The growth (×3) and the cap (a week) stay constants.
4. **Analytics measure finished work, not activity.** `npm run analytics` gains a "finished work" section: chats
   archived an active day, messages into each chat archived in the period (median), and how often a return to a chat
   came after messaging others in between (none, 1, 2, 3+). The engagement section stays for comparison.

## Decisions for review

1. **The setting is the device's.** It is kept in the Mac window's localStorage; the phone rests by the default
   hour. A rest, once set, is the mod's and shared as before, so only the length of a Next pressed on the phone can
   differ. A shared setting would need a frame, a file and pairing for one number.
2. **No separate short rest for moving on.** The ten-minute rest after replying only mattered when the answer had
   already come; otherwise the answer ends the rest anyway.

## Tests

1. The ladder starts at the first rung given and climbs ×3 to the cap; the default first rung is an hour.
2. A Next on a card with something new, and a Next straight after replying, rest the first rung without climbing.
3. The stored setting parses to its rung and anything unknown reads as an hour.
4. The finished-work numbers count archives a day, messages per archived chat and the chats between returns.

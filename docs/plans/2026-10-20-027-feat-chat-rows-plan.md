---
title: Chat rows the same on the Mac and the phone
date: 2026-10-20
status: active
---

# Chat rows the same on the Mac and the phone

## Why

The Mac's sidebar and the phone's Home list draw the same chats two ways, and the polish the Mac got (one status
mark per row, the Mac an agent lives on in its section, the open chat's highlight) never reached the phone. Both
lead every row with the same `#` glyph, which says nothing; the agent's face sits on its main chat row (the Mac) or
on both its section and its main chat (the phone); the Mac shows no times; and the phone's preview line shows the
end of a cut reply, often from mid-word ("ttps://github…", "full period\*\*.") because the Inbox keeps the reply's
last 700 characters (`core/attention/model.ts`) and the preview takes their first line.

## What changes

One row, on both:

1. **No lead.** The `#` goes from every row, and the agent's face from its main chat row. Names line up under their
   section.
2. **The agent's face is on its section header**, beside its name and the Mac it lives on (the Mac's header already
   names the Mac; the phone's already has the face). Pinned keeps its pin.
3. **The main chat is an ordinary row**, first in its section, named "Main chat" or its title.
4. **The right side holds one thing**, as `ListRow` already decides: the count badge when something waits on you,
   else the pulsing dot while a turn runs, else the time ("now", "5m", "3h", "2d"). On the Mac the time is new.
5. **After the name**, the location mark (`homeMark`), only where the chat lives away from its agent's Mac, as now.
6. **No preview on the phone.** One line per chat, at touch height; the Inbox is where a reply is read. The phone's
   "running…" and "waiting for Mac mini" words leave with the preview: the pulsing dot and the location mark say
   them.
7. **Days after a day.** The shared `ago` (app/src/shared/ago.ts) counts hours up to 24, not 48, so "40h" reads "2d".
8. **The phone's compose button** needs nothing: Home's list already ends with room for it, so the last row
   scrolls clear; a row passing under it mid-scroll is the floating button's nature (found 2026-10-20).

The changes go in small steps, each rendered from the demo Macs and checked by the person before the next (their
standing rule for visual work):

1. The Mac's sidebar: no leads, the time, the face on each agent's section.
2. The phone's Home and Archive rows to match, previews gone.
3. `ago` in days after a day.

Labels as chips on rows are left out: the person decides that separately.

## Tests

1. `test/chat-rows.test.ts`: on the Mac, a running chat's dot in its time's place, and an agent's section with its
   face; on the phone, one line with the name and the time and no lead or preview, the count while it waits, the
   dot while it runs, and the laptop for a chat away from its agent's Mac.
2. `test/ago.test.ts`: 23 hours is "23h", 40 hours "2d".
3. The existing sidebar and list-row tests, unchanged.
4. By hand: each step's screenshot, dark and light, from the demo Macs.

# Mail is drawn as its sender wrote it (plan 072)

2026-11-05 · follows [plan 068](2026-11-05-068-feat-inbox-thread-reply-plan.md)

## Why

An email card showed every mail as plain text made from its HTML. Billing and marketing mail lost its layout (tables
ran together), links were bare text in brackets and could not be clicked. The person asked for rich HTML and working
links.

## What changes

1. **The HTML part reaches the card.** Gmail's reader keeps each message's HTML part (up to 512 KB) beside its text,
   and the read frame gives it to the person's card only. Agents and hand-offs still get the text.
2. **The card draws it in a sandboxed frame.** No scripts, forms, popups or frames run; the frame's own policy allows
   only images, styles and fonts; script, frame, object, base and refresh tags are removed first. The page is light,
   as mail is designed for, and the quoted thread under a reply is hidden as the text view does.
3. **Links open in the browser.** A click on an `http`, `https` or `mailto` link opens it with the system browser;
   nothing navigates inside loki.
4. **Plain mail and Slack get links too.** Web addresses in text become links.

## Decisions

- **Remote images load automatically**, as in Gmail, chosen by the person over asking per mail or per sender: a sender
  can tell the mail was opened.
- **The frame shares loki's origin with scripts off**, so loki can size it to its content and catch clicks; without
  `allow-scripts` nothing in the mail can use that.
- **Inline `cid:` images are not fetched yet**; they show as missing.

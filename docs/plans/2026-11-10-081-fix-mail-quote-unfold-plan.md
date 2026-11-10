# Plan 081: forwards read open, and a reply's quote opens with •••

2026-11-10

## Why

A mail card hid everything inside Gmail's `gmail_quote`. Gmail wraps a forward in that class too, so a forward with a
note on top ("FYI in case this is relevant") showed the note and nothing else. The card offered no way to see the
forwarded mail. #212 fixed a forward with nothing above it; a forward with a note was still blank.

## What

1. **Forwards read open.** A quote that opens with a forward's line ("---------- Forwarded message ---------", or
   Apple Mail's "Begin forwarded message:") is shown, in the HTML view and in the text view, as Gmail shows forwards.
2. **••• opens a reply's quote.** The earlier thread quoted under a reply still folds, with a ••• under the mail that
   shows it and hides it again, as Gmail does. It shows only when there is a quote to open.
3. **A mail that is all quote shows it**, as #212 made it.

### Decisions

1. **A reply quoting an earlier forward still folds.** Only a quote whose own first line is the forward's counts.
2. **The text view has no •••.** The daemon cuts a plain mail's quote before the card gets it; a plain reply's quote
   stays cut as before.
3. **Opening redraws the frame** with the quote shown, rather than reaching into the frame to unhide it, so the frame's
   document stays a pure function of the mail.

## Also

An unclosed `<base>` (or `embed`, `frame`, `link`) took the rest of the mail with it when it was stripped. Tags with no
end tag are now taken out alone.

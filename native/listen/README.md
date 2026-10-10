# loki listen (experimental)

Records a call's two sides and transcribes them on this Mac, with no bot in the call:

- **Them:** the call app's audio, through a Core Audio process tap. By default it taps Chrome (Google Meet) and
  Slack (huddles), following each app's helper processes by bundle ID.
- **You:** the microphone.

Apple's on-device SpeechAnalyzer turns both into text. No audio is saved and nothing leaves the Mac. The transcript
is written as the call goes, to `~/.letta/loki/calls/<yyyy-MM-dd-HHmm>.md` (or `$LOKI_CALLS_DIR`).

It needs macOS 26 and Xcode or the Command Line Tools.

```sh
npm run listen                    # Meet in Chrome and Slack huddles, until Ctrl-C
npm run listen -- --apps zoom     # or: chrome, slack, safari, teams, or any bundle ID
npm run listen -- --all           # every app's audio
npm run listen -- --raw-mic       # the microphone without echo cancelling, to compare
npm run listen -- --locale en-US  # the language spoken (default this Mac's)
npm run listen -- --list          # which apps Core Audio sees, and which are playing
npm run listen -- --languages     # which languages are supported (✓ installed)
npm run listen -- --file x.m4a    # transcribe a file, to check transcription without a call
```

## First run

The first run can fetch the language's speech model from Apple. macOS then asks the app you ran it from (Terminal,
iTerm, Ghostty…) for two permissions:

1. **Microphone,** for your side.
2. **System audio recording,** for theirs: System Settings › Privacy & Security › Screen & System Audio Recording ›
   System Audio Recording Only. If it was refused, the tap still runs but hears silence. listen says so when the call
   ends.

## Limits

- **Speakers:** the microphone hears them too. Apple's voice processing (echo cancelling) is on to take that out of
  your side; `--raw-mic` turns it off to compare. If macOS will not start it, listen says so and uses the
  microphone as it is. At the end listen counts your lines that still look like theirs
  (their words within 2.5 s), and shows a few. Nothing is removed from the transcript. Voice processing turns other
  audio down a little while it runs (set to the minimum).
- **Tapping Chrome hears all of Chrome,** a YouTube tab included.
- **Timing:** each side's times count from when listen started, so the two sides line up to within about a second.
- **Consent:** tell the people on the call that you are transcribing it.

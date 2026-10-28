---
title: A paired Mac out of reach stays quiet
date: 2026-10-29
status: active
---

# A paired Mac out of reach stays quiet

## Why

The 2026-10-28 scan named three things the daemon does while nobody uses loki. Measured on this Mac:

1. **A paired Mac that is turned off flips between "connecting" and "unreachable" forever.** Each retry, one every
   38 seconds or so (the 30-second backoff and the 8-second handshake), set "connecting" and then "unreachable" again.
   Each change logged a line, broadcast the paired Macs (`peers`) to every window and phone, and read the Bonjour name.
   `mod.log` held 9,679 of them since 2026-10-18, 39% of its lines.
2. **The phone build is hashed every 5 seconds** while the phone listener is on: 64 µs a time, about 1.1 s of CPU a
   day.
3. **`mcp.json` is polled every 2 seconds**: a `stat`, 4.4 µs a time, about 0.2 s of CPU a day.

## What changes

1. **A retry of a Mac out of reach does not say "connecting"** (`PeerLink.open`). The link stays "unreachable" until
   the Mac answers, so a Mac that is off makes no status change, broadcast or log line until it comes back. The
   first open, and an open after the link was reachable, still say "connecting".
2. **The build check runs only while a client is connected** (`LanListener.checkBuild`). Nobody else can be told, and
   a phone that connects later loads the page as it is. The saving is small; the change is two lines.

## Left as it is

`mcp.json`'s poll costs about 0.2 s of CPU a day. Watching the file instead (`fs.watch`) stops when an editor or loki
replaces it by renaming, and watching `~/.loki` would wake on every `mod.log` write: more to get right for nothing
measurable.

The task list's `bd list` every minute (0.8 s each) goes with beads, which is being removed separately.

## Checked

`test-node/peer-link.node-test.ts`: while the far Mac is away, three retries change nothing, and its return makes it
reachable again. The test fails on the old code.

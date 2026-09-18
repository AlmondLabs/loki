# Changelog

Every stable, newest first. The version is the day it shipped (UTC); nightlies are not listed.

## 2026.9.18

- **releases from every merge: a nightly channel, one release PR, the calendar as the version** (2f7a376)
  One workflow on push to main (and at midnight UTC, and by hand): scripts/release.ts plans the run — a nightly
  from any merge, a stable when the release PR lands, a repush when it landed on the wrong day, nothing when
  nothing changed. Versions are dates: a stable is YYYY.M.D (UTC) of the day its release PR is merged, a nightly
  is that day plus the merge; tags are the truth and the three version files hold the last stable between
  releases, moved only by the release PR (branch release/next, rebuilt from main on every merge). One stable a
  day. The rolling `nightly` prerelease is replaced only after a build succeeds; the loki-nightly cask joins the
  tap and conflicts with loki, since both builds share ~/.letta/loki and the shim. The app reads its channel off
  its version and asks GitHub for the right release. The tag-triggered release and the publish-triggered cask
  workflows fold into this one; nothing is tagged by hand. Plan 011.
- **inbox: simplify — score stamped once per rebuild, who-asked as a word, one Knob row, shared clamp** (9792e1e)
  From a four-angle cleanup review of the branch. The score and reason are stamped on each item by buildItems
  at one instant; the deck's merge and pop sort by the stamp instead of recomputing with their own clocks.
  lastAsk becomes "person" | "schedule" (the time was never read) and is required everywhere; the
  scheduled-prompt detector moves to core/harness.ts beside the other harness-text recognisers. The blocked
  sign flip is its own named term. The two ladder fields share one Knob row; clamp/within live in core/range.ts
  and the recall tick clamp uses them; the digest loop uses locals and an early return; the merge's unchanged
  check compares identity; one test fixture serves three suites.
- **inbox: a reply keeps the card again — moving on is ⌘], as designed** (a96ee85)
  The first cut made a reply pop the card and re-enter it by score when the answer landed. That reversed a
  deliberate design (the old comment: sending a reply keeps the card; moving on is yours) without saying so, and
  the burst does not need it: staying, the answer streams in where you are and the follow-up goes out warm. The
  structured question form now goes through the same path as a typed reply. Plan 010 keeps the record.
- **inbox: among blocked cards the agent that has waited longest comes first** (b65d925)
  The age term flips sign for blocked cards (+0.1 a point an hour instead of −): a stopped agent is the one
  case where waiting makes a card more urgent. Everything else still drifts down; ties fall to a stable sort.
- **settings: the ladder's range check at module scope** (dd06aa1)
- **inbox: the "later" ladder becomes two knobs — first deferral (10 min) and growth (×3), in Settings › inbox** (db857b5)
  The fixed 5m · 15m · 45m · 2h · 6h · 1d steps were already geometric, about ×3; now first · growth^(n−1)
  minutes, capped at a day, with both knobs in core/attention/ladder.ts (ranges 1–1440 min, ×1–×10). The mod
  keeps the setting in state/attention.json beside the markers, the seen frame carries it and snooze_ladder
  sets it, so the phone defers by the same ladder. Settings gains an inbox page: the order's terms, the two
  fields, and the resulting ladder. Defaults 10m · 30m · 1h30 · 4h30 · 13h30 · 1d.
- **inbox: a priority queue — one score per card; a reply hands the card over and the answer comes back warm** (98b63be)
  The deck becomes a scheduler's ready queue: blocked ? 100 + warm ? 10 + yours ? 5 − 0.1/hour, no bands.
  Blocked agents first, then replies to you whose prompt is still cached (a reply now costs a tenth of one
  typed later), then colder replies, then reports nobody asked for. The order is recomputed on every event
  and again at each pop; the head never moves until you act on it. Replying or answering pops the card at
  once; when the turn finishes it re-enters by score, warm and yours, right behind what you are reading —
  the burst that keeps the provider's cache hot. The mod's digest now records the last person's (or a
  schedule's) message so a cron's digest ranks as a report. Snoozes stay the wait queue. Plan 010.
- **docs: README brought up to the shared-Letta design and the Learn knobs; docs/learn.md is the mental model for the card writer, leads and lessons** (c145ced)
- **learn: the writer's sweep interval is a setting — "sweep every N minutes" in Settings › learn and on the all-cards strip** (0e2c1d5)
  worker.json gains tickMinutes (ten by default, clamped to 1–1440); the mod's timer follows it and resets when the
  setting changes (bridge → reschedule). The quiet threshold a conversation must pass stays ten minutes. The
  phone still cannot change the writer's settings. Each sweep that finds quiet conversations is one model call
  per agent, plus a compaction, over the agent's whole fixed prompt — the setting is the lever on that spend.
- **letta: loki runs the Mac's own Letta Code — found where installers put it, or npm install -g at first launch; attaches to a running app-server, else launches; the mod stands down in terminal sessions** (3a3f5a6)
  The private copy under ~/.letta/loki/runtime is gone (plan 009 reverses plan 006). bootstrap.rs looks for
  `letta` on PATH and where installers put it (Homebrew, volta, bun, nvm, fnm, npm-global) and, finding none,
  runs `npm install -g @letta-ai/letta-code@latest` with the npm beside the first Node 22+ — the same file a
  terminal runs. EACCES names the sudo line; loki never runs one. The Node download, LOKI_NO_SYSTEM_NODE,
  LOKI_NO_BOOTSTRAP and Runtime.private go. The cask depends on the `node` formula.

  appserver.rs finds any running app-server — Desktop's ports, every `letta server --listen` and
  `channel-gateway --app-server-url` in the process list — without auth, then with loki's token; one found
  means attach and launch nothing. A plain terminal `letta` opens no app-server (Letta starts one only for
  `server`, the channel gateway and Desktop), so it is never loki's harness.

  core/compat.ts is a range: MIN_LETTA_CODE (refuse below, with the upgrade line) and TESTED_LETTA_CODE
  (0.32.10, "newer than tested" above). Settings › letta says which harness, which Letta, where it stands;
  `update` runs the same npm command and restarts a harness loki launched.

  The mod: Letta has one shared mods folder and every harness loads it (LETTA_MODS_DIR reaches `letta
  install`, not the loader — tested). mod/gate.ts decides at activate from the capability profile Letta hands
  over: sessions (lifecycle events on) stand down, the listener that hosts an app-server serves. Verified on
  0.32.10 with an isolated HOME: `letta -p` stands down; `letta server` serves under Bun and under Node.

  Found on the way, both in the release bundle only (checkouts run mod/boot.ts): the inlined `ws` cannot
  finish a handshake under Bun, which Letta's launcher prefers — mod/ws.ts takes Bun's own at runtime (the
  one dynamic import path React Doctor flags is that, on purpose); and the ESM bundle threw "Dynamic require
  of events" on import under Node, so on a Mac without Bun the mod never activated — build-mod.ts adds a
  createRequire banner. test/build-mod.test.ts pins both.
- **homebrew: --no-quarantine is gone from Homebrew 7; the install is two lines, and the cask's depends_on takes the new form** (7092b68)
  Installing the first published cask on this Mac showed two things the docs had wrong. Homebrew 7 rejects
  `--no-quarantine` outright ("invalid option"), before it even looks the cask up — the README's one-liner
  could never have worked for anyone on a current Homebrew. And the cask's `depends_on macos: ">= :ventura"`
  prints a deprecation warning twice per install; Homebrew now wants `depends_on macos: :ventura`.

  The install is now `brew install --cask <owner>/loki/loki` followed by
  `xattr -dr com.apple.quarantine /Applications/loki.app` once, in the README, the manual, the release notes
  body and the cask's caveat (which also names System Settings › Privacy & Security as the other way). The
  release docs explain why. The cask test pins the new form and the absence of the dead flag.

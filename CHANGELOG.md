# Changelog

Every stable, newest first. The version is the day it shipped (UTC); nightlies are not listed.

## 2026.10.11

- **ci: package-lock.json written by CI's npm, so npm ci installs there — the lockfile from AlmondLabs/loki#31 was written by this Mac's npm 11, which leaves out @emnapi/core and @emnapi/runtime (optional peers of the wasm fallback); CI's Node 22 brings npm 10.9.9, whose npm ci refused the lockfile as out of sync, and every ci job stopped at install. npm 10.9.9 adds the two entries and changes nothing else; npm ci now installs with npm 10.9.9 and with npm 11. Checked on CI's versions (Node 22.23.3, npm 10.9.9, bash): npm ci, typecheck, lint, the suite (1162 pass), test:node, build:app, build:mod** (2f76a5c)
- **loki drops Bun: npm, vitest and Node run everything, as Node runs loki — nothing loki ships ran on Bun, but the tests did, so they ran the mod on a runtime it never meets: mod/ws.ts chose Bun's own ws, the LAN tests failed on an older Bun, and a background-task bug hid behind zsh until CI. Now npm keeps the dependencies (package-lock.json, built from the tree bun.lock installed: the same versions but three patch bumps in wasm fallbacks), vitest runs test/ on Node (vitest.config.ts carries the app's aliases; bun:test's imports, setDefaultTimeout, Bun.file/write/sleep/YAML, two Bun-only matchers and import.meta.dir are Node's or vitest's now), and the scripts run with Node's type stripping (`npm start`, `npm run release|cask|build:mod|analytics`; import.meta.main, which Node 22 lacks, becomes a realpath check). mod/ws.ts is the inlined ws alone; dev.ts no longer runs Vite under Bun without a Node; tsconfig drops Bun's types; Tauri's before-commands, CI and the release workflow use setup-node and npm (`npm run tauri -- build`, `npm run --silent cask` so the cask file holds only the cask); package-lock.json is no longer ignored and eslint skips .claude/ worktrees. The README, CONTRIBUTING, the manual, RELEASING and architecture say Node where they said Bun.** (3264bf5)
  Background tasks: a stop signals the task's group again after 150 ms and kills what is left after 2 s, because a process the shell was forking as the first SIGTERM landed missed it and lived on holding the output open (3 of 12 runs under load; CI's busy runners); 60 of 60 pass under load now. The output test waits for input, not a 0.2 s sleep, between its two lines, which a busy machine could deliver together.

  Checked on Node 22.19 (loki's minimum and CI's major) after a clean npm ci: typecheck, lint, the suite three times under bash and once under zsh (1162 pass each), test:node, build:app, build:mod, the release bundles serving a socket, dev.ts --check, cask and release plan/notes; the suite once more on Node 25.
- **background tasks: stopping one stops what its shell started — a task's shell was the only process signalled, so under bash (CI's shell; zsh happens to exec a lone last command) `sleep 30`, or a dev server under `npm run`, lived on holding the output open, and the task read as running after TaskStop and the daemon's stop; the test passed locally only because the shell here is zsh. A task now starts in its own process group off Windows and a stop signals the group; on Windows, which has no groups, taskkill ends its process tree, and a task stopped there reads as stopped (SIGTERM) like anywhere else. The test keeps `sleep` a child in every shell (an echo after it), so it fails here as it did on CI without the fix** (64417c4)
- **ci and release: the run after an early release PR no longer fails, and background tasks run on Windows — merging the release PR for 2026.10.11 on 2026-10-10 (one stable a day) left main carrying that release, so the release PR job rebuilt it from main, had nothing to commit and failed; release-pr now says main already carries it and stops, and the run on its day finds the files dated today and publishes it. Background tasks spawned /bin/sh, which Windows has not, so every task failed there with ENOENT; they run in Git Bash where Git for Windows puts it, else a bash.exe on PATH, as pi-durable's own bash tool does (daemon/background.ts, shell). The uploads, store manager and skill tests wrote their expected paths with forward slashes; they build them with node:path, so Windows' bun test passes. (macOS's flaky "can be stopped" background test is the shell's children holding the pipe after SIGTERM; the process-group stop on the reliability branch fixes it.)** (ab4e115)
- **import: a Mac that ran loki on Letta finds its agents again, and ci shows every failure — the import from Letta was removed (e776dcc) hours before v2026.10.10 was cut, so no release carried it and the README sent Letta users to one that did not: on such a Mac loki started with no agents. daemon/import is back, with the kernel's importEntries, the chat_import frame and Settings › loki › Import, and the daemon now runs it on its own at start, before the mod opens its sockets, until one run finishes (letta-import.json records `complete`); with Letta running it refuses and tries again at the next start. It meets the background passes (plan 018): their settings carry over first, each imported chat is held from them while its entries are written, then gets a reflection cursor at its end (Letta's reflection read it) and a Learn cursor converted from Letta's log lines to entries (a chat Learn never read starts where it is now); Letta-era Learn's worker file is only read. The README and architecture say what happens; the import, kernel, thread and transcript tests that went with it are back, which also clears the unused imports lint failed on. ci: cargo test failed on Windows since the root move's test removed the old path's junction with remove_file, which Windows refuses for a directory; it uses remove_dir there. ci's checks now each run once the install did, so a lint error no longer hides a failing test (Windows' bun test went unrun behind lint from 2026-10-09)** (ab24004)

## 2026.10.10

- **fix(review): background passes keep one queue, never start on a busy chat, and read a long stretch whole — applies code review findings #1, #2 and #4 (run 20261010-210700-647b2cfe). /reflect and Learn's Run now went around the queue, so a pass by hand could clear the shared reflection-<agent> chat while a sweep's run was using it; every run now goes through the one queue and a hand run waits its turn, while a run already queued or running is not queued again (a sweep during a long run no longer queues it twice). A queued run checks again that its chat is not busy when its turn comes, and leaves it for the next sweep with its cursor where it was. A stretch longer than a run reads (24k characters) was read only from its newest part while the cursor passed all of it; runs now read from the cursor as many whole entries as fit, oldest first, and the rest is the next run's, so none is skipped. Also from the review: the first start's carry-over is marked by the cursors file rather than the settings file (a settings change in the first seconds after a start could otherwise skip it), a carry-over that fails is reported instead of leaving the passes silently stopped, the eligibility filter is written once, and the app's Learn settings types lose the model and interval they no longer send** (cdcd199)
- **docs: the background passes (plan 018, U7) — architecture describes reflection and Learn as two jobs on one runner and where their settings and cursors live; docs/learn.md's writer is a pass now (half an hour quiet, one chat a run, as the agent with no tools, concepts and lasting knowledge only, five cards a day as a ceiling, its files under ~/.loki), without the sweep interval, packing, compaction and model setting; the manual's Reflection page and Settings › learn match the screens; the glossary gains "Background pass"; the README's Learn line says what it keeps** (5cca186)
- **telemetry: every background run is measured by its job (plan 018, U6) — a pass's turn is told apart by its request id (pass:<job>:<chat>:<entries>), so its turn_finished says reflection or recall and carries that id; each run's pass_finished (job, chat, entries read, how it ended, what it wrote by kind, duration) joins its turn by the same id. `bun run analytics` gains a background passes section: per job, runs, how they ended, what they wrote, and what a run cost on average — for loki, and later optimus, to watch; nothing of it is shown to the person** (fe870fe)
- **passes: the settings frames are pinned down (plan 018, U5) — chat_passes_set takes either part on its own, rounds Learn's cards a day down, and refuses a wrong kind or a negative cap; recall_settings keeps only on/off and the cap, dropping the model and sweep interval it no longer has. The settings surfaces themselves moved with reflection and Learn (U3, U4)** (eb7e923)
- **learn: a background pass on the runner, for concepts and lasting knowledge (plan 018, U4) — Learn's cards were mostly one-off details of a task, so 181 of 208 were never studied. Its prompt now asks only for a concept or principle the person met, or knowledge of their field that will still be true in months, names what never makes a card (a detail of the task at hand, passing state, how the agent worked, what the person already knew), and says zero is the usual answer. It runs as one of the daemon's background passes (daemon/learn.ts): one quiet chat per run, as the agent in its writer chat cleared first and with no tools, up to the day's cap across all agents (the old default of 25 becomes 5); cards it could not fit wait with the stretch for tomorrow, failing cards of the agent ride along for a rewrite, and deleted cards and dismissed leads still steer it. The mod's worker, its timer, its packing of many chats into one ask, its sweep interval and its own model setting are gone, as is the daemon's ask that served it; the Learn section and Settings › learn now read and set the daemon's settings (on or off, cards a day), and "run now" reads every chat with something new, even with Learn off** (47c2f29)
- **reflection: a background pass on the runner (plan 018, U3) — a chat that has been quiet for half an hour and holds new material is reflected on, however short (the 25-answer threshold is gone, so a short chat that taught something is no longer passed over), and a just-compacted chat is reflected on at once. It works as the agent in one hidden chat per agent (`reflection-<agent>`, cleared before each run), memory tools only, so its commits stay "Reflection"'s, and its instructions now hold the passes' bar: keep what will matter in later chats, leave out one-off details of the task. The daemon starts the runner once its stores have loaded, after carrying over reflection's and Learn's settings and cursors on the first start; /reflect runs a pass even with reflection off. Settings become the passes' own (chat_passes_get/set: reflection and Learn on or off, Learn's cards a day) in place of the trigger, step count and merge settings, which Letta's reflection had and the daemon never used; the Reflection page is now an on/off switch and the last change reflection made, without the per-chat step counters** (db4fc11)
- **passes: the first start's carry-over is pinned down (plan 018, U2) — reflection off stays off and any other trigger is on; Learn on stays on, its old default of 25 cards a day becomes 5 while a cap the person chose stays; reflection's reflected_through and Learn's card cursors carry over (its lead cursors go: one cursor per job), as does today's card count; a chat with no cursor for a job, Letta's cursorless reflection state among them, starts where it is now, so the first sweeps read no old chat; the old files are only read** (55a3acd)
- **passes: one runner for the background passes (plan 018, U1) — once a minute it looks over the person's chats, and a chat quiet for half an hour with new material past a job's cursor gets a run of that job, one run at a time across all agents, as the agent itself in the job's hidden chat for the agent, cleared first. A stretch too small to hold anything moves the cursor without a model call; a long one is read from its newest 24k characters; a run that fails keeps its cursor and waits another quiet spell before it is tried again. A job that follows compaction reads a just-compacted chat without the wait: the chat projection now marks compaction entries and says when its stores have loaded. Settings and cursors live in two files only the daemon writes (state/passes.json, state/pass-cursors.json), with the first start's carry-over from reflection's and Learn's own files. Each run is one pass_finished event. Nothing runs on it yet** (7faa6dc)
- **plan 018: background passes — reflection and Learn as two jobs on one runner in the daemon, with the same process and different objectives: a shared quiet-and-new trigger (reflection also right after compaction), cursors per job per chat, a hidden chat per job per agent, one run at a time, every run measured; Learn narrowed to concepts, principles and lasting domain knowledge, at most about 5 cards a day** (2e2e196)
- **telemetry: the daemon measures every agent turn — at a run's end it captures one turn_finished into events.jsonl, read from the store with daemon/timing.ts (daemon/telemetry.ts): chat, agent, model, harness version (a checkout's commit, marked -dirty with tracked changes, else loki's version), turn id, tokens summed over the turn (input, output, cache read and write, reasoning), cache share, cost, ttft/total/model/tool/overhead ms on the daemon's clock, tool calls and failures, stop reason, error with a short code (never message text), and origin (message, schedule, background, subagent, recall, reflection). A run keeps its identity across the task hand-over after each tool round; a message the agent cannot take up at all is a turn that failed at once. The mod's own turn_started/turn_finished bookkeeping is gone (its duration was null for most turns); the daemon and the mod share one analytics writer. The turn id rides on the chat's loop-running and turn_end events and on its opened state, so message_sent, approval_decided, inbox_card_decided, chat_archived and turn_stopped carry turn_id. `bun run analytics` gains a harness section: per model and per harness version, p50/p90 ttft, overhead and total, cost a turn, cache share, error and tool-failure rates; helpers', Learn's and reflection's turns no longer count as ones you are waiting to answer** (7f57a23)
- **loki lets go of Letta: the import is gone, and a fresh start no longer makes ~/.letta — daemon/import (the importer, its log converter and its reference reader), the Import row in Settings › loki, the chat_import frame, the kernel's importEntries, reflection's markReflected, the import check script and their tests are removed; this Mac's import is done, and the README points anyone still on Letta at the 2026-10-10 release that carries it. Imported chats keep showing Letta's off-path replies (`loki.branch`). The root move still moves an old ~/.letta/loki to ~/.loki behind a link, but with no old folder it only makes ~/.loki: it used to create ~/.letta/loki as a link on every start, which would have brought ~/.letta back once removed** (e776dcc)
- **dev: the phone's app rebuilds again — its build watch had read the widgets folder as ~/.letta/loki/widgets, and since loki's root moved to ~/.loki behind a link, Rollup named the widget files by their real path, missed that they are left out of the build, and failed every build on the widgets' React import while the watch looked alive. The config now knows the folder by its real path too, and `bun start` restarts the phone's build watch when app/vite.config.ts changes, which a build watch never rereads** (926b86b)
- **chats: the box stops thinking when the daemon says the chat is idle — the live state compared the loop against Letta's status words (WAITING_ON_INPUT, WAITING_ON_APPROVAL), and the daemon says idle and approval, so every chat the daemon reported idle (each one opened, each turn ended) showed as working, on the phone and the Mac; the live state now keeps loki's own loop states** (8a1de97)
- **chats: an answer is heard after the daemon restarts — the daemon pushed a chat's events only once a client had opened it since it started, and a client remembers what it opened, so after a restart a message went out from a chat the daemon was not following and its answer arrived only when the thread was read again, the box still "thinking". Now a message into a chat makes the daemon follow it, and when the mod's socket comes back after a drop the client opens its chats again, which also ends a turn that finished while it was away** (9139eaa)
- **daemon: a message the agent cannot take up says why instead of thinking forever; Letta's model names are translated — a turn the daemon refused at once (no model by that name, or a provider with no sign-in) ended without a word to the app, which kept showing "thinking"; the refused message now ends the turn with the reason and what to do. Some of Letta's model names are not pi-ai's: ChatGPT's provider is `chatgpt-plus-pro` there and `openai-codex` here, and one agent's record carried `chatgpt-plus-pro/chatgpt-plus-pro/openai-codex/<model>`; the import now translates them (daemon/model-handle.ts), the daemon repairs an agent record at start and a chat's model on its next message. The keychain's list of providers had a lost-update race when two providers were saved at once; the list now has a queue of its own** (c366d88)
- **agents: you write a new agent's persona; the personality presets are gone — Welcome and New agent replace the preset picker with a Persona box, in your own words, which starts the agent's memory (system/persona.md; without one, "I am <name>."). The presets never reached the agent on loki's daemon, and neither did the description: the agent was made as "New agent" and renamed after, so its memory began "I am New agent."; now chat_agent_create takes the name, description, persona and model in one request. The name placeholders and a few comment examples use generic names** (fe460f3)
- **shell: the root move's note names what still uses the old path** (a5c7057)
- **comments: describe loki's own daemon, not Letta (plan 017, U15) — comments, JSDoc, frame descriptions, test titles and a few error strings no longer describe Letta's app-server, its tunnel, ~/.letta paths, the `letta` CLI or Letta's mod API as what runs: they name loki's daemon, the mod hosted in it, ~/.loki and ~/.agents/skills, the mod's chat frames and FrameChatClient. Comparisons with Letta stay where they explain a shape the import carries over (agent layout, reflection counters, attachment tags, AskUserQuestion); "as on Letta" asides and stale notes (the /appserver upgrade, the mod shim, Letta Code from npm in the cask, the writer's <recall>/writer folder) go. "not connected to the app-server" and the dropped-link detail now say loki's daemon. No behaviour changes.** (ab9ae76)
- **cutover leftovers (plan 017, U15) — `bun start` waits for the mod inside loki's daemon and points at the daemon's log, with nothing about installing Letta; the slash commands offered are the daemon's four; Letta's mod facade and the advertised-commands merge are gone; the agent presets, the environment note, the frame descriptions and two error messages no longer name Letta; Vite, the listen helper and skill refresh commits default to ~/.loki and loki.local; the trial write-up names no agent of the person's, and the plan records where stores and memory actually live** (e2eff41)
- **docs: loki on its own daemon (plan 017, U15) — the docs describe what now runs** (40e686f)
  docs/architecture.md is rewritten around the processes that actually run: the Rust shell supervising one Node
  daemon (restart with backoff, a lockfile so one serves, death with loki), the daemon's pieces (pi-durable stores
  per agent, keychain providers, approvals, tools, skills, subagents, background and scheduled tasks, reflection, the
  mod registry, ChatProjection, the import from Letta), loki's own mod and its two ports, the one frame protocol, a
  message's path, ~/.loki on disk and where each piece lives in the repo; it cites the trial's headline numbers.
  README drops the Letta install and attach steps for Node 22.19+, git and optional bd, keys in the keychain and
  ChatGPT sign-in, and adds a short "Coming from Letta" section on the import. GLOSSARY's sources become stored
  entries and the stream, and gains Daemon, Agent store, ChatProjection and Mod. PRODUCT and package.json's
  description stop naming Letta Code; the skill's widget path is ~/.loki/widgets, the old path noted as a link.
- **mod, core and daemon: loki runs only on its own daemon (plan 017, U15) — the mod is hosted on loki's mod API directly (activate(api, { chats, chat })), so Letta's facade, mod API types, gate and app-server finder are gone, with the /appserver tunnel, the config frame and the seen frame's app-server flag; the app's chats always go through the mod's socket (FrameChatClient), and Letta's AppServerSocket, its transports and the history fallback are gone from core. Letta's disk readers go: the chat source, the folder scan, the permission-mode, recent-model and pins files, the Learn worker's app-server ask and lesson start and writer folder; the log reader the import is checked against moves to daemon/import/letta-log.ts, and Letta's event adapter, which loki's live-chat and thread tests are written in, to test/fixtures/letta-events.ts. Everything loki keeps defaults to ~/.loki (LOKI_DIR overrides); global skills are read from ~/.agents/skills; skills install into an agent's memory from a GitHub path or URL, a git URL or a folder, committed, instead of through `letta install`; a chat's permission mode comes from the daemon. A tool's Letta-style error result is a failed call. The trial times the daemon alone (Letta's numbers stay in docs/research), CI runs the Node tests, the cask zaps ~/.loki, and the shell's supervisor tries again every 30 s when another daemon held the folder instead of giving up** (eb82f6e)
- **app: loki's own screens, no Letta (plan 017, U15) — Welcome's first step is no longer Letta Code: when the daemon could not start it shows the Node step (no Node 22.19+, with this system's install line) or the reason and the daemon's log, each with "check again" (retry_daemon); otherwise the provider and agent steps as before. bootstrap.ts becomes useDaemonStatus over daemon_status, asked again every few seconds while it reports an error. Settings' Letta page becomes the loki page (a saved "letta" page opens it): the version and update, the import from Letta, the mod, Requirements (the Node the daemon runs on, bd, the system) and Install (mod, phone canvas, skill; no shim, no reload note); the harness, app-server, scratch folder and Letta Code version, CLI and update facts go, with useScratch.ts and core/compat.ts and its test. useHarnessFacts reads the new install_status and tool_status and no longer asks for an app-server address. Provider keys are said to be kept in the keychain, and the terminal note for sign-ins (letta connect) goes, as the daemon signs in through the browser. The phone's presence dot follows the mod's socket alone, which the chats ride now; its connection page shows one link and About drops the Letta Code row. The remaining Letta and app-server wording the app shows is reworded to loki or the daemon, and loki's folder reads ~/.loki** (8906e62)
- **shell: loki's daemon is the only harness (plan 017, U15) — the shell no longer looks for, installs, updates or launches Letta Code, and no longer holds an app-server socket: appserver.rs (the link, the probe, Desktop and `letta server` discovery, attach/launch/replace, port 41600, LOKI_APP_SERVER_URL) and scratch.rs (LETTA_SCRATCHPAD and its settings) are gone, with the appserver_send, appserver_url, bootstrap_status, install_letta, check_letta_update, update_letta, scratch_settings and set_scratch_dir commands, the LOKI_BACKEND switch, `letta backend local` and `letta server`. What the daemon's supervisor needs from the process list moved to procs.rs (no listening ports any more, so no listeners crate); bootstrap.rs became node.rs, finding Node and saying what is missing when none is new enough, and find_node_program now hands back that NodeMissing. The root moves to ~/.loki first thing on every launch, before the token is read. The daemon always starts; daemon_status reports the Node it runs on, why it could not start and the NodeMissing for Welcome, and retry_daemon (Welcome's "check again") looks for Node afresh and starts it when no supervisor is watching one. install no longer writes a shim to ~/.letta/mods (Report loses shim and needs_reload, Tools loses letta); the mod and daemon bundles, the phone canvas and the skill are installed as before, and a dev build links only the skill, its daemon running the checkout's daemon/main.ts with mod/boot.ts. tokio-tungstenite, futures-util and http go from Cargo.toml with the link** (c8b86a7)
- **daemon: sign in with ChatGPT — both of pi-ai's ChatGPT sign-ins failed before the browser could finish: "Sign in with ChatGPT" (openai) needs a stable id for the install, which the daemon now keeps in state/device-id, and asks for a pasted code alongside the browser, which loki's prompt refused, ending the sign-in at once; the Codex sign-in (openai-codex) first asks how to sign in, which loki also refused. Now the browser is chosen, the pasted-code prompt waits while the browser's callback finishes the sign-in, and Settings › providers shows "waiting for the browser…" with a field for the address the browser ended on, for when its callback cannot reach this machine (chat_provider_signin with `code`). A new sign-in to a provider replaces one still waiting, and one left waiting gives up after ten minutes; loki introduces itself to OpenAI as loki** (83b13a4)
- **frames: an approval or question answer on the daemon names its approval `approvalId` and its question `questionId` — both frames carried the approval's id as `requestId`, which the app's request spreads over the frame's own id, so the daemon applied the decision but its reply went unmatched and the app waited out 25 seconds and reported a failure** (204b107)
- **daemon: a failed reflection pass no longer stops the daemon, and imported history does not start passes — a pass that failed (the model left it unanswered) escaped its timer as an unhandled rejection and ended the process; it is now reported and the daemon carries on. Imported chats looked like a stretch of new answers, so each would have been reflected on whole once quiet; the import now tells reflection each chat's history is already read (Reflection.markReflected), so only answers given since count** (890ffd6)
- **daemon: the one-time import from Letta (plan 017, U14) — daemon/import/letta.ts brings over the person's agents (a record and a memory folder, helper agents left out) with their memory repos and git history, and every conversation of theirs as a chat under its Letta id, so widgets, Inbox marks, pins and board stamps keyed by those ids still find it; archived, hidden, title, created date, model, the folder (the desktop's cwd map, else Letta's, else the log's) and the permission mode come along; Learn's cursors, which counted log lines, become entry counts that resume at the same message; API keys and the ChatGPT sign-in go into the keychain under pi-ai's provider ids, Anthropic's subscription sign-in is skipped and said so; active schedules of those agents and Letta's pins are copied once. It refuses while Letta runs and names the process, never writes to Letta's files, and runs again safely: what it finished is recorded, and a chat the daemon has written to is left alone. Settings › Letta has an Import row on the daemon (chat_import). Letta keeps no reflection settings on disk, so there are none to carry. The Rust shell moves loki's root from ~/.letta/loki to ~/.loki on the daemon, before anything opens a file in it, and leaves a link (a junction on Windows) at the old path, so every path that still names ~/.letta/loki resolves** (44587cf)
- **daemon: loki's tools, canvas and Learn on the daemon (plan 017, U13) — Learn's ask runs in process on the daemon, in the agent's hidden writer chat (recall-<agent>), made once in the home folder, compacted after each ask and left alone by reflection, its whole reply handed back; a lesson's [Learn] chat is made in process too, the card and the lesson record shared with the app-server path; a Letta-shaped tool result with status "error" now reaches the model as a failed call with its message, not as JSON. desk_state, loki_camera and loki_task already ran through the facade with the calling chat and agent, gestures already rode the person's message, Learn's cursors were already entry indexes, and a composer image already reached the model as a pi-ai image part (now tested), so core/attention/content.ts is unchanged** (e79e418)
- **daemon: web search (plan 017, U12) — web_search reads DuckDuckGo's plain HTML results, no key needed, which is what Letta Code's web_search used (pi-ai has none of its own): titles, real links through DuckDuckGo's redirect, and plain snippets, ads left out, the first eight handed to the model numbered; plan 017's open question on the backend is answered there** (606f0ea)
- **daemon: background tasks and scheduled tasks (plan 017, U11) — bash_background starts a shell command that outlives its turn; TaskOutput reads its output since last read, write_stdin writes to it, Monitor waits for a pattern or its end, TaskStop stops it, and when it ends its chat gets a <task-notification> the thread shows as an event row, which starts the agent's next turn; the processes are the daemon's and end with it; schedule_create, schedule_list and schedule_delete keep cron schedules in a timezone in one file in Letta's record shape, checked once a minute, a slot missed while loki was closed firing once, and a fired prompt begins "Scheduled task" so the Inbox ranks it as the schedule's. Chosen over the plan's pi-durable timers: one small file, visible, and the import carries Letta's crons over as they are** (f76ca2d)
- **daemon: skills, helpers, file tools and commands (plan 017, U10) — every chat now has pi-durable's own tools (read, write, edit, bash) and loki's ls, find, grep (ripgrep when there is one) and view_image; the agent's prompt lists its skills, its own and the global ones, and the Skill tool loads one's whole text as Letta's did, while the chat folder's AGENTS.md (or CLAUDE.md) is a section of its own; the Agent tool hands a task to a helper in a child conversation the call owns, carrying the chat's identity and mode so its approvals ask where you are looking, and a helper cannot start helpers; /compact, /clear, /remember and /reflect run on the daemon through one chat_command frame, shown in the thread as they run, and the palette offers only those of the harness's; global skills are linked in and out of the global skills folder as before; memory tools, Skill, Agent and view_image never ask on their own (GLOSSARY.md)** (49a248d)
- **daemon: an agent's memory and reflection (plan 017, U9) — daemon/memory.ts puts the agent's memory in its prompt as one section (its system/ files in full, or its top-level markdown files without that folder, the rest listed by path) and gives it memory_read, memory_write and memory_edit, each change a commit by the agent, or by Reflection in a pass, kept inside the repo; daemon/reflection.ts runs a pass once a chat has been quiet and the trigger is met (enough answers since the last pass, or a compaction), in a hidden chat offered only the memory tools, and keeps each chat's counters in the state file the Agents page already reads (LETTA_TRANSCRIPT_ROOT points at the daemon's); the frames gain the reflection settings, /reflect and memory-file edits from the Agents page, committed as yours. Not built: Letta's explicit merge, where a pass's changes wait for your OK; a pass commits directly, as "auto" does** (31951b6)
- **daemon: model providers and their keys in the system keychain (plan 017, U8) — daemon/credentials.ts is pi-ai's credential store over the keychain (one entry per provider, and an index naming them), its changes one at a time per provider so a token refresh and a sign-in never overwrite each other; daemon/providers.ts lists pi-ai's providers in the shape Settings › providers reads, keeps an API key once the provider accepts it, forgets it on disconnect, and signs in through the browser (ChatGPT among them), Anthropic's subscription sign-in left out because pi-ai presents itself as Claude Code for it; the frames gain the provider requests, and the app's frame client opens a sign-in page and waits for the provider to connect; the daemon bundle ships the keychain's native binding beside daemon.mjs, and install copies the daemon's whole folder** (28cf22a)
- **daemon: approvals, permission modes and question cards (plan 017, U7) — daemon/approvals.ts is one pi-durable extension every chat selects: before a tool runs, the chat's mode (strict, standard, acceptEdits, unrestricted, as the app describes them; GLOSSARY.md) decides whether the person is asked; the ask goes to every client following the chat and the first answer wins, a stop withdraws it, the decision is kept in the tool task's memo so a resumed turn does not ask twice, parallel calls each ask on their own, and an edit inside loki's widget folder never asks; daemon/ask.ts is AskUserQuestion, whose card and answers have Letta's shape; the frames gain chat_approve and chat_answer, chat_open sets a chat's mode, a client that opens a chat late gets what it is waiting on, and the mode is kept with the chat** (5bc28ec)
- **shell: the daemon starts on the node program itself, not the folder that holds it (plan 017, U3) — bootstrap::find_node gives Node's bin folder, and spawning a folder failed with Permission denied the first time the window ran on LOKI_BACKEND=pi; find_node_program gives the node beside it** (561e7bd)
- **attention: the app talks to loki's daemon through the mod's own frames (plan 017, U5) — useAttention takes a ChatClient (core/attention/chat-client.ts): Letta's app-server socket, which now reads its events as chat events, or FrameChatClient over the mod socket's chat_* requests and chat_event pushes, chosen when the mod says the daemon serves chats (config `chats: "daemon"`), on the Mac and the phone alike; the client remembers each chat's agent and asks the chat list for the rest; what later units bring (approvals, providers, memory edits, skills, commands) answers that it is not on the daemon yet; a folder change is answered by a device event or an error in either backend's events** (ef7ab89)
- **daemon: chats over loki's own frames (plan 017, U5) — the frame table gains what the app asked Letta's app-server for (open a chat and follow it, create, send, abort, rename and archive, folder, model, the models on offer, and the agents: list, create, update, delete) and one chat_event push; mod/frames/chat.ts answers them through the chat backend the daemon brings (under Letta, the app-server's, so each says so), and the mod tells every socket what happened in an open chat; daemon/chat-backend.ts serves them from the stores: a chat a client opens is followed through pi-durable's events, the person's message passes every mod's transform (the canvas rider) and waits its turn when the chat is busy, a message sent again with its sendId goes once, a new agent comes with its main chat, and deleting one removes its store and memory; the phone may send the chat frames it reached through the tunnel; the daemon offers every provider pi-ai knows, keys from the environment until the keychain** (f1be893)
- **daemon: a chat's pi-durable events as loki's chat events (plan 017, U5) — daemon/chat-events.ts turns a run's start and end, your message, the answer's words as they stream, its tool calls and their results, and a failed task into ChatEvents, what the daemon will push to every client watching the chat; it remembers how much of the answer it has sent, so an answer committed whole with no piece first still arrives, once; a real run folded through applyChatEvent reads as the thread the app shows** (0c07875)
- **attention: a chat's live events in loki's own words (plan 017, U5) — ChatEvent names what happens while a chat runs (an approval or question, its mode and folder, running or idle, a piece of the thread, an error, a slash command, the reply settling, the turn ending) and applyChatEvent folds one into the chat's live state; Letta's app-server events are read into them by lettaChatEvents, and applyEvent is that adapter followed by the fold, so every existing test still pins the behaviour, and the daemon's pushes will feed the same fold** (b56f877)
- **daemon: agents and their chats in loki's own stores (plan 017, U6) — each agent's store opens once and is shared, and one that closes on its own (a storage error) is opened again while the other agents' chats run on; agents keep the layout Letta's backend used under the daemon's backend folder (record and memory repo, with a first commit), so the mod's agent and memory readers find them through LOKI_BACKEND_DIR; daemon/chats.ts keeps every chat as the mod reads it (details, thread, Inbox digest, folders, model) loaded when a store opens and followed through its commits, so the mod still asks and is answered at once, and Learn's cursor counts entries; the mod reads chats through mod/chat-source.ts, Letta's disk or the daemon's stores, and its Letta helpers honour LOKI_BACKEND_DIR throughout; the shell silences only Node's notices about its experimental SQLite** (ee81e41)
- **daemon: loki's mod API, version 1 (plan 017, U4) — a mod adds tools (JSON Schema parameters, as before), prompt sections, a say before a tool runs, a transform of the person's message, and listens to turn events; daemon/mods/registry.ts turns each mod into one pi-durable extension in the registry every agent's store shares, so one load reaches every chat with loki's own chat and agent ids, loading a mod again under its name undoes the old copy and installs the new one for the next step, and a mod built for a newer API, or one that throws, is reported and changes nothing else; mods load from the mods folder beside the daemon's state and reload when edited; loki's own mod keeps the Letta API it was written for through a facade until the cutover, and a checkout's copy reloads when its sources change** (256878a)
- **daemon: the shell starts loki's own daemon in place of `letta server` when LOKI_BACKEND=pi (plan 017, U3) — daemon/main.ts holds a lock on loki's folder (a second daemon exits with code 3 and the shell leaves the first serving) and hosts the mod as Letta did, so the canvas, board, Learn and the phone listener run in it; the shell restarts a daemon that dies, one second doubling to thirty, never one it stopped itself, and stops one a crashed loki left behind, known by its --loki-daemon command line and token file; build:mod bundles daemon.mjs beside the mod and install puts it in <data>/daemon; a development build runs the checkout's sources with Node's type stripping. The process snapshot now records each process's parent, which the rule that a running loki's own harness is never stopped needed and never had** (49cbda0)
- **daemon: the timed trial passes plan 017's gate (U2) — on the same model, provider and prompts, the pi-durable daemon's median time to first token is 1,375 ms against Letta's 2,651, its harness overhead 7 ms against 101, and its gap from a tool result to the next request 1 ms against 23; the event loop's 99th-percentile delay with three chats streaming is 8.3 ms, so each agent's store stays on the main thread; daemon/timing.ts measures either backend the same way, scripts/trial.ts drives both, and docs/research/2026-10-pi-trial.md holds the numbers and what they do not show (part of the first-token gain is the daemon's shorter tool list; cache retention was not compared); the kernel lists chats without awaiting each in turn** (646ab0c)
- **daemon: the first piece of the Pi harness (plan 017, U1) — daemon/kernel is the one module that touches pi-durable: an agent's store on one Harness, chats found by loki's own ids through an index document, and Letta's conversations written in as the entries pi-durable's own tasks would write (user, assistant, tool result, compaction with its head); a reply Letta left off its main path stays in the thread as a branch entry the model never sees; core/attention/pi-steps.ts reads pi-ai messages into thread steps for both Letta's log and pi-durable's entries, so the mod's log reader uses it too; all 115 of this Mac's conversations import with the rows the mod shows today and continue (scripts/pi-import-check.ts), and a turn killed mid-stream or mid-tool resumes after a restart, the tool reported as interrupted rather than run twice (bun run test:node)** (5591bda)
- **docs: plan 017 moves loki off Letta onto its own daemon built on Pi's pi-durable — one Node process supervised by the shell, one SQLite store per agent, loki's frame protocol to every client, a versioned mod API, crash-resumable turns, and a one-time import of Letta's agents, memory and conversations; a timed trial against Letta gates the port** (99ce287)
- **frames: review fixes — a frame whose parser throws is answered like any failure (a request still gets error with its requestId), a reply that comes after its request timed out is dropped quietly instead of logged as an unknown frame, the app reads an answer through one tested requestResult(), request() has one doc comment, and three unused exports go (review #1 and its residual risks)** (f8f258e)
- **frames: the protocol is pinned by walking the table through the real router — every request and send answered by exactly one module (a missing one is caught), every request answered with its requestId under its reply name or as error, every send's smallest frame accepted, every frame not marked for the phone refused to one; the architecture doc points at core/frames.ts and no longer lists the snooze frames that were removed (U7)** (bbebe91)
- **frames: the app is typed by the table too — send() takes a send by name with its payload, the push switch narrows on the table's pushes, request() reads only the one error frame, and the app reports only the engagements the mod cannot see itself (answer, decide, skip); a request missing a required field no longer compiles (U6)** (b24d8b9)
- **frames: the agents pages and the phone listener answer from their own handler modules, and the bridge is only the router (696 lines to 82): it takes the modules mod/frames/index.ts builds from each feature's own dependencies and the frames a socket is welcomed with; an agent page whose memory cannot be read and a listener refresh that fails now answer error instead of nothing; sortDesks lives with the desks handler (U5)** (904e106)
- **frames: history and the Inbox, folders, Learn and the board answer from their own handler modules; each Learn frame has its own handler (no default that answered recall_export), their failures arrive as error, and a folder picker that rejects or a lesson that cannot start now says why instead of going quiet (U4)** (89f4b8f)
- **frames: the canvas, the seen marks and analytics answer from their own handler modules (mod/frames/desks.ts, seen.ts, capture.ts); the seen push is built in one place, the turn-start mark included, and a malformed canvas frame now answers an error push instead of vanishing (U3)** (d70ce66)
- **frames: the bridge routes through the table — a paired phone is held to the frames marked for it, a frame is parsed before its handler sees it, and every request is answered: its reply under the table's name, or one error with its requestId when it is refused, malformed, failed, thrown or rejected; the app delivers an answer by its requestId (REPLY_FRAMES and its regex test go) and request() is typed by the table and returns { ok, reply } or { ok: false, error, timedOut } without throwing, so a refusal reads at once instead of after a timeout (U2)** (b7e713f)
- **frames: core/frames.ts declares every /ws frame once — each request with its reply, each send with the pushes it causes, each push — with whether a paired phone may send it and a parser that keeps the bridge's checks; isAgentId, isLanVia and isGesture live there for both sides (U1)** (4649d48)
- **frames: the shapes frames carry live in core/frame-types.ts — desks, Inbox rows, tasks, agents, memory and skills, folders, the phone listener and its devices — so core can name them; the app's second copies of DeskStatus, DeskSummary, LanVia and TailscaleStatus go, and scopeOfId has one home in core/desk-core.ts** (c2332f5)
- **docs: GLOSSARY.md names the frame protocol (frame, request, send, push, frame table, frame handler) and an open call reaches into the last page; plan 016 declares every /ws frame once in core/frames.ts** (5174cba)

## 2026.10.9

- **threads: a reload no longer drops a message that repeats an older one ("yes" sent while the page was read stays; a row since the last page pairs only with a page row newer than that page); a picture you sent pairs with the page's [image] row instead of by the sending device's clock; an approval after a load took its call still belongs to that call; tool rows keep their borrowed times on a second load; the Learn worker's read from a cursor has its own test (review #1 and its residual risks)** (dc67d0a)
- **threads: a picture sent alone is not shown twice (its echo, now an [image] line, is known by an empty key); a reply's first empty piece still counts as the agent speaking; folding a long log stays linear — a result replaces its row in place, the load's text index grows by push, and a fold hands back its rows without snapshotting them** (1b36f0c)
- **threads: one ThreadModel builds every chat's rows — the local log, the app-server's history and its live stream are parsed into steps and folded the same way, so a chat reads alike on the desktop, the Inbox card and the phone; an approval request belongs to the open call of its tool (a second call of the same tool straight after the first keeps its own row and result), a tool's label and input pick the same argument, and a history page keeps the live rows it does not hold only while they are pending or newer than it, so a row that streamed in during a reload, a queued message and a running command are no longer lost, and an answers row Letta never echoes does not linger; the Learn worker reads the agent's whole reply from the thread** (d4848df)
- **docs: GLOSSARY.md names the thread's parts (ThreadModel, step, source, tail, the load rule, open call); plan 015 moves every chat row into one module** (6697c8c)
- **inbox card: an idle chat shows no badge — its empty label drew an empty pill, a small circle in the corner** (e493ecf)
- **new agent form: one 96px label column so every field starts at the same edge (Description was clipped, Personality ran into Tutor), labels level with their field's first line, the buttons under the fields, no repeated title, Model in the text face; previews: the agent list and the phone's Home show a message's first line without its markdown marks** (d247ee6)
- **inline widgets: the no-op handler is a module constant (react-doctor)** (d0ee016)
- **tool steps: one line per skill — the Skill call is named from its `skill` argument and dropped when the skill's body follows in the same stretch** (f2f8321)
- **widgets live in the thread: under a widget's latest row the widget itself is drawn (the canvas's kit component or module, no frame), usable in place; the desk's chat, the Inbox card (desk_get asks the mod for that chat's widgets) and the phone (kit widgets read only, modules say to open the Mac) all draw them; a gesture from another desk's thread is recorded for the widget's own desk and its state echoed back** (7528444)
- **chat list: helper agents (role:subagent) stay out — the disk scan re-added the subagent chats listDesks had just evicted (their agents have memory folders), so friday's helpers (Rocky, RK800, Kerrigan) showed as agents in New chat** (2ff9e83)
- **tool steps know Letta's Codex-style tools: exec_command is a command and shows its `cmd` (it showed the description as its input), ApplyPatch and memory patches are edits, web_search searches, SendAgentMessage asks an agent, UpdatePlan updates the plan** (1f52d46)
- **tool steps: one flat list when a stretch opens — every step in order, tools included, with reads, edits, searches and skills in a quieter style; no summary lines and no second level** (d3faa02)
- **tool steps: a housekeeping line ('Read 3 files · searched twice') opens to list each of its tools, each opening its input and output; 'Files and search' lists them all; the phone's sheet does the same** (c474247)
- **tool steps: the filter chips are a module constant, not rebuilt each render (react-doctor)** (5e2aac9)
- **chats: a stretch of the agent's work is one line — tool calls, background-task notices and skill loads between two messages fold into 'Worked 14 min · 10 background tasks, 3 commands, 11 tools · 1 failed', the last failure named under it in red; opened inline, named steps are a line each with the housekeeping between them as one muted line, chips filter a long stretch, and a step opens its detail under it (a bottom sheet on the phone)** (9743ffe)
- **chats: older rows loaded above don't count as new — the '↓ N new' chip's mark moves with them** (1b0bea9)
- **chats scroll back past their first 400 rows: history_get takes a limit and says whether older rows remain; reaching the top of a chat asks for 400 more (up to 20,000), and the rows that arrive above keep the window and the reader in place** (614f6b5)
- **inbox focus: Next on a card shown for its focus halves that chat's weight (not a Next straight after acting on it), so a chat you have finished with gives way after a skip or two instead of holding the top for hours (29 Sep: one chat skipped 6 times at rank 1–3 over 2.5 h)** (c5c341d)
- **harness under Node, readable failed turns: loki runs letta-code's letta.js with the runtime's Node off Windows too (since 0.34 the letta shim picks Bun when installed, and Bun's fetch drops the model's streamed answers: 'The socket connection was closed unexpectedly'); a failed turn reads as one sentence with the raw error behind 'details', and offers Send again (unanswered message) or Continue (cut off partway)** (cd427fb)
- **bun start: the phone's build watch prints errors only, so its chunk-size and dynamic-import warnings don't repeat on every save** (88e057d)
- **bun start keeps the phone's app current: a watching vite build rebuilds app/dist on every change (without emptying it first, so the phone is never served a half-written build), and the phone offers a reload** (8d3a353)
- **listen (experimental): a Mac call recorder for loki — the call apps' audio through a Core Audio process tap as Them, the microphone (echo cancelled when macOS lets it start, else raw) as You, both transcribed on the Mac with SpeechAnalyzer into ~/.letta/loki/calls/<time>.md; bun run listen execs the built binary so Ctrl-C reaches it, and a stuck finish closes the transcript after 8 s** (f16a974)
- **files on messages: the failed-upload line reads its upload once, without non-null assertions (react-doctor)** (d3912bf)
- **files on messages: any file can be attached (+, paste, drop, Mac and phone); images still ride inside the message, anything else uploads to the Mac at once (POST /uploads on both listeners, 25 MB, ~/.letta/loki/uploads/<day>/) and goes as Letta's own attachment tag, which the chat hides and shows as a file chip** (e852c09)
- **tool steps: a command the agent described reads by its description, as Claude's apps show it: the step's line, a Description section above the command, and 'Ran <description>' for a run of one; commands without one read as before** (f76c762)
- **environment note: a chat's first message carries it in full; after that only when the agent's picture would be wrong (30 minutes on, a new local day, another time zone, the chat renamed), short: the time and a new name. Queued messages decide it when they go out, so their time is never stale** (7fbc26d)
- **board tasks: the <loki-tasks> block rides along only when a chat's list changes (assigned, closed, edited, started), not on every message; once when the last one leaves; again after compaction; the chat hides it behind a quiet 'board tasks' row** (f42a364)
- **copy: the last 'desk' words on screen go — the empty Canvas reads 'Nothing on this canvas yet', the phone's archive counts chats, and ⌘K's old desks-tree note leaves the shortcuts list** (0de605e)

## 2026.9.28

- **model picker: More models scrolls on the desktop — the body's rows take their content's height, so the clipped card no longer shrinks into the capped popover** (799fa7e)
- **model picker: recent models are least recently used — a message into a chat moves its model to the front, as picking one does** (a5a491f)
- **inbox: an approval is logged once, not again as next; only a turn you typed counts as a message for focus** (163458c)
  The desktop deck's onSeen now carries what moved the card, and only a plain Next is logged as next.
  The mod's turn_start check moves to personTyped (core/harness.ts): harness markup stripped, empty turns
  and scheduled prompts are not you.
- **phone inbox: Open chat replaces Archive under the card; archiving moves to the chat's actions sheet, for any chat but a main one** (35d146f)
- **inbox: archive sits beside open chat on the desktop; on the phone a left swipe no longer archives — only its button does** (c3290e8)
- **inbox: one Next (⌘]) and Archive (⌘E); snooze and Later are gone; Mark as done becomes Mark as read** (fc2a82e)
  A chat is done only when archived, so moving on is one action: Next reads the chat and moves on, and the chat
  stays for your next visit. Archive (E, the phone's left swipe) is done, with undo; a main chat and an
  approval refuse it. The snooze ladder, its setting, the snoozed toggle and the phone's Later section are removed,
  in the app and the mod (attention.json keeps seen, viewed and focus). "Mark as done" in the chat menus is now
  "Mark as read".
- **inbox: every chat you have not archived, except one mid-turn; a "new" term in the score; the pass counter goes** (844e104)
  A chat is not done until it is archived, so the Inbox holds every live chat and the score separates what has
  something for you (blocked 100, new 10) from what rests (focus, age). Badges and "need you" still count only
  what needs you. The header reads "N need you · M chats"; the progress bar and "left in this pass" go.
- **inbox: rank by focus, learned from what you do — each chat's share of your recent engagement, fading by half every 12 hours; warm and reply-to-you retire, a failed turn is no longer blocked** (5276f3b)
  Your messages (any surface, the terminal too, never a scheduled prompt), answers, decisions and reads add to a
  chat's weight in the mod (state/attention.json focus), so the Mac and the phone rank alike; the score is
  blocked 100 + 15 x focus share -/+ 0.1/h. Every Inbox decision is logged (inbox_card_decided: action, rank,
  score, focus, reason) and bun run analytics reports engagement, the metric the weights will be tuned for.
- **tests expect Chats in the sidebar and rename dialog; sheet and edge-swipe gestures clear their pending timers and click guard on unmount (React Doctor on #19)** (0ad477c)
- **words: desks are now chats, and a chat's widget surface is its Canvas tab** (2af9cef)
  The Mac's Desk menu is now Go (Arrange Widgets and Undo Widget Move moved to View), and /desks is now
  /chats. Search still finds "desk"; the loki skill tells agents the old word means the same. Internals
  (code, wire frames, keymap ids, files on disk, analytics events) keep the old name.
- **phone: a compose button on Home starts a new desk, Slack's, over the list above the tab bar; the load notice goes once a slow start renders** (0ae07df)
- **phone rename and inbox agent pills — rename a desk from its actions sheet on the phone; the desktop Inbox filters the pass by agent** (44c2ebf)
- **composer: Stop while the agent works — the empty box's send becomes a stop button that ends the turn so you can take over** (87cb970)
  Through the app-server's abort_message (an approval the turn waits on is
  interrupted too). "Stopping" until the harness reports the turn's end; a
  refused stop brings the button back. Typing brings send back (it queues).
  On the desk, the desktop Inbox card, the phone's conversation and its cards.
- **messages: each message's time sits beside its copy button, under it; the name and the gutter carry none** (427c4fc)
- **messages: copy under every message, yours and the agent's; on the phone a long press opens Copy and Select text** (3c2c7ea)
  The desktop's hover toolbar goes: each message carries its copy button under
  it, faint until the row is hovered. The phone had no copy at all; now the
  button is always under each message, and a long press opens a sheet with Copy
  and Select text (the message on its own, where selection works). A finger
  that moves, a scroll or an Inbox card swipe, is not a hold.
- **model picker: quick picks are the models you used lately, then featured ones, only ones you can reach** (11b6a7b)
  The short list led with the harness's featured models, the same for everyone.
  Now: loki's own picks, newest first (the mod keeps them in
  ~/.letta/loki/state/recent-models.json, shared by the Mac's windows and the
  phone), then Letta Code's recentModels (read, never written), then featured
  models up to five; list_models' available_handles drops what the account
  cannot reach from the quick picks (More models keeps everything); the current
  model stays in view.
- **phone learn: its lists, each a page — Review, Leads, Lessons under way, Deleted; leads start from the phone** (b334e02)
  Learn opens on a list, as the desktop's column does; the deck and the leads
  never share a screen. A lead offers Start the lesson (the conversation opens,
  the brief goes out), Not this and Where it came up; a lesson with no brief
  offers to send it; Deleted brings back cards and leads. The mod lets a phone
  start, set aside and restore leads.

  Fix: the app never resolved the mod's recall_lesson reply, so Start the
  lesson waited a minute and said it failed, on the desktop too. The replies
  are one exported set now, checked against what mod/bridge.ts sends.
- **motion: waiting has a shape, Learn cards turn and fly, the desktop moves quietly** (b7c06f3)
  Phone: placeholder rows and cards shimmer while a list is read; the caught-up
  check springs in; the Mac-unreachable banner slides down and back up; the
  message box rides with the keyboard. Learn: a card turns over to its answer,
  is thrown right for Got it and left for Again, and the next rises in.

  Desktop: popovers grow from their pill on a click; a clicked desk switch
  fades in; badges spring in as their count rises; the camera glides on the
  smooth spring and stops for a wheel, pinch or drag; a rewritten widget glows
  once. The chip row, switch knob and catch-up bar move by transform; the chat
  width changes at once. Nothing a key starts animates.
- **chat: tool calls as Claude's apps show them — one quiet line per run, a sheet of steps, each step's command and output** (63ffa06)
  1. A run of consecutive tool calls is one line in the thread: "Ran 3 commands", "Ran a command, used 9 tools (1 failed)", "Running" breathing while the last one waits on its result.
  2. On the phone the line opens a bottom sheet: the steps on a thin timeline, each its icon, a verb and what it was done to; a step opens its command (or input) and output in the same sheet, with Back. On the desktop the steps unfold in place.
  3. Tool rows keep a step (core/attention/transcript.ts ToolStep): the input a reader recognises in full, the output, whether it failed, the call id; both capped at 4,000 characters. From the live stream (the input fills in as its arguments stream; the result lands on its row), Letta's history (tool_return_message by id) and the local log (toolResult lines by toolCallId). The recall worker's rows stay text only.
  4. A terminal icon for commands.
- **phone: bottom sheets open once — focus lands without scrolling the shell under a rising sheet** (5e6ff23)
  A sheet focuses its first row as it mounts, while it is still below the screen; the browser scrolled the
  phone shell (overflow: hidden is still scrollable by focus) to bring that row into view, then the shell
  scrolled back as the sheet rose, so the page jumped and the sheet seemed to open twice. Focus now moves with
  preventScroll, and the shell is overflow: clip, which nothing can scroll.
- **phone home: folds saved outside the state update, under a versioned key** (968965d)
- **phone home: desks group as the desktop sidebar's — Pinned, then one folding section per agent** (53cac48)
  1. Home's desks come from shell/sidebarModel.ts, as the desktop sidebar's do: Pinned, then one section per agent by its latest activity, the main chat first, so the two cannot drift. "Needs your attention" stays on top, and a conversation there is not repeated below.
  2. Each agent's section has its face and name and counts what waits on you; folds are kept on the device; a filter opens every fold.
  3. The agent chips leave the Home menu: the sections are the agent view now. The filter stays.
  4. Under an agent a row does not repeat the agent's name, and the main chat is called Main chat; under Pinned the pin is not shown twice.
- **phone inbox: no stamps on a decided approval — it flies off like any card; the refusal shake stays** (1a18b71)
- **phone: swipe-back animates once — only the app's own Backs slide; the edge swipe is the home-screen app's alone** (1386f3d)
  Safari's swipe-back slides the page with its own picture, then the pop arrived and loki slid it again. A pop now
  slides only when the app asked for it (the back chevron, its edge swipe); the browser's Back lands still. In a
  Safari tab loki's edge swipe stands down, since the browser owns that edge.
- **chat: the new-message count clears on the scroll back to the bottom, not in the follow effect** (7e975e6)
- **phone motion: agents at work — streaming words fade in, arriving rows rise, lists glide, Undo springs, decisions are stamped** (bbfda36)
  1. A streaming reply's words fade in as they arrive (a rehype plugin wraps words while the turn streams; code stays whole).
  2. "thinking" is three rising dots, as a typing bubble's (shared chat.css).
  3. Rows that come in while a thread is open rise into place; history and rows revealed above do not. Scrolled up, the chip springs up and counts what is new.
  4. Home's rows glide when the arrangement changes (kit/useFlip.ts, FLIP on the compositor): keyed by conversation, so a desk moving into Needs your attention travels there; a row leaving fades while the rows below slide up. Not while a filter is typed.
  5. Undo springs into the top bar and shrinks away (kit/leave.ts); an approval decided flies off stamped with a check or a cross; a swipe it refuses shakes the card.
- **phone motion: Apple-style springs — sheets that follow a finger, pages that push and pop, the Inbox card zooming into its conversation** (18434d6)
  1. Three springs (smooth, snappy, bouncy) in kit/spring.ts, written into tokens.css as linear() curves by scripts/springs.ts; a finger's speed carries into the spring it lets go of.
  2. Pressed controls give to 97%; the send button and the inbox badge pop on the bouncy spring.
  3. Bottom sheets rise, follow a finger down, rubber-band up, and leave however they close; the screen behind recedes onto black.
  4. Pages push and pop through View Transitions; the Inbox card zooms into its conversation and back; a swipe from the left edge goes back. Tab switches and keyboard actions stay instant.
  5. The Inbox card flies off and springs home at the finger's speed, can be caught mid-spring, and its label pops at the commit distance.
  6. The progress bar fills by scale, not width.
- **phone: Select model opens as a full-screen bottom sheet from the Inbox card too — drawn at the phone's root, out of the card's transform, and its drags never swipe the card** (52c2578)
- **phone inbox: the card's box has the model pill; no "waiting for your reply" line on a plain wait** (3c99869)
- **releases: two release PRs tracking main — the Mac's and Windows and Linux's, sharing the day's tag** (09ee21b)
  Every merge to main refreshes release/next (the Mac stable) and release/preview
  ("release: Windows and Linux <date>"), both built from main. Whichever merges first
  creates v<date> (Windows and Linux's not marked latest, so the Mac's update check and
  cask stay on a release with a .dmg); the other joins it. Separate queues, so a waiting
  Mac stable is never dropped; a lost create race joins the release instead of failing.
  Windows and Linux find their update in the newest release that has their file.

## 2026.9.25

- **title menu: separators are <hr>, not role=separator divs** (8e950f9)
- **focus: text fields no longer blink — the caret shows them; the flash stays on controls** (dcabd63)
- **composer: typing no longer twitches the thread — the box keeps its height while the field is measured, before paint; a thread at the bottom stays there as the box grows a line** (276c5a8)
- **perf: long threads open with their newest 60 rows and grow as you scroll up; only the last row streams** (3146c82)
  - a window over the transcript (20 more rows near the top, place kept; the New line
    always inside it); find searches the text and loads down to a match; ↓ latest folds back
  - date and time formatters built once; per-row times cached
  - streaming goes to the last row only; live rows keep their identity until they change
  Measured: desk switch 128→19 ms (prod), phone open at 4× CPU 906→104 ms, rows
  rendered per 10 s stream 963→64.
- **perf: one viewed mark per streamed turn, the compiler back on the roots, no re-renders while idle** (339e630)
  - viewed marks wait for the turn to settle (or you leaving); the mod skips no-op marks
    and coalesces attention.json writes (250 ms, flushed on shutdown)
  - Shell, Sidebar, DeskSidebar, Paired, Home, SearchSheet, DeskTree and useAttention
    compile again (import() helpers, exact deps, try blocks the compiler accepts)
  - a repeated loop status is no change; repeated seen/desks/desk frames keep their objects
  Measured on a 10 s stream: viewed marks 62→1, commits 217→112; idle 30 s: 48→9.
- **composer: the permission mode sits beside the model pill, inside the box** (9082ac3)
- **composer: one rounded box on phone and desktop — +, the model pill, mic and send inside it; Select model as a sheet on the phone and a popover on the desktop, with Effort › and More models ›** (cd57d5b)
- **windows: CI's first Windows run — skill sources take C:\ folders; three Rust tests compare paths the way Windows writes them** (b2502de)
- **a harness loki left behind is restarted at the next launch, on every system — never one whose loki is still running** (7e1781b)
  Replaces adoption: the leftover (loki's own launch on 41600, its loki gone) is stopped
  while its start time still matches, the port waited on for up to 5 s, and a fresh
  harness started from the current Letta Code; still held, loki attaches as before.
  Linux starts the harness with the parent-death signal; Windows keeps its job object.
- **the page knows the host's system apart from the viewer's keyboard — the mod tells a LAN tab which system loki runs on; Settings and the phone say it plainly** (331f2f1)
  A Mac loki viewed from Windows Chrome no longer says "this PC" or hides Browse, and an
  Android phone no longer gets Linux's not-yet lines; keys still read the viewer's way.
- **windows/linux review fixes: publish every artifact file, not its folders; letta.js path joined per part; the harness's own address under a name only the mod reads, then removed; widget paths refuse drives and backslashes on Windows; parse_ps_urls quiet off the Mac** (2c51285)
- **windows/linux U11: docs for three systems and the preview checklist** (7b087c0)
- **windows/linux U10: releases carry the Windows installer and the Linux AppImage and .deb — a build job per system, one publish; the preview line in notes; the update check links this system's file** (5dbb8d6)
- **windows/linux U9: CI on macOS, Ubuntu 22.04 and Windows — test and shell jobs matrixed, WebKitGTK packages on Linux, tests made path- and link-portable** (f978155)
- **windows/linux U6: a running harness found on Windows and Linux — sysinfo and listeners beside the Mac's unchanged lsof/ps, an orphan of loki's own adopted there; the mod's port and gateway readers per system; PATHEXT and .cmd shims for its programs** (88660f5)
  Also: the beads hint per system, and the mod's home from os.homedir().
- **windows/linux U4: loki's own title strip — ☰ menu from menuSpec, minimise/maximise/close, one instance, XWayland, the webview's browser keys kept out** (a1fba51)
- **bootstrap tests: a fake home unique per call, not per microsecond — parallel tests shared one and deleted each other's files** (2b18c77)
- **windows/linux U8: words for each system — this PC / this computer, File Explorer, the release download for upgrades, no sudo on Windows, Minimise loki** (591a4b7)
- **windows/linux U7: the system's own folder dialog for Browse in the app; drive paths and ~\ in folder completion** (17587a8)
- **windows/linux U3: Mac extras only on the Mac — tray, badge, global key and menu compiled for macOS; not-yet lines for phone pairing and the system-wide key; Hide minimises elsewhere** (e1b597d)
- **windows/linux U5: Welcome's mono style at module scope** (906af6f)
- **windows/linux U2+U5: the page knows its system and keys read Ctrl; Letta Code and Node found, installed and run per system** (0b43134)
  U2: __LOKI__.os and env.platform; formatKeys per system; every shown key from
  the keymap (source scan guards it); Move Chat off Ctrl+Alt, no Alt+Space off
  the Mac; DeviceType windows/linux.
  U5: per-OS search (Mac order pinned), node + letta.js on Windows in a
  kill-on-close job with no console, LOKI_APP_SERVER_URL to the harness,
  npm view for the latest version, a Node-missing Welcome step, per-OS
  scratch line, dev.ts on Windows.
  One commit: both units edit lib.rs and Settings.tsx, and neither builds alone.
- **windows/linux U1: the shell builds off the Mac — OS random token, the platform's home folder, unix-only calls gated, junction fallback, LF checkouts** (d29accc)
- **plan 014: system-wide impact** (fde54a3)
- **plan 014: the implementation plan for Windows and Linux — eleven units, per-OS seams, CI on three systems** (782482d)
- **plan 014: loki on Windows and Linux — the requirements, as preview builds** (ebda46d)
- **focus flashes: a 2px blue ring that fades in a second, settling on a muted ring on controls and nothing on text fields** (1387409)
  A constant ring sat round the ⌘K field and every focused field as a box. Now the ring's colour animates from
  the accent to what it settles on, so reduced motion shows the settled state at once; the phone flashes in its
  link colour. Also: the day-pill test restored TZ by assigning undefined, which left Los Angeles in place and
  failed the later date tests whenever the machine's day and LA's disagreed.

## 2026.9.23

- **phone: archive leaves its busy state even if it throws; the fold memory is kept outside the state updater (React Doctor on #12)** (6c1b3d6)
- **docs: brought up to date with the Slack layout — manual, learn, README and its screenshots, architecture, design, contributing, security, the loki skill** (0cec5a9)
- **phone inbox: the swipe and button say Mark as done, like the conversation menu** (ea68b0e)
- **desk: viewed is not done — opening a desk un-bolds it, the ring and the Inbox card stay until you act or Mark as done (⌘⇧↵); phone and desktop share the look through the mod** (b92f331)
- **desktop: the Board says when its agent is gone and asks for a pick; Learn title, ⌘⇧D listed where it applies, Preferences list focus follows the page, the Agents profile's desks button** (fa5d751)
- **desktop desk: the rename dialog leaves Saving… even if the save throws** (7ce017f)
- **desktop desk: rename a desk from its row or header menu — Letta's conversation summary, set over the app-server** (dbe0683)
- **desktop: review fixes — menus close on any outside press, widget rows say who made the change** (9f2dcf1)
  The mod credits changes it makes itself (trash, the lesson card) to you or loki; a desk whose history
  has no times shows one summary row for older widget changes; day pills follow widget rows too; the
  New line falls back to turns; a vanished agent pick or agent board view falls back; blocked storage
  no longer crashes the column.
- **desktop: the assembled Slack layout checked end to end on fake data — fixes, the tree drawer's leftovers gone, docs** (a1d30fd)
  Opening the first-loaded desk works again, the thread no longer shows through other sections, the
  Inbox and Board fit at 1100, focus returns across tabs and menus, arrows move through the sidebar,
  the pane is the main landmark, and the keys sheet says what Command K used to do. design.md and
  manual.md describe the new shell.
- **desktop: Command K opens search — desks, agents, waiting items and pages, with recent places** (13198cf)
  It replaces the desk tree; the Board's assign-to-desk picker stays. A waiting item opens its desk on
  Messages. Message text is not searched, and the sheet says so.
- **desktop desk: a Slack sidebar of desks — Pinned, then one section per agent, Archived at the bottom** (8c3ad91)
  Find a desk, new desk per agent, pin and archive from hover or right-click, bold unread, red badge
  for what waits, and pills when a waiting desk is scrolled out of view. Scroll and folds are kept.
  The rail's Desk no longer toggles the tree.
- **desktop desk: widget changes appear in the conversation, by time, and open the Desk tab on the widget** (f02dfaa)
  The mod's log arrives with history and live; entries for other desks wait for them. A removed
  widget's rows say it is gone and do not frame.
- **desktop: Settings opens as a Preferences window over the app** (574ff75)
  Sections on the left in sentence case, the page on the right. The rail's Settings, Cmd+, and Cmd+6
  open it; Cmd+, and Esc close it; Cmd+1-5 close it and go; Cmd+[ ] step pages while it is up. Other
  dialogs still block shell keys.
- **desktop: the Agents, Board and Learn columns take their place beside the pane** (31dcc8c)
- **desktop desk: opens as a Slack channel — header, Messages and Desk tabs, one draft for both** (aa9dae5)
  Messages is the conversation in the Slack layout with a hover copy action; Desk is today's canvas
  and inset chat with the sidebar hidden, Esc returning to Messages. Every way into a desk lands on
  Messages with the composer focused. Canvas keys act only while the Desk tab shows.
- **desktop board and learn: a list of views beside the pane** (6f5287f)
  Board lists all tasks, each status and each assigned agent with counts; a status or agent view shows
  one list with the same keys. Learn lists review, leads, all cards and deleted in place of its tabs.
- **desktop agents: Slack's DM layout — agents listed with live state, preview and waiting count; the chosen agent's pages as tabs** (2ab2f94)
  The chosen agent and page are shared by the column and the pane and kept for the window.
- **desktop: a list column between the rail and the pane for Desk, Board, Agents and Learn** (2c05e57)
  Resizable 220-420, hidden with the rail button or Cmd+Shift+D, remembered; below 1100 wide it folds
  away and opens for the window only. Each section's column stays mounted so its scroll survives.
- **chat: every message carries its time — day pills, times on author rows, and the New line placed by what was seen** (4b69c89)
  History keeps the harness's and Letta's own timestamps; live rows are stamped as they arrive and keep
  their time across reloads. Drawn only in the Slack message layout; the desktop's bubble chat is as
  before.
- **desktop: the native title bar hides, Slack style — traffic lights over a 28px strip that drags the window** (c0fec61)
  macOS only: an overlay title bar with a hidden title; the rail and views start below the strip.
  In a browser the strip takes no space. The window title is still set for the Window menu.
- **desktop: Slack building blocks (list rows, sections, pane header and tabs, empty pane) and the phone's logic made shared** (a1ac483)
  Drafts, recents, search ranking, the unread line and day labels move to app/src/shared; the phone
  re-exports them unchanged. The message layout the phone uses now draws on the desktop too, when a
  caller passes it.
- **mod: a per-desk widget change log, sent live to every socket and with each desk's history** (2656d55)
  Each scan's added, changed and removed widgets append to <state>/widget-log/<scope>.json (200 rows,
  quick repeat edits fold into one); the first scan at start logs nothing. widget_change goes to every
  socket; history replies carry widgetLog.
- **plan 013: the desktop in Slack's layout — desk sidebar, Messages and Desk tabs, a widget log, message times, Command K search** (2c4b0dc)
  Requirements from the 2026-09-23 brainstorm, enriched to 13 implementation units.
- **phone: no ring on the heading a page focuses when it opens** (2ba9269)
  iOS Safari draws :focus-visible on that programmatic focus, so every page opened with a blue box round
  its title (round the agent pill on a conversation). The heading is not a control; the controls in it keep
  their ring.
- **desktop: radii by their tokens, small muted and error lines by .loki-meta** (f5b42e2)
  32 inline radii and three in chat.css that matched a role now name it. 86 hand-set
  fontSize-and-colour lines take loki-meta (10.5 details come up to the meta 12), with a new negative
  variant for errors. tokens.test fails either pattern coming back.
- **desktop: the inline styles follow the Slack theme — no serif, caps or tracking; mono only for code and data** (2b40d25)
  Needs-you dots and the inbox badge are red, unread rows go bold, primary actions are the one green
  button, warnings are red ink. Labels and headings are sentence case. tokens.test now fails any inline
  tracking, uppercase, or display/label face.
- **desktop: Slack's colours and type replace the drafting table** (c1df3bf)
  The loki palette takes Slack's light and dark values and Tokyo Night fills the same roles. The accent is
  the interactive blue; new attention (red badge) and affirm (green button) roles carry needs-you and
  go. Display and label faces are the sans; labels are sentence case; chrome is rounded; focus is a 2px
  blue ring. The window background, manifest and prepaint follow. design.md records the change.
- **phone: review fixes — prefill stays with its conversation, the health poll outlives the update bar, focus skips the hidden inbox** (19b94c7)
  Also: the keyboard is measured as layout height minus the visual viewport (iOS scrolls it), the
  shared chat's static inline styles move into chat.css so phone.css needs no !important, Search
  folds its fields once, and recents no longer record the Inbox tab.
- **phone: the assembled shell checked end to end — landmarks, focus, 44px targets, contrast, empty states** (2a888c8)
  Fixes from driving the real Phone shell on fake data: one main landmark, back is an icon button,
  Deny before Approve in DOM order, a question sent to Later offers another pass, zero desks is said
  as such, a stored desktop session no longer drops the phone's deep link. docs/design.md records the
  phone-only boundary, safe-area ownership and the one-scroll-owner rule.
- **phone search: one field over what the phone already knows — desks, agents, waiting items, pages** (7a379d6)
  Recent searches and recently visited pages before you type; ranked groups after. The query lives
  in #/search?q= so Back returns to it. Message text is not searched, and the page says so.
- **phone: Agents as a DM-style list, a readable agent profile, More as the utility hub; Learn keeps its pass** (9d084d8)
  More leads with the phone and the paired Mac, then Learn, Archive, Preferences, Updates, About and
  Connection details (#/connection, #/about). Preferences offers System, Light and Dark only; the
  desktop keeps its palettes. Unpair and reload ask first and show failure with a retry.
- **phone conversation: Slack's message anatomy — identity pill, avatar-led thread, notice, anchored composer** (7dae68c)
  The page shares the Inbox card's draft; the composer follows the on-screen keyboard (viewport.ts).
  Question, approval and tool rows are restyled under .loki-phone only; the shared chat's new inputs
  are optional and the desktop keeps its look. A send that throws now keeps the draft.
- **phone inbox: the card is the conversation — read, reply, attach, answer, approve; Later and Mark as Read below it** (626425c)
  The shared Conversation takes an optional host-kept draft (the phone's per-conversation store) and an
  avatar-led layout with an unread divider; left out, the desktop box is as before. deck.ts keeps the
  pass as pure state; approvals only resolve by Approve or Deny; Undo sits in the top bar.
- **phone home: the loki header, a shortcut rail, Needs your attention, then Desks; Archive is one page from Home and More** (0c038a2)
  An attention desk no longer repeats in the desk list (homeSections). Filter, agent scope, new desk
  and refresh move into a menu sheet; pin, archive and restore into a long-press sheet. rows.tsx is the
  shared avatar-led row.
- **phone: Home, Inbox, Agents, More in a floating capsule with Search beside it; pages remember where they came from** (1ef0de1)
  Search, Archive and Preferences become child routes (#/you and #/settings still land); session.ts
  keeps drafts, recents, scroll positions and the control to refocus on return.
- **phone: its own Slack-like light and dark system, one icon set, classes in place of inline styles** (c36f337)
  phone.css redeclares the --loki-* roles under .loki-phone so the palette never reaches the phone;
  the desktop's tokens are untouched. tokens.test fences contrast, fonts and scope.
- **phone: Learn becomes a page under Home, You replaces Settings, the inbox decides below the card** (71d9c0c)
  The groundwork the Slack-mode plan (docs/plans/2026-09-22-012) builds on, with PRODUCT.md.
- **phone settings: the screen line also says the insets, the visual viewport and the document height** (3e07b75)
- **phone: the status bar gets its own strip, so the web view fills the screen** (da0b6fb)
  With the translucent style WebKit draws a home-screen app from the top edge but sizes the view as if it
  began below the status bar; the bar's 59pt showed up as a gap under the tab bar (393×793 of 393×852). The
  default style lets iOS paint the strip in the theme-color, and the view runs to the bottom.
- **phone settings: the viewport the web view got, against the screen, and how the page runs** (192b795)
  A home-screen app added from Chrome on iOS runs in a container that keeps a strip at the bottom for its
  toolbar; the page cannot paint there. One line in Settings says which host this is and how much of the
  screen it has, so the next screenshot round is one glance.
- **phone: the document never scrolls — the tab bar stays put** (fe959b8)
  iOS rubber-bands the body behind a fixed shell when a drag starts outside a list or a list reaches its end,
  and the keyboard can leave it scrolled; the whole shell moved and the tab bar sat above the bottom. html and
  body are pinned on the phone, and every scroller contains its own overscroll.
- **phone home: the list is what the screen is for — rows 68→46pt, a shorter filter, tighter header** (843d5dd)
- **analytics: PostHog's event shape in place of the usage log, still local only** (23b802f)
  One event per line in ~/.letta/loki/logs/events.jsonl — { event, timestamp, distinct_id, properties } — the
  shape PostHog's batch import takes, without PostHog anywhere. Event names are object_verb: view_opened,
  message_sent, inbox_pass_completed, turn_started. The mod fills the system properties on every event:
  $device_type (mac, phone, mod), a $session_id cut on a thirty-minute gap per device, $app_version (stamped
  into the bundle by build-mod, read from package.json in a checkout), $lib; the clients add $screen, the
  view on show when they sent it. distinct_id is one random id per install, kept in state/analytics.json.

  `bun run analytics` replaces `bun run usage`: sessions by device and their median length, every event
  with its count and the sessions it fired in and the device split, a breakdown of each event by its key
  property, the inbox passes, the hour and weekday shape, and the events that never fired. LOKI_ANALYTICS=0
  turns the writer off. core/analytics.ts lists every event and its properties; docs/manual.md has the section.
- **usage: two comments said "window." and tripped the core portability check** (b770494)
- **a usage log: what you did in loki, one line per action, local only** (7654e45)
  ~/.letta/loki/logs/usage.jsonl — the mod writes it, `bun run usage` reads it, nothing leaves the machine.
  Lines carry ids and counts (a desk's scope, a model's handle), never message text, titles or paths.
  core/usage.ts is the shape, the parser and the report; mod/usage.ts appends and rotates at 20 MB.

  Where the lines come from:
  - the mod, for what it already sees: seen / unread / later / unsnooze, pins, gestures, arrange, trash,
    every turn start (with its desk) and every desk tool the agent calls
  - a `usage` frame from the app and the phone for what the mod cannot see: the view on screen, the desk
    under it, the chat opening and closing, sends with their origin (desk, inbox, lesson), approvals,
    answers, slash commands, model and mode picks, and the tally of an inbox pass when the deck closes
  - the surface (mac, phone, mod) is stamped by the mod from the connection, not claimed by the client

  `bun run usage [-- --days N]` answers the questions this is for: which views get opened, how an inbox pass
  goes and how often "later" is chosen, which desks get turns, what is sent from where, which models are
  picked, the hours and weekdays loki is used, and which actions never happened in the window.
  LOKI_USAGE_LOG=0 turns the writer off. docs/manual.md has a section.
- **desk tree: choosing the current desk goes back to it** (a51284d)
  From the inbox (or any other view) the tree offered the current desk but did nothing when it was
  chosen: the switch was skipped as a no-op, and the segment never returned to the desk. The switch
  handler already treats the same scope as no reconnect; it is the call that brings the desk back.
- **chat: one Conversation for the desk panel, the inbox card and the phone** (bf7e184)
  The desk's chat window, the inbox card and the phone's thread each drew the same conversation with
  their own code: three thread scrollers, three reply boxes, two copies of the model / effort / mode
  chips, two copies of the draft-and-send rules. Now there is one — chat/Conversation.tsx — laid out
  the way the inbox card was: the host's header, find, the thread, the open question or the tool the
  agent is paused on, the message box with send beside it, and a last row with the switchers on the
  left, approve / deny when something waits, then the host's own actions.

  What follows from that:
  - the card and the phone follow the desk's scroll rule — the bottom is followed only while you are
    there, a "↓ latest" chip offers the way back — instead of jumping on every row
  - the send button reads "queue" mid-turn everywhere, and a queued row can be taken back on a card
  - one placeholder grammar, one empty-thread note, the error shown wherever the host reports one
  - the phone's box gains images, dictation and the slash palette
  - approve / deny sit in the last row on every surface, with the inbox's key hints; the desk's header
    carries the desk's name over the agent's face like the card's does
  - the chips' open / busy state is the conversation's own, so a card no longer inherits the previous
    card's switch in flight

  The deck keeps its moves (useDeckActions: advance, undo, approve, and the flash and count a send
  leaves behind) and its keys; /model and /mode open the chips through the same ticks the desk's
  ⌘⇧M / ⌘⇧P use. Composer, AttentionStrip and ChatHeader fold into Conversation and are gone;
  CatchUpParts keeps the card's header, actions and pass summary.
- **theme: Tokyo Night as a second colour family, day and night** (21d7a8d)
  A palette sits next to the light/dark preference: data-palette on the root, saved under loki.palette,
  applied by the prepaint script before first paint and by the provider after. loki's own drafting table
  stays the default; Tokyo Night (enkia, MIT) fills the same roles with its own colours — its yellow is
  the brass, its teal the positive, its red the negative. Night keeps every canonical value; three Day
  inks are darkened along their own hue where the canonical ones miss AA on the Day ground.

  The tokens test now walks every family on both sides: each defines every colour token the default
  does, meets AA on the working surfaces, keeps the control-border and special-surface contrast, and
  repeats its two grounds in the prepaint script and the fallback stylesheet. The settings chip row
  gains the family next to system/light/dark, on the Mac and the phone alike.
- **a light theme, effort presets on the model picker, and the review fixes on top** (d6c17b8)
  The day palette: matched OKLCH ramps under data-theme, a saved system/light/dark preference
  applied before first paint, the native window and manifest following --loki-bg. The model
  picker groups one model's list_models presets and offers its reasoning efforts as a chip;
  the desk carries the applied effort. conversation_open follows the tab; NewDesk offers
  recent folders. Lifecycle events and model helpers move into their own modules.

  Review fixes, from a pass over the working tree:
  - queue: a decision records whether snoozed cards were shown; "show snoozed" only revisits
    cards deferred while they were hidden, so "later" with them shown no longer loops the card back
  - protocol: a bare handle goes as model_handle alone, so Letta resolves it by handle and keeps
    the preset's update args (the recall worker's model switch)
  - mod: conversation_open skips subagents like turn_start does; no desk, no tab switch
  - models: reasoning: null is the provider default, not "none" (as Letta's own derivation reads it)
  - composer: the effort chip renders only with a model picker to act through
  - new desk: Browse is enabled whether the recent-folders request resolved or failed
  - selectionOf() replaces three copies of the preset-to-selection object; useDesk reuses
    withReasoningEffort; the theme applies once per change and uses inTauri
  - tokens test guards the light prepaint colour and the Rust window colour too

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

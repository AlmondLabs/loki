# Changelog

Every stable, newest first. The version is the day it shipped (UTC); nightlies are not listed.

## 2026.9.28

- **analytics: a Next straight after acting on the same card is moving on, not a skip (the report leaves it out, history included); a card's dwell counts only while loki's window is visible and focused** (39d4674)
- **Change folder opens over the whole window: the dialog is put on the body, as Rename's is, so the sidebar no longer clips it; its folder list can hang past the card; 'current desk' reads 'current chat'** (84cb45a)
- **chat header: the ⋯ menu only on the Canvas tab, with arrange, fit and the chat toggle; find, model and mode leave it (⌘F and the message box have them)** (d7b63f8)
- **chat actions live on the sidebar row: the header drops pin, archive, read, rename, folder and New chat; its ⋯ keeps the conversation's own (find, model, mode, the Canvas tab's); the row menu gains Change folder…** (04c565c)
- **chats can change folder: Change folder… on the desktop header's menu and in the phone's chat actions; the hidden note on each message drops the folder** (3cd92b0)
  - Letta Code's change_device_state with a cwd moves the conversation (its /chdir); useAttention.changeFolder waits for its answer: a device status with the new folder, or a loop error
  - the desktop dialog shares New chat's folder field (useFolderField, pulled out of NewDesk): recents, completion, Browse
  - the phone sheet offers chips of the folders the agent has worked in, the chat's own lit
  - the mod's folder records follow Letta's cwdMap (~/.letta/remote-settings.json), so a moved chat counts in its new folder
  - environmentReminder keeps the time and the chat; the folder is Letta Code's to send (at a session's start and when it changes), and the note no longer says 'a browser tab'
  - analytics: folder_changed
- **phone: New chat picks its folder — chips of the folders the agent has worked in on the Mac, the most recent lit, More for the rest** (c3a3e9c)
- **analytics: the Inbox's cards shown, opened and undone, with the chat, how and how long; turn ends and approval requests for time to respond; where chats are archived; desk_switched no longer lost on a chat switch** (18e9df1)
  - inbox_card_decided carries desk, agent, via (key, click, swipe, tap), new, idle_min and dwell_ms; Open chat is an action and counts as engaged
  - new: inbox_card_shown, inbox_card_undone, inbox_filtered, chat_archived / chat_restored (origin), approval_requested (written once per request via a once key), turn_finished (mod, duration)
  - message_sent, approval_decided and question_answered carry desk and agent; the last two how long they waited
  - inbox_pass_completed adds shown and duration_ms
  - captures made while the desk socket reconnects wait for it instead of being dropped
  - the report adds distinct chats, the engaged share by rank shown, undos, time to respond and time to decide
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

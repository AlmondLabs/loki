# Preview checklist: Windows and Linux

The Windows and Linux builds are built and tested in CI, but nobody on the project has tried them on a real
machine. If you have one, this is what to try. Each item says what should happen; anything else is worth an
[issue](https://github.com/AlmondLabs/loki/issues). Say which system and version, how you installed loki
(the install line, the `-setup.exe`, the AppImage or the `.deb`), which Node loki runs on (Preferences › About names it), and attach what the logs
say: `~/.loki/logs/daemon.log` (the daemon's output) and `~/.loki/mod.log` (on Windows `~` is `%USERPROFILE%`).
Leave out tokens, transcripts and agent memory.

Every release, stable and nightly, carries the Windows and Linux files beside the Mac's. The quickest way in is the
install line ([the manual's Install section](manual.md#install)); the files on the
[releases page](https://github.com/AlmondLabs/loki/releases/latest) are the other way, and worth trying too.

## Install

1. **Windows, the install line.** `irm https://almondlabs.github.io/loki/install.ps1 | iex` in PowerShell installs
   loki into `%LOCALAPPDATA%\loki` with no administrator prompt and no SmartScreen screen; loki appears in the Start
   menu and opens. Run again while loki is open, it says to quit loki first and changes nothing.
2. **Linux, the install line.** `curl -fsSL https://almondlabs.github.io/loki/install.sh | sh` puts the AppImage in
   `~/.local/share/loki` and opens loki; loki appears in the applications menu with its icon. Without FUSE 2 it stops
   before installing and names the package command for your distribution.
3. **Windows, by hand.** `loki_<version>_x64-setup.exe` runs; SmartScreen's **More info → Run anyway** gets past the
   unknown-publisher screen; loki appears in the Start menu and opens.
4. **Linux, `.deb`.** `sudo apt install ./loki_*_amd64.deb` installs; loki appears in the applications menu and
   opens.
5. **Linux, AppImage by hand.** After `chmod +x`, it runs. Without `libfuse2` (`libfuse2t64` on Ubuntu 24.04), started
   from a terminal it prints a FUSE error; with the package installed it opens.

## First run

1. **A first launch.** loki puts its daemon, its mod and the web app build under `~/.loki`, and Welcome shows
   "Getting loki ready" while it checks for Node 22.19 or newer (offering **Install Node** when there is none) and,
   on Windows when git or Git Bash is missing, downloads PortableGit with a progress bar. Then it asks for a model provider (a key, or a
   sign-in in the browser), then for a first agent, and you land on its main chat. Preferences › About shows what
   launch installed and the Node it runs on.
2. **With no network, or no git.** A download that fails shows what failed and **Try Again**, which works once the
   network is back. On Linux with no git, Welcome shows the apt and dnf lines and **Check Again**: the daemon starts
   without restarting loki.
3. **A key is kept in the system's keychain** (Windows Credential Manager, or the Secret Service on Linux): after a
   restart the provider is still connected.

## Quit and relaunch

1. **Quit leaves nothing behind.** After closing loki, no `node` process of loki's (one whose command line holds
   `--loki-daemon`) is left and port 41414 is free (Task Manager or `netstat -ano | findstr 41414` on Windows;
   `ss -ltnp | grep 41414` on Linux).
2. **A second launch** while loki is open brings the running window forward; no second window, no second daemon.
3. **After a crash** (end loki's process by hand): on Windows the Job Object and on Linux the parent-death signal
   end the daemon with it. If one is still running, the next launch logs "daemon: one left from an earlier run
   (pid N) — stopping it", stops it, and starts a fresh one.
4. **A chat resumes.** End loki's process in the middle of an agent's turn and open it again: the chat is there,
   and the turn picks up from its last saved step.

## The window

1. **The strip drags the window**; a double click on it maximises and restores.
2. **Minimise, maximise and close** work; the maximise button's label and glyph flip to Restore when maximised,
   including after Win+Up, dragging to the top edge, or a Windows snap.
3. **Windows only:** the window resizes from every edge and has the system's shadow.
4. **☰** opens the menus with the mouse, and with the keyboard (↑↓ within a menu, → into a menu, ← and Esc back
   out); each item does what it says, and its key is written in Ctrl words.
5. **Over a dialog** (search, new chat, Preferences), the strip's buttons and ☰ still respond.

## Keys

1. **Ctrl keys everywhere:** Ctrl K search, Ctrl 1, 2, 4, 5 and 6 for the sections, Ctrl N new chat, Ctrl L the message box, Ctrl
   Shift [ and Ctrl Shift ] move the chat. The keys sheet (`?`) and Preferences › Keyboard shortcuts list Ctrl, Alt
   and Shift, never ⌘.
2. **Browser keys do nothing in the installed app:** Ctrl R, F5, Ctrl P, Ctrl U, Ctrl G, Ctrl Shift I and F12
   neither reload, print, view source nor open devtools. Ctrl F opens loki's find in the transcript.
3. **Mac-only lines:** Preferences › Phone says phone pairing isn't on your system yet; Preferences › Keyboard
   shortcuts says the system-wide key isn't; there is no dictation mic.

## Linux

1. **Wayland sessions.** loki runs through XWayland (`--ozone-platform=x11`), and the strip's buttons respond there.
   If you set `ELECTRON_OZONE_PLATFORM_HINT` (say `wayland`), loki keeps yours.
2. **Fonts** look like the rest of the desktop and not heavier than they should; blurred backdrops (sheets,
   popovers) either blur or fall back cleanly.

## Everywhere

1. **Typing with an input method** (IME: Chinese, Japanese, Korean, or dead keys for accents): composing text in
   the message box works, and Enter confirms the composition without sending half of it.
2. **New chat › Browse…** opens the system's own folder dialog; the chosen folder fills the field. Typing
   `C:\` or `~\` (Windows) or `~/` completes folders.
3. **Updates.** On an older build (the Nightly channel gets one soonest), loki downloads the newer version in the
   background, Preferences › About says it is ready, and quitting or **Restart to Update** installs it; the next
   launch is the new version, with your chats in place. A `.deb` install never updates: About links the releases page
   instead.

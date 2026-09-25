# Preview checklist: Windows and Linux

The Windows and Linux builds are built and tested in CI, but nobody on the project has tried them on a real
machine. If you have one, this is what to try. Each item says what should happen; anything else is worth an
[issue](https://github.com/AlmondLabs/loki/issues). Say which system and version, which file you installed
(`-setup.exe`, AppImage or `.deb`), and attach what the logs say:
`~/.letta/loki/logs/harness.log`, `~/.letta/loki/logs/install.log` and `~/.letta/loki/mod.log` (on Windows `~` is
`%USERPROFILE%`). Leave out tokens, transcripts and agent memory.

The files are on stable releases, attached a little after the `.dmg` (the
[latest release](https://github.com/AlmondLabs/loki/releases/latest), or the one before while the newest is still
Mac-only); nightlies carry none. The README's Install section has the steps.

## Install

1. **Windows.** `loki_<version>_x64-setup.exe` runs; SmartScreen's **More info → Run anyway** gets past the
   unknown-publisher screen; loki appears in the Start menu and opens.
2. **Linux, `.deb`.** `sudo apt install ./loki_*_amd64.deb` installs; loki appears in the applications menu and
   opens.
3. **Linux, AppImage.** After `chmod +x`, it runs. Without `libfuse2` (`libfuse2t64` on Ubuntu 24.04), started
   from a terminal it prints a FUSE error; with the package installed it opens.

## First run

1. **With Node 22.19 or newer and no Letta Code.** Welcome installs Letta Code with npm and shows it happening,
   then asks for a provider key; the desk opens once the harness is ready.
2. **With no Node, or an older one.** Welcome says Node is needed, shows `winget install OpenJS.NodeJS.LTS` on
   Windows or the apt and dnf lines on Linux, and links nodejs.org. Install Node, press **check again**: the
   Letta Code install starts without restarting loki.
3. **With Letta Code already installed.** loki uses it and installs nothing; Settings › letta shows its path and
   version.
4. **With Letta Desktop running** (if it exists for your system). loki attaches to it, shows the same agents and
   conversations, and starts no second harness; Settings › letta names Desktop as the harness.
5. **With a `letta server` you started.** loki attaches to it the same way.

## Quit and relaunch

1. **Quit leaves nothing behind.** After closing loki, no `letta` or `node` process of loki's is left and port
   41600 is free (Task Manager or `netstat -ano | findstr 41600` on Windows; `ss -ltnp | grep 41600` on Linux).
2. **A second launch** while loki is open brings the running window forward; no second window, no second harness.
3. **After a crash** (end loki's process by hand): on Windows and Linux the harness should end with it. If one is
   still on 41600, the next launch logs "a loki harness left from an earlier run (pid N) — restarting it", stops
   it, and starts a fresh harness (a new pid on 41600, owned: stopped on quit, and Settings › letta **update** works).

## The window

1. **The strip drags the window**; a double click on it maximises and restores.
2. **Minimise, maximise and close** work; the maximise button's label and glyph flip to Restore when maximised,
   including after Win+Up, dragging to the top edge, or a Windows snap.
3. **Windows only:** the window resizes from every edge and has the system's shadow.
4. **☰** opens the menus with the mouse, and with the keyboard (↑↓ within a menu, → into a menu, ← and Esc back
   out); each item does what it says, and its key is written in Ctrl words.
5. **Over a dialog** (search, new desk, Preferences), the strip's buttons and ☰ still respond.

## Keys

1. **Ctrl keys everywhere:** Ctrl K search, Ctrl 1–5 sections, Ctrl N new desk, Ctrl L the message box, Ctrl
   Shift [ and Ctrl Shift ] move the chat on the Desk tab. The keys sheet (`?`) and Settings › keys list Ctrl, Alt
   and Shift, never ⌘.
2. **Browser keys do nothing in the installed app:** Ctrl R, F5, Ctrl P, Ctrl U, Ctrl G, Ctrl Shift I and F12
   neither reload, print, view source nor open devtools. Ctrl F opens loki's find in the transcript.
3. **Mac-only lines:** Settings › phone says phone pairing isn't on your system yet; Settings › keys says the
   system-wide key isn't; there is no dictation mic.

## Linux

1. **Wayland sessions.** loki runs through XWayland (`GDK_BACKEND=x11`), and the strip's buttons respond there. If
   you start it with your own `GDK_BACKEND` (say `GDK_BACKEND=wayland`), loki keeps yours.
2. **Fonts** look like the rest of the desktop and not heavier than they should; blurred backdrops (sheets,
   popovers) either blur or fall back cleanly.

## Everywhere

1. **Typing with an input method** (IME: Chinese, Japanese, Korean, or dead keys for accents): composing text in
   the message box works, and Enter confirms the composition without sending half of it.
2. **New desk › Browse…** opens the system's own folder dialog; the chosen folder fills the field. Typing
   `C:\` or `~\` (Windows) or `~/` completes folders.
3. **Update check.** On an older build, Settings › letta says a newer loki is out and links this system's file
   (the `-setup.exe`, or the AppImage or `.deb`), not the `.dmg`.

/**
 * The words that name the machine and its tools, per system (plan 014 U8): the Mac's as they were, a PC's and a
 * Linux computer's in their place. Copy of the Mac-only extras (tray, system-wide key, dictation, phone pairing,
 * Tailscale) keeps its Mac words; those views are hidden elsewhere (U3). Every reader takes `os` and defaults
 * to the system loki runs on (env.ts `platform`), which a browser tab on another computer learns from the mod.
 */
import { platform, systemName, type Platform } from "../desk/env";

export interface OsWords {
  /** The machine mid-sentence: "keys are kept by Letta on this Mac". */
  machine: string;
  /** The same at the start of a sentence. */
  Machine: string;
  /** The machine seen from elsewhere: "loki runs on a Mac". */
  aMachine: string;
  /** The system's file manager: "choose a folder in Finder". */
  fileManager: string;
  /** The folder field's example path. */
  folderExample: string;
  /** The line that installs beads (bd), the board's task tracker. */
  beadsInstall: string;
  /** Settings › letta's System fact, under runsOn: what loki needs of the system. */
  system: string;
  /** Where Welcome's failed install sends a global folder npm may not write. */
  npmDenied: string;
}

const WORDS: Record<Platform, OsWords> = {
  macos: {
    machine: "this Mac",
    Machine: "This Mac",
    aMachine: "a Mac",
    fileManager: "Finder",
    folderExample: "~/Documents/…",
    beadsInstall: "brew install beads",
    system: "macOS 13 or later; the shell finds Letta Desktop with lsof and picks folders with osascript",
    npmDenied: "A global folder npm may not write needs the sudo line above, run in a terminal.",
  },
  windows: {
    machine: "this PC",
    Machine: "This PC",
    aMachine: "a PC",
    fileManager: "File Explorer",
    folderExample: "~\\Documents\\…",
    beadsInstall: "npm install -g @beads/bd",
    system: "64-bit Windows 10 or 11, a preview build; the shell picks folders with the system's own dialog",
    npmDenied: "A global folder npm may not write needs the line above, run in a terminal opened as administrator.",
  },
  linux: {
    machine: "this computer",
    Machine: "This computer",
    aMachine: "a computer",
    fileManager: "the file manager",
    folderExample: "~/Documents/…",
    beadsInstall: "npm install -g @beads/bd",
    system: "64-bit desktop Linux (Ubuntu and Debian first), a preview build; the shell picks folders with the system's own dialog",
    npmDenied: "A global folder npm may not write needs the sudo line above, run in a terminal.",
  },
};

export function osWords(os: Platform = platform): OsWords {
  return WORDS[os];
}

/** How to get a newer loki: the cask (or the .dmg) on the Mac, this system's download from the release page elsewhere. */
export function lokiUpgrade(cask: string, os: Platform = platform): string {
  if (os === "windows") return "download the -setup.exe from the release page";
  if (os === "linux") return "download the AppImage or .deb from the release page";
  return `brew upgrade --cask ${cask}, or the .dmg on the release page`;
}

/** Off the Mac, a newer stable whose files are not attached yet: they come from its preview PR, after the Mac's. */
export function lokiUpgradeNotYet(os: Platform = platform): string {
  const files = os === "windows" ? "its -setup.exe is" : "its AppImage and .deb are";
  return `${files} not on the release yet — Windows and Linux files follow the Mac's; watch the release page`;
}

/** Settings › letta's System fact: "loki runs on this Mac (macOS)" in the app, "…on a Mac (macOS); you're viewing it in a browser" in a tab. */
export function runsOn(os: Platform, shell: boolean): string {
  const w = WORDS[os];
  return shell ? `loki runs on ${w.machine} (${systemName(os)})` : `loki runs on ${w.aMachine} (${systemName(os)}); you're viewing it in a browser`;
}

/**
 * The words that name the machine and its tools, per system (plan 014 U8): the Mac's as they were, a PC's and a
 * Linux computer's in their place. Copy of the Mac-only extras (tray, system-wide key, dictation, phone pairing,
 * Tailscale) keeps its Mac words; those views are hidden elsewhere (U3). Like keymap.ts, every reader takes
 * `os` and defaults to the system the page runs on.
 */
import { platform, type Platform } from "../desk/env";

export interface OsWords {
  /** The machine mid-sentence: "keys are kept by Letta on this Mac". */
  machine: string;
  /** The same at the start of a sentence. */
  Machine: string;
  /** The system's file manager: "choose a folder in Finder". */
  fileManager: string;
  /** The folder field's example path. */
  folderExample: string;
  /** The line that installs beads (bd), the board's task tracker. */
  beadsInstall: string;
  /** Settings › letta's System fact: what loki runs on here. */
  system: string;
  /** Where Welcome's failed install sends a global folder npm may not write. */
  npmDenied: string;
}

const WORDS: Record<Platform, OsWords> = {
  macos: {
    machine: "this Mac",
    Machine: "This Mac",
    fileManager: "Finder",
    folderExample: "~/Documents/…",
    beadsInstall: "brew install beads",
    system: "macOS 13 or later; the shell finds Letta Desktop with lsof and picks folders with osascript",
    npmDenied: "A global folder npm may not write needs the sudo line above, run in a terminal.",
  },
  windows: {
    machine: "this PC",
    Machine: "This PC",
    fileManager: "File Explorer",
    folderExample: "~\\Documents\\…",
    beadsInstall: "npm install -g @beads/bd",
    system: "64-bit Windows 10 or 11, a preview build; the shell picks folders with the system's own dialog",
    npmDenied: "A global folder npm may not write needs the line above, run in a terminal opened as administrator.",
  },
  linux: {
    machine: "this computer",
    Machine: "This computer",
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

/**
 * The words that name the machine and its tools, per system (plan 014 U8): the Mac's as they were, a PC's and a
 * Linux computer's in their place. Copy of the Mac-only extras (tray, system-wide key, dictation, phone pairing,
 * Tailscale) keeps its Mac words; those views are hidden elsewhere (U3). Every reader takes `os` and defaults
 * to the system loki runs on (env.ts `platform`), which a browser tab on another computer learns from the mod.
 */
import { platform, systemName, type Platform } from "../desk/env";

/** The words that name the machine and its tools on one system. */
export interface OsWords {
  /** The machine mid-sentence: "every agent on this Mac". */
  machine: string;
  /** The same at the start of a sentence. */
  Machine: string;
  /** The machine seen from elsewhere: "loki runs on a Mac". */
  aMachine: string;
  /** The system's file manager: "choose a folder in Finder". */
  fileManager: string;
  /** The folder field's example path. */
  folderExample: string;
  /** Preferences › About's System fact, under runsOn: what loki needs of the system. */
  system: string;
}

const WORDS: Record<Platform, OsWords> = {
  macos: {
    machine: "this Mac",
    Machine: "This Mac",
    aMachine: "a Mac",
    fileManager: "Finder",
    folderExample: "~/Documents/…",
    system: "macOS 13.3 or later; the shell picks folders with osascript",
  },
  windows: {
    machine: "this PC",
    Machine: "This PC",
    aMachine: "a PC",
    fileManager: "File Explorer",
    folderExample: "~\\Documents\\…",
    system: "64-bit Windows 10 or 11, a preview build; the shell picks folders with the system's own dialog",
  },
  linux: {
    machine: "this computer",
    Machine: "This computer",
    aMachine: "a computer",
    fileManager: "the file manager",
    folderExample: "~/Documents/…",
    system: "64-bit desktop Linux (Ubuntu and Debian first), a preview build; the shell picks folders with the system's own dialog",
  },
};

/** What Welcome's tools step says on a system whose git is missing (plan 2026-11-15-2319, KTD6). */
export interface ToolsWords {
  /** The step's heading. */
  title: string;
  /** What is needed and why. */
  needed: string;
  /** The button that has the system install it, where there is one (the Mac's). */
  install: string | null;
  /** Said once the system was asked to install it. */
  asked: string | null;
  /** The commands that install it, for the person to run. */
  commands: string[];
  /** Where to run them, after the commands. */
  where: string | null;
}

const TOOLS: Record<"macos" | "linux", ToolsWords> = {
  macos: {
    title: "Command line tools",
    needed: "Apple's command line tools are needed. Agents keep their memory and skills with git, which comes with them.",
    install: "Install Command Line Tools",
    asked: "macOS is showing its installer. When it has finished, check again.",
    commands: [],
    where: null,
  },
  linux: {
    title: "Git",
    needed: "Git is needed. Agents keep their memory and skills with it.",
    install: null,
    asked: null,
    commands: ["sudo apt install git", "sudo dnf install git"],
    where: "in a terminal, on Debian or Ubuntu or on Fedora. Then check again.",
  },
};

/** The tools step's words on a system whose git is missing. Windows has none: loki fetches PortableGit there itself. */
export function toolsWords(os: "macos" | "linux"): ToolsWords {
  return TOOLS[os];
}

/** The machine's words on a system, the one loki runs on unless told. */
export function osWords(os: Platform = platform): OsWords {
  return WORDS[os];
}

/** Preferences › About's System fact: "loki runs on this Mac (macOS)" in the app, "…on a Mac (macOS); you're viewing it in a browser" in a tab. */
export function runsOn(os: Platform, shell: boolean): string {
  const w = WORDS[os];
  return shell ? `loki runs on ${w.machine} (${systemName(os)})` : `loki runs on ${w.aMachine} (${systemName(os)}); you're viewing it in a browser`;
}

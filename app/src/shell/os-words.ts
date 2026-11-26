import { platform, systemName, type Platform } from "../workspace/env";

export interface OsWords {
  machine: string;
  Machine: string;
  aMachine: string;
  fileManager: string;
  folderExample: string;
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

export interface ToolsWords {
  title: string;
  needed: string;
  install: string | null;
  asked: string | null;
  commands: string[];
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

export function nodeWords(os: Platform, needs: { found: string | null; at: string | null; needed: string }): ToolsWords {
  const missing =
    needs.found && needs.at
      ? `Node ${needs.found} at ${needs.at} is older than ${needs.needed}.`
      : `No Node ${needs.needed} or newer was found on ${WORDS[os].machine}.`;
  const needed = `${missing} loki runs your agents on Node, and Claude Code chats use it too.`;
  if (os === "linux")
    return {
      title: "Node",
      needed,
      install: null,
      asked: null,
      commands: ["curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash", "nvm install --lts"],
      where: "in a terminal, or a current version from nodejs.org. Then check again.",
    };
  return {
    title: "Node",
    needed,
    install: "Install Node",
    asked: os === "macos" ? "When the installer has finished, check again if loki has not carried on." : null,
    commands: [],
    where: null,
  };
}

export function toolsWords(os: "macos" | "linux"): ToolsWords {
  return TOOLS[os];
}

export function osWords(os: Platform = platform): OsWords {
  return WORDS[os];
}

export function runsOn(os: Platform, shell: boolean): string {
  const w = WORDS[os];
  return shell ? `loki runs on ${w.machine} (${systemName(os)})` : `loki runs on ${w.aMachine} (${systemName(os)}); you're viewing it in a browser`;
}

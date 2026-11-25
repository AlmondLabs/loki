import { describe, expect, test } from "vitest";
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { welcomeFor, type DaemonStatus, type Preparing } from "../app/src/shell/bootstrap.ts";
import { NodeNeeded, PrepareStep, Preparation, Tools } from "../app/src/shell/welcome.tsx";
import type { ConnectProvider } from "../core/attention/protocol.ts";

const status = (s: Partial<DaemonStatus>): DaemonStatus => ({
  node: null,
  error: null,
  preparing: null,
  toolsMissing: null,
  needsNode: null,
  otherLoki: null,
  ...s,
});
const fetching = (p: Partial<Preparing> = {}): Preparing => ({ name: "git", version: "2.56.1", done: 12_000_000, total: 31_000_000, ...p });
const noop = async () => {};
const html = (s: DaemonStatus | null) =>
  renderToStaticMarkup(createElement(PrepareStep, { status: s, onRetry: noop, onInstallTools: () => Promise.resolve(null) }));

function elements(node: ReactNode): Array<ReactElement<Record<string, unknown>>> {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement(node)) return [];
  const el = node as ReactElement<Record<string, unknown>>;
  return [el, ...elements(el.props.children as ReactNode)];
}

const buttons = (node: ReactNode) =>
  elements(node)
    .filter((e) => typeof e.props.onClick === "function")
    .map((e) => ({ label: String(e.props.children), click: e.props.onClick as () => void, disabled: e.props.disabled === true }));

describe("Welcome prepares the machine", () => {
  test("a download in progress says what is being fetched and how far along it is, with no button", () => {
    const out = html(status({ preparing: fetching() }));
    expect(out).toContain("Downloading PortableGit 2.56.1");
    expect(out).toContain("12 of 31 MB");
    expect(out).toContain('role="progressbar"');
    expect(out).toContain('aria-valuenow="39"');
    expect(out).not.toContain("<button");
    expect(out).not.toContain("Install Node");
  });

  test("before the server says the size, the bar has no value and the line no total", () => {
    const out = html(status({ preparing: fetching({ done: 0, total: null }) }));
    expect(out).toContain("Downloading PortableGit 2.56.1");
    expect(out).toContain('role="progressbar"');
    expect(out).not.toContain("aria-valuenow");
    expect(out).not.toContain(" of ");
  });

  test("Windows without git or Git Bash: PortableGit being fetched, not a tools step", () => {
    const out = html(status({ preparing: fetching({ done: 1_000_000, total: 60_000_000 }) }));
    expect(out).toContain("Downloading PortableGit 2.56.1");
    expect(out).not.toContain("Check Again");
    expect(out).not.toContain("command line tools");
  });

  test("a failed download shows what failed, the error, and Try Again, which reruns the sequence", () => {
    const failed = status({ preparing: fetching({ done: 3_000_000 }), error: "could not download PortableGit-2.56.1-64-bit.7z.exe: connection reset" });
    const out = html(failed);
    expect(out).toContain("loki could not download PortableGit 2.56.1.");
    expect(out).toContain("connection reset");
    expect(out).toContain(">Try Again</button>");
    expect(out.match(/<button/g)?.length).toBe(1);
    expect(out).not.toContain('role="progressbar"');
    let retried = 0;
    const tree = Preparation({ preparing: fetching(), error: "x", busy: false, onRetry: () => retried++ });
    const [again] = buttons(tree);
    expect(again.label).toBe("Try Again");
    again.click();
    expect(retried).toBe(1);
    expect(buttons(Preparation({ preparing: fetching(), error: "x", busy: true, onRetry: () => {} }))[0].disabled).toBe(true);
  });

  test("the Mac without its command line tools: Install Command Line Tools, then Check Again", () => {
    const out = html(status({ toolsMissing: "macos" }));
    expect(out).toContain("Apple&#x27;s command line tools are needed");
    expect(out).toContain(">Install Command Line Tools</button>");
    expect(out).toContain(">Check Again</button>");
    expect(out).not.toContain("sudo");
    let installed = 0;
    let checked = 0;
    const tree = Tools({
      os: "macos",
      busy: false,
      asked: false,
      problem: null,
      onInstall: () => installed++,
      onCheck: () => checked++,
    });
    const [install, check] = buttons(tree);
    expect([install.label, check.label]).toEqual(["Install Command Line Tools", "Check Again"]);
    install.click();
    check.click();
    expect([installed, checked]).toEqual([1, 1]);
    const asked = renderToStaticMarkup(createElement(Tools, { os: "macos", busy: false, asked: true, problem: null, onInstall: () => {}, onCheck: () => {} }));
    expect(asked).toContain("When it has finished");
  });

  test("Linux without git: the package command and Check Again, no install button", () => {
    const out = html(status({ toolsMissing: "linux" }));
    expect(out).toContain("sudo apt install git");
    expect(out).toContain("sudo dnf install git");
    expect(out).toContain(">Check Again</button>");
    expect(out.match(/<button/g)?.length).toBe(1);
    expect(out).not.toContain("Install Command Line Tools");
  });

  test("covers AE1: no Node on the Mac shows Install Node and Check Again, and the button installs", () => {
    const out = html(status({ needsNode: { found: null, at: null, needed: "22.19" }, error: "no Node 22.19 or newer" }));
    expect(out).toContain("No Node 22.19 or newer was found");
    expect(out).toContain(">Install Node</button>");
    expect(out).toContain(">Check Again</button>");
    let installed = 0;
    const tree = NodeNeeded({
      os: "macos",
      needs: { found: null, at: null, needed: "22.19" },
      busy: false,
      asked: false,
      problem: null,
      onInstall: () => installed++,
      onCheck: () => {},
    });
    buttons(tree)[0]?.click();
    expect(installed).toBe(1);
  });

  test("a Node too old is named with where it is", () => {
    const out = renderToStaticMarkup(
      createElement(NodeNeeded, {
        os: "windows",
        needs: { found: "20.11.1", at: "C:\\nodejs\\node.exe", needed: "22.19" },
        busy: false,
        asked: false,
        problem: null,
        onInstall: () => {},
        onCheck: () => {},
      }),
    );
    expect(out).toContain("Node 20.11.1 at C:\\nodejs\\node.exe is older than 22.19.");
    expect(out).toContain(">Install Node</button>");
  });

  test("covers AE3: Linux gets the commands and Check Again, no installer", () => {
    const out = renderToStaticMarkup(
      createElement(NodeNeeded, {
        os: "linux",
        needs: { found: null, at: null, needed: "22.19" },
        busy: false,
        asked: false,
        problem: null,
        onInstall: () => {},
        onCheck: () => {},
      }),
    );
    expect(out).toContain("nvm install --lts");
    expect(out).not.toContain("Install Node</button>");
    expect(out.match(/<button/g)?.length).toBe(1);
  });

  test("any other reason the daemon could not start: the reason, where the log is, and check again", () => {
    const out = html(status({ node: "24.1.0", error: "daemon exited: EADDRINUSE" }));
    expect(out).toContain("EADDRINUSE");
    expect(out).toContain("~/.loki/logs/daemon.log");
    expect(out).toContain(">Check Again</button>");
    expect(out.match(/<button/g)?.length).toBe(1);
    expect(out).not.toContain("Letta");
  });
});

describe("when Welcome shows", () => {
  const anthropic = { id: "anthropic", connected: { is_connected: true } } as unknown as ConnectProvider;
  const down = { status: "connecting", agentsLoaded: false, agents: [], providers: null } as const;
  const open = (agents: number, providers: ConnectProvider[] | null) =>
    ({ status: "open", agentsLoaded: true, agents: Array.from({ length: agents }, () => ({})), providers }) as const;

  test("a first launch with no runtime shows Preparing, whatever way loki arrived: the status says nothing of that", () => {
    expect(welcomeFor(status({ preparing: fetching({ done: 0, total: null }) }), down)).toBe("prepare");
    expect(welcomeFor(status({ toolsMissing: "macos" }), down)).toBe("prepare");
    expect(welcomeFor(status({ error: "could not download" }), down)).toBe("prepare");
    expect(welcomeFor(status({ needsNode: { found: null, at: null, needed: "22.19" } }), down)).toBe("prepare");
  });

  test("before the start sequence has said anything, nothing shows: a returning launch with its runtime goes straight in", () => {
    expect(welcomeFor(status({}), down)).toBeNull();
    expect(welcomeFor(null, down)).toBeNull();
  });

  test("a returning person with PortableGit being fetched: Preparing, then the app, never the provider step", () => {
    expect(welcomeFor(status({ preparing: fetching() }), down)).toBe("prepare");
    expect(welcomeFor(status({ node: "/n" }), { ...open(2, [anthropic]), agentsLoaded: false })).toBeNull();
    expect(welcomeFor(status({ node: "/n" }), open(2, [anthropic]))).toBeNull();
    expect(welcomeFor(status({ node: "/n" }), open(2, null))).toBeNull();
  });

  test("once the runtime and git are ready, a new machine moves on to the provider step", () => {
    expect(welcomeFor(status({ node: "/n" }), open(0, [{ ...anthropic, connected: { is_connected: false } }]))).toBe("provider");
    expect(welcomeFor(status({ node: "/n" }), open(0, [anthropic]))).toBe("agent");
  });
});

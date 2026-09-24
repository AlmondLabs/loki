import { describe, expect, test } from "bun:test";
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { lettaPhase, nodeHelp, type BootstrapStatus, type NodeMissing } from "../app/src/shell/bootstrap.ts";
import { LettaInstall, NodeNeeded } from "../app/src/shell/Welcome.tsx";

const base: BootstrapStatus = { letta: null, node: null, explicit: false, installing: false, error: null, log: [], version: null, latest: null, managed: false, node_missing: null };
const missing = (os: NodeMissing["os"], found: string | null = null, at: string | null = null): NodeMissing => ({ os, found, at, needed: "22.19" });
const noNode = (os: NodeMissing["os"], found?: string, at?: string): BootstrapStatus => ({ ...base, error: "no Node", node_missing: missing(os, found ?? null, at ?? null) });
const html = (status: BootstrapStatus | null) => renderToStaticMarkup(createElement(LettaInstall, { status, onRetry: async () => {} }));

/** Every element in a rendered-to-elements tree (props.children followed), for finding a handler without a DOM. */
function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement(node)) return [];
  const el = node as ReactElement<Record<string, unknown>>;
  return [el, ...elements(el.props.children as ReactNode)];
}

describe("Welcome: no Node 22 on the machine", () => {
  test("Windows: says Node 22 or newer is needed, links nodejs.org, names the winget line and offers one re-check", () => {
    const out = html(noNode("windows"));
    expect(out).toContain("Node 22 or newer is needed");
    expect(out).toContain('href="https://nodejs.org/"');
    expect(out).toContain("winget install OpenJS.NodeJS.LTS");
    expect(out).toContain("check again");
    expect(out.match(/<button/g)?.length).toBe(1);
    expect(out).not.toContain("retry the install");
    expect(out).not.toContain("brew");
  });

  test("Linux: the distribution's package manager, apt and dnf, instead of winget", () => {
    const out = html(noNode("linux"));
    expect(out).toContain("Node 22 or newer is needed");
    expect(out).toContain("sudo apt install nodejs npm");
    expect(out).toContain("sudo dnf install nodejs");
    expect(out).not.toContain("winget");
    expect(out).toContain('href="https://nodejs.org/"');
  });

  test("the Mac keeps Homebrew's line", () => {
    expect(html(noNode("macos"))).toContain("brew install node");
    expect(nodeHelp("macos").command).toBe("brew install node");
    expect(nodeHelp("windows").command).toBe("winget install OpenJS.NodeJS.LTS");
  });

  test("a Node older than 22.19 counts as missing, and the one found is named", () => {
    const out = html(noNode("linux", "20.11.1", "/usr/bin/node"));
    expect(out).toContain("Node 22 or newer is needed");
    expect(out).toContain("20.11.1");
    expect(out).toContain("/usr/bin/node");
    expect(out).toContain("22.19");
  });

  test("the re-check button runs the existing retry path", () => {
    let calls = 0;
    const tree = NodeNeeded({ missing: missing("windows"), busy: false, onRecheck: () => void calls++ });
    const buttons = elements(tree).filter((e) => typeof e.props.onClick === "function");
    expect(buttons.length).toBe(1);
    (buttons[0].props.onClick as () => void)();
    expect(calls).toBe(1);
    const busy = elements(NodeNeeded({ missing: missing("windows"), busy: true, onRecheck: () => {} })).find((e) => typeof e.props.onClick === "function");
    expect(busy?.props.disabled).toBe(true);
  });

  test("re-check with Node present moves on to installing Letta Code", () => {
    expect(lettaPhase(noNode("windows"))).toBe("node");
    // The shell clears the Node state as the re-check starts and reports the npm install as it runs.
    const rechecking: BootstrapStatus = { ...base, installing: true, log: ["using Node at C:\\Program Files\\nodejs\\node.exe"] };
    expect(lettaPhase(rechecking)).toBe("installing");
    const out = html(rechecking);
    expect(out).not.toContain("Node 22 or newer is needed");
    expect(out).toContain("installing it with npm");
    expect(out).toContain("using Node at");
  });

  test("the phases: looking, installing, failed for another reason, Node missing", () => {
    expect(lettaPhase(null)).toBe("looking");
    expect(lettaPhase(base)).toBe("looking");
    expect(lettaPhase({ ...base, installing: true })).toBe("installing");
    expect(lettaPhase({ ...base, error: "npm failed: ENOTFOUND" })).toBe("failed");
    // A re-check in flight wins over the Node state it is replacing.
    expect(lettaPhase({ ...noNode("linux"), installing: true })).toBe("installing");
    // An older shell with no node_missing field at all still reads as a failed install.
    const { node_missing: _, ...older } = { ...base, error: "x" };
    expect(lettaPhase(older as BootstrapStatus)).toBe("failed");
  });

  test("any other failure keeps the retry and the error line", () => {
    const out = html({ ...base, error: "npm failed: ENOTFOUND registry.npmjs.org" });
    expect(out).toContain("ENOTFOUND");
    expect(out).toContain("retry the install");
    expect(out).not.toContain("Node 22 or newer is needed");
  });
});

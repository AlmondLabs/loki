import { describe, expect, test } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { must } from "./fixtures/must.ts";

const APP = join(import.meta.dirname, "..", "app", "src");
const phone = "\n" + readFileSync(join(APP, "phone", "phone.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

const blockOf = (selector: string) => {
  const start = phone.indexOf(`\n${selector} {`);
  if (start < 0) throw new Error(`no phone block for ${selector}`);
  return phone.slice(start, phone.indexOf("\n}", start + 1));
};
const ruleOf = (selector: string) => must(new RegExp(`\\n${selector.replace(/[.[\]()]/g, "\\$&")} \\{([^}]*)\\}`).exec(phone), selector)[1];
const alpha = (rgba: string) => Number(must(/rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\)/.exec(rgba), rgba)[1]);
const token = (block: string, name: string) => must(new RegExp(`\\s--loki-${name}:\\s*([^;]+);`).exec(block), name)[1].trim();

describe("the phone's glass (U1)", () => {
  test("night and day each declare the phone's own translucent glass, strong glass and blur", () => {
    for (const selector of [".loki-phone", ':root[data-theme="light"] .loki-phone']) {
      const block = blockOf(selector);
      for (const name of ["glass", "glass-strong"]) {
        const value = token(block, name);
        expect(value).toMatch(/^rgba\(/);
        expect(alpha(value)).toBeLessThan(1);
      }
      expect(alpha(token(block, "glass"))).toBeLessThan(alpha(token(block, "glass-strong")));
      expect(token(block, "glass-blur")).toMatch(/^blur\(/);
      expect(token(block, "glass-hi")).toMatch(/^rgba\(/);
      expect(token(block, "glass-edge")).toMatch(/^rgba\(/);
    }
  });

  test("under Increase Contrast the glass is the phone's panel, with no blur and the controls' stronger edge", () => {
    const media = must(/@media \(prefers-contrast: more\) \{([\s\S]*?)\n\}/.exec(phone), "the contrast block")[1];
    expect(media).toMatch(/--loki-glass:\s*var\(--loki-panel\);/);
    expect(media).toMatch(/--loki-glass-strong:\s*var\(--loki-panel\);/);
    expect(media).toMatch(/--loki-glass-blur:\s*none;/);
    expect(media).toMatch(/--loki-glass-edge:\s*var\(--loki-control-border\);/);
    expect(media).toMatch(/--loki-glass-hi:\s*transparent;/);
  });

  test("the tab bar, Search and compose draw from the glass tokens, never a blur of their own", () => {
    for (const selector of [".loki-phone-nav", ".loki-phone-search-btn", ".loki-phone-compose"]) {
      const rule = ruleOf(selector);
      expect(rule).toContain("background: var(--loki-glass);");
      expect(rule).toContain("backdrop-filter: var(--loki-glass-blur);");
      expect(rule).toContain("var(--loki-glass-edge)");
      expect(rule).not.toMatch(/blur\(/);
    }
    expect(phone.match(/backdrop-filter:\s*blur\(/g)).toBeNull();
  });

  test("covers U2: bottom sheets and the phone's popover are strong glass of the phone's own", () => {
    for (const selector of [".loki-sheet-card.loki-phone-sheet", ".loki-phone .loki-popover"]) {
      const rule = ruleOf(selector);
      expect(rule).toContain("background: var(--loki-glass-strong);");
      expect(rule).toContain("backdrop-filter: var(--loki-glass-blur);");
      expect(rule).toContain("var(--loki-glass-edge)");
      expect(rule).not.toMatch(/blur\(/);
    }
  });

  test("covers U2: the sheets that fill the screen stay solid, as iOS's large sheets are", () => {
    const solid = must(
      /\n\.loki-sheet-card\.loki-phone-sheet\.loki-model-sheet,\s*\.loki-sheet-card\.loki-phone-sheet\.loki-steps-sheet,\s*\.loki-sheet-card\.loki-phone-sheet\.loki-suggestion-sheet \{([^}]*)\}/.exec(
        phone,
      ),
      "the full-screen sheets",
    )[1];
    expect(solid).toContain("background: var(--loki-bg);");
    expect(solid).toContain("backdrop-filter: none;");
  });

  test("covers U3: the top bar floats over its screen on a fade of the ground, with no blur of its own", () => {
    const bar = ruleOf(".loki-phone-topbar");
    expect(bar).toContain("position: absolute;");
    expect(bar).toMatch(/background: linear-gradient\(var\(--loki-bg\)[^;]*transparent\);/);
    expect(bar).not.toContain("border-bottom");
    expect(bar).not.toMatch(/backdrop-filter|transition|animation/);
  });

  test("covers U3: the bar's back and actions are glass capsules drawn from the tokens", () => {
    const group = ruleOf(".loki-phone-topbar-group");
    expect(group).toContain("background: var(--loki-glass);");
    expect(group).toContain("var(--loki-glass-edge)");
    expect(group).not.toMatch(/blur\(/);
  });

  test("covers U3: each screen's scroller starts below its own bar, and every page starts with none", () => {
    expect(ruleOf(".loki-phone-scroll")).toMatch(/padding-top: calc\(var\(--phone-top-clearance\) \+ var\(--phone-space-3\)\);/);
    expect(ruleOf(".loki-phone-scroll--flush")).toMatch(/padding-top: var\(--phone-top-clearance\);/);
    expect(ruleOf(".loki-phone-deck")).toMatch(/margin-top: calc\(var\(--phone-top-clearance\) \+ var\(--phone-space-1\)\);/);
    expect(must(/\n\.loki-phone-page,\s*\.loki-phone-inbox \{([^}]*)\}/.exec(phone), "the page rule")[1]).toContain("--phone-top-clearance: 0px;");
  });

  test("covers U3: Home's header and Search's bar float the same way, each measuring itself", () => {
    const home = readFileSync(join(APP, "phone", "home.tsx"), "utf8");
    const search = readFileSync(join(APP, "phone", "search.tsx"), "utf8");
    expect(home).toMatch(/<header ref=\{top\} className="loki-phone-topbar loki-phone-home-top">/);
    expect(search).toMatch(/<header ref=\{top\} className="loki-phone-topbar loki-phone-search-bar">/);
    for (const source of [home, search]) expect(source).toContain("const top = useTopClearance<HTMLElement>();");
    expect(home).not.toMatch(/<\/header>\s*\{banner\}|<HomeHeader[^>]*\/>\s*\{banner\}/);
    expect(ruleOf(".loki-phone-home-top")).not.toContain("background");
    expect(ruleOf(".loki-phone-search-bar")).not.toMatch(/background|border-bottom/);
  });

  test("covers U3: Home's menu pill and the search field are glass, drawn from the tokens", () => {
    for (const selector of [".loki-phone-home-actions", ".loki-phone-search-field"]) {
      const rule = ruleOf(selector);
      expect(rule).toContain("background: var(--loki-glass);");
      expect(rule).toContain("var(--loki-glass-edge)");
      expect(rule).not.toMatch(/blur\(/);
    }
  });

  test("covers U4: the conversation's header floats like a top bar, its links row riding inside it", () => {
    const screen = readFileSync(join(APP, "phone", "conversation-screen.tsx"), "utf8");
    expect(screen).toMatch(/<header ref=\{top\} className="loki-phone-topbar loki-phone-convo-head">/);
    const header = must(/<header ref=\{top\}[\s\S]*?<\/header>/.exec(screen), "the header")[0];
    expect(header).toContain("{links}");
    expect(screen).toMatch(/links=\{\s*view\.links\?\.length \|\| view\.advisor \? \(\s*<div className="loki-phone-links loki-chat-strips">/);
    expect(ruleOf(".loki-phone-convo-head")).not.toMatch(/background|border-bottom/);
  });

  test("covers U4: back and actions are glass circles; the agent's name is bare between them", () => {
    const circle = ruleOf(".loki-phone-circle");
    expect(circle).toContain("background: var(--loki-glass);");
    expect(circle).toContain("var(--loki-glass-edge)");
    const who = ruleOf(".loki-phone-convo-who");
    expect(who).toContain("background: transparent;");
    expect(who).toContain("border: none;");
  });

  test("covers U4: the thread runs under the header and the dock, padded by both their heights", () => {
    const thread = ruleOf(".loki-phone-convo-body [data-thread-scroll]");
    expect(thread).toMatch(/padding-top: calc\(var\(--phone-top-clearance\) \+ var\(--phone-space-4\)\) !important;/);
    expect(thread).toMatch(/padding-bottom: calc\(var\(--loki-dock-height\) \+ var\(--phone-space-4\)\) !important;/);
    expect(ruleOf(".loki-phone-convo-body")).toContain("position: relative;");
    const box = ruleOf('.loki-phone .loki-dock [data-slot="input-group"]');
    expect(box).toContain("background: var(--loki-glass-strong);");
    expect(box).toContain("backdrop-filter: var(--loki-glass-blur);");
  });

  test("covers U5: the controls that were under 44 points are 44 tall now", () => {
    for (const selector of [".loki-phone .loki-model-tab", ".loki-phone .loki-file-chip", ".loki-phone .loki-phone-search-input", ".loki-phone-search-clear"]) {
      expect(ruleOf(selector)).toContain("min-height: var(--phone-touch);");
    }
    expect(ruleOf(".loki-phone-search-field")).toContain("min-height: calc(var(--phone-touch) + 2px);");
  });

  test("covers U5: the small faces keep their size and take a 44-point target from an ::after", () => {
    const target: Record<string, string> = {
      ".loki-phone .loki-file-chip-remove::after": "inset: -8px;",
      ".loki-phone .loki-steps-line::after": "inset: -6px 0;",
      ".loki-phone .loki-steps-failure::after": "inset: -6px 0;",
      ".loki-phone .loki-chip.loki-suggestion-chip::after": "inset: -4px 0;",
    };
    for (const [selector, inset] of Object.entries(target)) {
      const rule = ruleOf(selector);
      expect(rule).toContain('content: "";');
      expect(rule).toContain("position: absolute;");
      expect(rule).toContain(inset);
      expect(ruleOf(selector.replace("::after", ""))).toContain("position: relative;");
    }
  });

  test("covers U4: the jump-to-latest chip sits above the floating dock, where it can be seen and tapped", () => {
    expect(ruleOf(".loki-phone-convo-body .loki-latest-chip")).toMatch(/bottom: calc\(var\(--loki-dock-height\) \+ var\(--phone-space-3\)\) !important;/);
  });

  test("a Flow card's thread ends above the card's floating dock, and its jump-to-latest chip rides above it", () => {
    const thread = ruleOf(".loki-phone-card [data-thread-scroll]");
    expect(thread).toMatch(/padding-bottom: calc\(var\(--loki-dock-height\) \+ var\(--phone-space-2\)\) !important;/);
    expect(thread).toContain("scroll-padding-bottom: var(--loki-dock-height);");
    expect(ruleOf(".loki-phone-card .loki-latest-chip")).toMatch(/bottom: calc\(var\(--loki-dock-height\) \+ var\(--phone-space-3\)\) !important;/);
  });

  test("the old navigation material is gone from the app", () => {
    const files = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        return statSync(path).isDirectory() ? files(path) : [path];
      });
    const users = files(APP).filter((path) => /--phone-nav-(surface|border)/.test(readFileSync(path, "utf8")));
    expect(users).toEqual([]);
  });
});

describe("a Flow card that is all message (plan 2026-11-19-2250)", () => {
  test("the folded reply box hands iOS no gesture, so it can drag up; the card body still scrolls (R3, R5)", () => {
    expect(ruleOf(".loki-phone-card [data-reply-handle]")).toMatch(/touch-action:\s*none;/);
    expect(ruleOf(".loki-phone-card [data-reply-handle] textarea")).toMatch(/pointer-events:\s*none;/);
    expect(ruleOf(".loki-phone-card")).toMatch(/touch-action:\s*pan-y;/);
    expect(ruleOf(".loki-phone-outside-scroll")).toMatch(/touch-action:\s*pan-y;/);
  });
  test("an email, Slack or Jira card keeps its reply box at the bottom while the thread scrolls above it", () => {
    expect(ruleOf(".loki-phone-outside-scroll")).toMatch(/overflow-y:\s*auto;/);
    expect(ruleOf(".loki-phone-outside-body")).not.toMatch(/overflow/);
    expect(ruleOf(".loki-phone-outside-reply")).toMatch(/flex:\s*none;/);
  });
  test("the card's ⋯ is a full touch target, and its thread shows no day pill (R8, R18)", () => {
    const more = ruleOf(".loki-phone-card-more");
    expect(more).toMatch(/width:\s*var\(--phone-touch\);/);
    expect(more).toMatch(/height:\s*var\(--phone-touch\);/);
    expect(phone).toMatch(
      /\.loki-phone \.loki-phone-card \.loki-msg-day-pill-wrap,\n\.loki-phone \.loki-phone-card \.loki-msg-day::before \{\n\s*display: none;/,
    );
  });
});

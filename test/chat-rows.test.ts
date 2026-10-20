import { describe, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ListRow, ListSection } from "../app/src/components/index.tsx";
import { DeskRow } from "../app/src/phone/home.tsx";
import type { DeskSummary } from "../core/frame-types.ts";
import { attentionItem } from "./fixtures/attention.ts";
import { toggleLabelTerm } from "../core/labels.ts";

/**
 * Chat rows the same on the Mac and the phone (plan 027): no lead, one line, and on the right the count while
 * something waits on you, the pulsing dot while a turn runs, else the time; an agent's face heads its section.
 */

const MINI = "bbbbbbbb-2222-4222-8222-222222222222";
const BOOK = "aaaaaaaa-1111-4111-8111-111111111111";
const desk = (over: Partial<DeskSummary> = {}): DeskSummary => ({
  scope: "conv-1",
  title: "Release checklist",
  status: "live",
  agent_name: "Friday",
  agent_id: "a1",
  conversation_id: "conv-1",
  model: null,
  reasoning_effort: null,
  widgets: 0,
  active: false,
  last_active: new Date(Date.now() - 3 * 3_600_000).toISOString(),
  ...over,
});
const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);

describe("the Mac's chat list", () => {
  test("a running chat shows the pulsing dot in its time's place", () => {
    const out = html(createElement(ListRow, { title: "Release checklist", time: "3h", live: true, liveAtEnd: true, onOpen: () => {} }));
    expect(out).toContain("loki-list-row-live--end");
    expect(out).not.toContain(">3h<");
    expect(out).not.toContain("loki-list-row-lead");
  });

  test("an agent's section carries its face in the icon's place", () => {
    const face = createElement("span", { className: "face" }, "F");
    const out = html(createElement(ListSection, { title: "Friday", icon: "pin", face, children: null }));
    expect(out).toContain('class="face"');
    expect(out).not.toContain("<svg");
  });
});

describe("the phone's chat list", () => {
  test("one line: the name and the time, no lead and no preview", () => {
    const out = html(createElement(DeskRow, { desk: desk(), mark: undefined, onActions: null }));
    expect(out).toContain(">Release checklist<");
    expect(out).toContain(">3h<");
    expect(out).not.toContain("loki-phone-row-preview");
    expect(out).not.toContain("loki-phone-row-icon");
  });

  test("waiting on you, the count; running, the pulsing dot; a chat away from its agent's Mac, the laptop", () => {
    const waiting = attentionItem("conv-1", { status: "question", unread: true });
    expect(html(createElement(DeskRow, { desk: desk(), mark: waiting, onActions: null }))).toMatch(/loki-phone-badge">1</);
    const running = attentionItem("conv-1", { status: "running" });
    expect(html(createElement(DeskRow, { desk: desk(), mark: running, onActions: null }))).toContain("loki-phone-row-live");
    const homes = { here: BOOK, of: () => ({ mac: BOOK, name: "MacBook" }) };
    const away = html(createElement(DeskRow, { desk: desk({ home: MINI, home_name: "Mac mini" }), mark: undefined, onActions: null, homes }));
    expect(away).toContain('title="lives on Mac mini, away from its agent');
  });
});

describe("Home's label chips (plan 028)", () => {
  test("a chip adds its label to the filter, and a second tap takes it out, the rest kept in order", () => {
    expect(toggleLabelTerm("", "long")).toBe("label:long");
    expect(toggleLabelTerm("deploy", "long")).toBe("deploy label:long");
    expect(toggleLabelTerm("label:long deploy label:infra", "long")).toBe("deploy label:infra");
    expect(toggleLabelTerm("label:Long", "long")).toBe("");
  });
});

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { MailCompose } from "../core/frame-types.ts";
import { ThemeProvider } from "../app/src/theme.tsx";
import { ItemReplyBox } from "../app/src/item/reply-box.tsx";
import { MailAddressLine, startAddressing } from "../app/src/desk/mail-address.tsx";

// The mail reply box under Liquid Glass (plan 2026-11-12-1505, R7, R10): Apple's words, title case on controls, and
// send's key in its tooltip rather than on the box. ThemeProvider reads the palette from storage.

const noop = () => {};
let saved: Storage | undefined;
const withPalette = (palette: string | null) => {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: (key: string) => (key === "loki.palette" ? palette : null), setItem: noop },
  });
};
const html = (el: ReactElement) => renderToStaticMarkup(createElement(ThemeProvider, null, el));

const compose: MailCompose = {
  modes: { reply: { to: ["Maren <maren@example.com>"], cc: [] }, reply_all: { to: ["Maren <maren@example.com>"], cc: ["Odd <odd@example.com>"] } },
  from: [{ address: "harbour@example.com", name: "Harbour Master" }],
  default_from: "harbour@example.com",
  subject: "Re: Spring timetable",
  people: [],
} as unknown as MailCompose;

const box = () =>
  createElement(ItemReplyBox, {
    isMail: true,
    target: "reply",
    mentions: null,
    field: { value: "", placeholder: "reply", "aria-label": "reply" } as never,
    signature: { text: "", toggle: noop },
    quote: null,
    send: { busy: false, disabled: false, title: "send it as you; the card stays", keys: "⌘↵", onSend: noop },
    discard: { disabled: false, onDiscard: noop },
    error: null,
    actions: null,
  });
const line = (open: boolean) => createElement(MailAddressLine, { compose, value: startAddressing(compose), onChange: noop, open, onOpen: noop });

beforeEach(() => {
  saved = globalThis.localStorage;
});
afterEach(() => {
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: saved });
});

describe("the mail reply box under Liquid Glass", () => {
  test("titles its controls, writes sentences elsewhere, and keeps send's key in the tooltip", () => {
    withPalette("apple");
    const out = html(box());
    expect(out).toContain(">Discard</button>");
    expect(out).toContain("Add Signature");
    expect(out).toContain("No signature");
    expect(out).toContain('placeholder="Reply"');
    expect(out).toContain('title="Send it as you; the card stays (⌘↵)"');
    expect(out).not.toContain("<kbd");
  });

  test("names the modes and Done in title case and its rows To, Cc and Bcc", () => {
    withPalette("apple");
    expect(html(line(false))).toContain("Reply All");
    const open = html(line(true));
    expect(open).toContain(">Done</button>");
    for (const row of ["To", "Cc", "Bcc"]) expect(open).toContain(`>${row}<`);
    expect(open).toContain('placeholder="Name or address"');
  });
});

describe("today's look", () => {
  test("keeps its lowercase words and the key on the box", () => {
    withPalette(null);
    const out = html(box());
    expect(out).toContain(">discard</button>");
    expect(out).toContain("<kbd");
    expect(html(line(true))).toContain(">done</button>");
  });
});

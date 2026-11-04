import { describe, expect, test } from "vitest";
import { addressesIn, isDirectMail } from "../core/mail-filter.ts";

const OWN = ["ada@acme.com", "ada@example.org"];
const h = (headers: Record<string, string>) => Object.entries(headers).map(([name, value]) => ({ name, value }));
const colleague = { From: "Grace Hopper <grace@acme.com>", To: "Team <team@acme.com>", Subject: "Budget" };

describe("whether a mail is to the person, from a person (R5, KTD6)", () => {
  test("a colleague's mail with the person in Cc is direct (AE1)", () => {
    expect(isDirectMail(h({ ...colleague, Cc: "Bob <bob@acme.com>, Ada Lovelace <ADA@acme.com>" }), OWN)).toBe(true);
  });

  test("the person in To is direct; in neither To nor Cc it is not", () => {
    expect(isDirectMail(h({ ...colleague, To: "ada@acme.com" }), OWN)).toBe(true);
    expect(isDirectMail(h(colleague), OWN)).toBe(false);
  });

  test("a mail to one of the person's send-as aliases counts as to them", () => {
    expect(isDirectMail(h({ ...colleague, To: '"Ada" <ada@example.org>' }), OWN)).toBe(true);
  });

  test("an address inside a quoted display name is not the recipient", () => {
    expect(isDirectMail(h({ ...colleague, To: '"ada@acme.com, via the list" <list@acme.com>' }), OWN)).toBe(false);
  });

  test("mailing lists, newsletters and automated mail are not direct, even with the person in To (AE1)", () => {
    const toAda = { ...colleague, To: "ada@acme.com" };
    expect(isDirectMail(h({ ...toAda, "List-Unsubscribe": "<mailto:unsub@news.example>" }), OWN)).toBe(false);
    expect(isDirectMail(h({ ...toAda, "List-Id": "eng.acme.com" }), OWN)).toBe(false);
    expect(isDirectMail(h({ ...toAda, "Auto-Submitted": "auto-generated" }), OWN)).toBe(false);
    expect(isDirectMail(h({ ...toAda, "X-Auto-Response-Suppress": "All" }), OWN)).toBe(false);
    for (const p of ["bulk", "List", "junk"]) expect(isDirectMail(h({ ...toAda, Precedence: p }), OWN)).toBe(false);
  });

  test("Auto-Submitted: no is a person's mail", () => {
    expect(isDirectMail(h({ ...colleague, To: "ada@acme.com", "auto-submitted": " No " }), OWN)).toBe(true);
  });

  test("a no-reply sender is not a person", () => {
    for (const from of ["GitHub <noreply@github.com>", "no-reply@accounts.example", "DoNotReply@bank.example", "MAILER-DAEMON@acme.com", "no_reply-42@x.io"])
      expect([from, isDirectMail(h({ ...colleague, From: from, To: "ada@acme.com" }), OWN)]).toEqual([from, false]);
    // A name that merely starts like one is a person.
    expect(isDirectMail(h({ ...colleague, From: "Noreen <noreen@acme.com>", To: "ada@acme.com" }), OWN)).toBe(true);
  });
});

describe("the addresses in a header", () => {
  test("bare, bracketed and quoted names with commas, in lower case", () => {
    expect(addressesIn('"Lovelace, Ada" <Ada@Acme.com>, bob@acme.com; Grace <grace@acme.com>')).toEqual(["ada@acme.com", "bob@acme.com", "grace@acme.com"]);
  });
});

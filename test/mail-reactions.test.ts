import { describe, expect, test } from "vitest";
import { GoogleError } from "../mod/google-auth.ts";
import { MailReactions, reactionOf } from "../mod/mail-reactions.ts";
import { emojiName, reactionEmoji } from "../mod/slack-markup.ts";
import type { GmailMessage, GmailMessagePart } from "../mod/gmail.ts";

const b64 = (text: string): string => Buffer.from(text, "utf8").toString("base64url");
const part = (mimeType: string, text: string, extra: Partial<GmailMessagePart> = {}): GmailMessagePart => ({
  mimeType,
  filename: "",
  headers: [],
  body: { data: b64(text), size: text.length },
  parts: [],
  ...extra,
});
const multipart = (mimeType: string, parts: GmailMessagePart[]): GmailMessagePart => ({ mimeType, filename: "", headers: [], body: { size: 0 }, parts });
const mail = (payload: GmailMessagePart): GmailMessage => ({
  id: "m1",
  threadId: "t1",
  labelIds: ["INBOX"],
  snippet: "",
  historyId: "1",
  internalDate: "0",
  payload,
});

const REACTION = "text/vnd.google.email-reaction+json";
const thumbs = () => part(REACTION, JSON.stringify({ emoji: "👍", version: 1 }));
const gmailReaction = () =>
  multipart("multipart/alternative", [part("text/plain", "Ben reacted via Gmail"), thumbs(), part("text/html", "<p>Ben reacted via Gmail</p>")]);

describe("recognising a Gmail reaction mail", () => {
  test("a mail whose alternative carries a reaction part is a reaction with its emoji", () => {
    expect(reactionOf(mail(gmailReaction()))).toBe("👍");
  });

  test("the reaction part may sit deeper in the mail's own tree", () => {
    expect(reactionOf(mail(multipart("multipart/mixed", [gmailReaction(), part("text/plain", "Sent from my workplace")])))).toBe("👍");
  });

  test("a mail that forwards or attaches a reaction mail stays a mail", () => {
    const forwarded = multipart("message/rfc822", [gmailReaction()]);
    expect(reactionOf(mail(multipart("multipart/mixed", [part("text/plain", "See below"), forwarded])))).toBeNull();
    const attached = part(REACTION, JSON.stringify({ emoji: "👍", version: 1 }), { filename: "reaction.json" });
    expect(reactionOf(mail(multipart("multipart/mixed", [part("text/plain", "Attached"), attached])))).toBeNull();
  });

  test("a reaction part with another version, broken JSON or no emoji is not a reaction", () => {
    const shaped = (body: string) => mail(multipart("multipart/alternative", [part("text/plain", "x"), part(REACTION, body)]));
    expect(reactionOf(shaped(JSON.stringify({ emoji: "👍", version: 2 })))).toBeNull();
    expect(reactionOf(shaped("{not json"))).toBeNull();
    expect(reactionOf(shaped(JSON.stringify({ emoji: "", version: 1 })))).toBeNull();
    expect(reactionOf(shaped(JSON.stringify({ version: 1 })))).toBeNull();
  });

  test("plain and HTML mails are not reactions, nor is a mail read without its parts", () => {
    expect(reactionOf(mail(part("text/plain", "Hello")))).toBeNull();
    expect(reactionOf(mail(multipart("multipart/alternative", [part("text/plain", "Hi"), part("text/html", "<p>Hi</p>")])))).toBeNull();
    expect(reactionOf({ ...mail(gmailReaction()), payload: null })).toBeNull();
  });
});

describe("naming a reaction's emoji", () => {
  test("a standard emoji takes the name Slack keeps, with its skin tone, and reads back to the same emoji", () => {
    expect(emojiName("👍")).toBe("+1");
    expect(emojiName("👍🏽")).toBe("+1::skin-tone-4");
    expect(reactionEmoji("+1::skin-tone-4", {})?.text).toBe("👍🏽");
  });

  test("an emoji with or without its variation selector has one name", () => {
    expect(emojiName("✅")).toBe("white_check_mark");
    expect(emojiName("✅\u{FE0F}")).toBe("white_check_mark");
    expect(emojiName("❤")).toBe(emojiName("❤\u{FE0F}"));
  });

  test("an emoji with no name gets one made of its code points, which reads back to it", () => {
    const family = "👩🏽‍🤝‍👨🏿";
    const name = emojiName(family);
    expect(name).toMatch(/^[\w+'-]{1,100}$/);
    expect(reactionEmoji(name, {})?.text).toBe(family);
  });

  test("a Slack workspace's own emoji keeps its name even when it looks like a code-point name, and an impossible one draws nothing", () => {
    expect(reactionEmoji("cp-1f44d", { emoji: (n) => (n === "cp-1f44d" ? "https://emoji.slack.test/cp.png" : null) })).toEqual({
      kind: "emoji",
      text: ":cp-1f44d:",
      image: "https://emoji.slack.test/cp.png",
    });
    expect(reactionEmoji("cp-facade", {})).toBeNull();
  });
});

describe("one verdict per Gmail message", () => {
  const headers = (extra: Array<{ name: string; value: string }>) => ({ ...multipart("multipart/alternative", []), headers: extra });
  const metadata = (id: string, extra: Array<{ name: string; value: string }>): GmailMessage => ({ ...mail(headers(extra)), id });
  const REPLY = [
    { name: "In-Reply-To", value: "<a@mail.test>" },
    { name: "Content-Type", value: 'multipart/alternative; boundary="b"' },
  ];
  const fetching = (answer: (id: string) => Promise<GmailMessage>) => {
    const asked: string[] = [];
    const reactions = new MailReactions({
      getMessage: (id) => {
        asked.push(id);
        return answer(id);
      },
    });
    return { reactions, asked };
  };

  test("a mail read in full is answered without a fetch", async () => {
    const { reactions, asked } = fetching(() => Promise.reject(new Error("not asked")));
    expect(reactions.saw({ ...mail(gmailReaction()), id: "r1" })).toBe("👍");
    expect(await reactions.of(metadata("r1", REPLY))).toBe("👍");
    expect(asked).toEqual([]);
  });

  test("a mail that answers nothing, or is not multipart, is a mail with no fetch", async () => {
    const { reactions, asked } = fetching(() => Promise.reject(new Error("not asked")));
    expect(await reactions.of(metadata("m1", [{ name: "Content-Type", value: "multipart/alternative" }]))).toBeNull();
    expect(
      await reactions.of(
        metadata("m2", [
          { name: "In-Reply-To", value: "<a@mail.test>" },
          { name: "Content-Type", value: "text/plain" },
        ]),
      ),
    ).toBeNull();
    expect(asked).toEqual([]);
  });

  test("a candidate is fetched once, then answered from memory", async () => {
    const { reactions, asked } = fetching((id) => Promise.resolve({ ...mail(gmailReaction()), id }));
    expect(await reactions.of(metadata("r1", REPLY))).toBe("👍");
    expect(await reactions.of(metadata("r1", REPLY))).toBe("👍");
    expect(reactions.known(metadata("r1", REPLY))).toBe("👍");
    expect(asked).toEqual(["r1"]);
  });

  test("a rate limit or a server error throws so sync tries again; another refusal counts as a mail and is asked again", async () => {
    const failing = (status: number, reason: string | null) => fetching(() => Promise.reject(new GoogleError("no", status, reason))).reactions;
    await expect(failing(429, null).of(metadata("r1", REPLY))).rejects.toThrow("no");
    await expect(failing(500, null).of(metadata("r1", REPLY))).rejects.toThrow("no");
    await expect(failing(403, "rateLimitExceeded").of(metadata("r1", REPLY))).rejects.toThrow("no");
    const { reactions, asked } = fetching(() => Promise.reject(new GoogleError("gone", 404, "notFound")));
    expect(await reactions.of(metadata("r1", REPLY))).toBeNull();
    expect(await reactions.of(metadata("r1", REPLY))).toBeNull();
    expect(asked).toEqual(["r1", "r1"]);
  });

  test("past ten thousand verdicts the oldest is forgotten", () => {
    const { reactions } = fetching(() => Promise.reject(new Error("not asked")));
    for (let i = 0; i <= 10_000; i++) reactions.saw({ ...mail(gmailReaction()), id: `r${i}` });
    expect(reactions.known(metadata("r0", REPLY))).toBeUndefined();
    expect(reactions.known(metadata("r10000", REPLY))).toBe("👍");
  });
});

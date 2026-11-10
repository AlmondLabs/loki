import { describe, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { OutsideReach } from "../core/frame-types.ts";
import { REACH_LABEL, REACH_LEVEL, mailReach, slackReach } from "../core/outside-reach.ts";
import { CardFace, CardHead, ReachTag } from "../app/src/desk/card-head.tsx";

/** Every Inbox card's header (plan 073): who, where or what, and how directly it is meant for the person. */

describe("how directly a card is meant for the person", () => {
  test("a mail sent by a machine or a list reads as that even when it is addressed to the person", () => {
    expect(mailReach({ to_you: true, list: false, automated: true, category: null })).toBe("automated");
    expect(mailReach({ to_you: true, list: true, automated: false, category: null })).toBe("list");
    expect(mailReach({ to_you: true, list: false, automated: false, category: null })).toBe("to_you");
    expect(mailReach({ to_you: false, list: false, automated: false, category: null })).toBe("not_to_you");
    expect(mailReach(null)).toBeNull();
  });

  test("a Slack DM is direct; otherwise the most direct of the Activity kinds wins", () => {
    expect(slackReach(true, ["at_channel"])).toBe("dm");
    expect(slackReach(false, ["at_channel", "at_user"])).toBe("mention");
    expect(slackReach(false, ["at_everyone"])).toBe("channel");
    expect(slackReach(false, ["thread_v2", "at_user_group"])).toBe("thread");
    expect(slackReach(false, ["message_reaction"])).toBeNull();
  });

  test("a Jira ticket assigned to the person sits with their own thread, and one they only watch with their group", () => {
    expect([REACH_LEVEL.assigned, REACH_LABEL.assigned]).toEqual([3, "assigned to you"]);
    expect([REACH_LEVEL.watching, REACH_LABEL.watching]).toEqual([4, "watching"]);
  });

  test("every reach has a level and lowercase words", () => {
    for (const r of Object.keys(REACH_LEVEL) as OutsideReach[]) expect(REACH_LABEL[r]).toBe(REACH_LABEL[r].toLowerCase());
  });
});

describe("the header", () => {
  const head = (reach: OutsideReach) =>
    renderToStaticMarkup(
      createElement(CardHead, {
        face: createElement(CardFace, { name: "Grace Hopper", src: null, mark: "slack" }),
        who: "Grace Hopper",
        line: "#general",
        right: createElement(ReachTag, { reach }),
      }),
    );

  test("shows who, where, the mark of where it came from and the tag", () => {
    const html = head("channel");
    expect(html).toContain("Grace Hopper");
    expect(html).toContain("#general");
    expect(html).toContain('class="loki-card-mark loki-card-mark--slack"');
    expect(html).toContain('aria-label="from Slack"');
    expect(html).toContain("@channel");
  });

  test("a Jira card's face carries its own mark", () => {
    const html = renderToStaticMarkup(createElement(CardFace, { name: "Grace Hopper", src: null, mark: "jira" }));
    expect(html).toContain('class="loki-card-mark loki-card-mark--jira"');
    expect(html).toContain('aria-label="from Jira"');
    expect(html).toContain("◆");
  });

  test("only the top of the scale takes the attention dot, and the bottom steps back", () => {
    expect(head("dm")).toContain("loki-reach--direct");
    expect(head("mention")).not.toMatch(/loki-reach--(direct|quiet)/);
    expect(head("automated")).toContain("loki-reach--quiet");
  });
});

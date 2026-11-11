import { describe, expect, test } from "bun:test";
import { CARD_SHOWING_MS, ReplyNotices, WAITING_MS, shortBotName } from "../replyNotices.ts";

function clock() {
  let t = 1_000_000;
  return { now: () => t, tick: (ms: number) => { t += ms; } };
}

describe("reply notifications: one per bot, none for seen replies", () => {
  test("a second reply from the same bot adds no notification until the user looks", () => {
    const c = clock(), n = new ReplyNotices(c.now);
    expect(n.decide("jarvis", ["r1"])).toBe("notify");
    expect(n.decide("jarvis", ["r2"])).toBe("covered");
    n.looked("jarvis"); // Open or Close on the notification
    expect(n.decide("jarvis", ["r3"])).toBe("notify");
  });

  test("different bots each get their own one notification", () => {
    const n = new ReplyNotices(clock().now);
    expect(n.decide("jarvis", ["a"])).toBe("notify");
    expect(n.decide("jerome", ["b"])).toBe("notify");
    expect(n.decide("jarvis", ["c"])).toBe("covered");
    expect(n.decide("jerome", ["d"])).toBe("covered");
  });

  test("a reply already shown in the card's chat never notifies", () => {
    const c = clock(), n = new ReplyNotices(c.now);
    n.cardShowing("jarvis", ["r1"]);
    c.tick(CARD_SHOWING_MS * 10);
    expect(n.decide("jarvis", ["r1"])).toBe("seen");
  });

  test("a reply while the card shows that chat waits, then notifies once the notch closed", () => {
    const c = clock(), n = new ReplyNotices(c.now);
    n.cardShowing("jarvis", []);
    expect(n.decide("jarvis", ["r1"])).toBe("wait");
    c.tick(CARD_SHOWING_MS + 1); // the card stopped reading: the notch is closed
    expect(n.decide("jarvis", ["r1"])).toBe("notify");
  });

  test("the card showing another bot does not hold this bot back", () => {
    const n = new ReplyNotices(clock().now);
    n.cardShowing("jerome", ["x"]);
    expect(n.decide("jarvis", ["r1"])).toBe("notify");
  });

  test("viewing the bot's chat in the card lets its next reply notify again", () => {
    const c = clock(), n = new ReplyNotices(c.now);
    expect(n.decide("jarvis", ["r1"])).toBe("notify");
    n.cardShowing("jarvis", ["r1"]);
    c.tick(CARD_SHOWING_MS + 1);
    expect(n.decide("jarvis", ["r2"])).toBe("notify");
  });

  test("a failed notification does not block the next one", () => {
    const n = new ReplyNotices(clock().now);
    expect(n.decide("jarvis", ["r1"])).toBe("notify");
    n.failed("jarvis");
    expect(n.decide("jarvis", ["r2"])).toBe("notify");
  });

  test("a swiped-away notification cannot silence a bot for good", () => {
    const c = clock(), n = new ReplyNotices(c.now);
    expect(n.decide("jarvis", ["r1"])).toBe("notify");
    c.tick(WAITING_MS + 1);
    expect(n.decide("jarvis", ["r2"])).toBe("notify");
  });
});

describe("the name a notification says", () => {
  test("drops the team suffix, so VoiceOS shows the bot and not Grok Bot", () => {
    expect(shortBotName("jarvis · VoiceOS")).toBe("jarvis");
    expect(shortBotName("Jerome · BISV Hacks")).toBe("Jerome");
    expect(shortBotName("Assistant")).toBe("Assistant");
  });
});

import { test, expect } from "bun:test";
import { recordCardPoll, cardCovers, CARD_FRESH_MS } from "../cardWatch.ts";

test("no card poll → pills are not suppressed", () => {
  expect(cardCovers("a", "r1", 1000)).toBe(false);
});

test("card is polling and the bot is busy → covered (card will show the reply)", () => {
  recordCardPoll("b", { busy: true }, 1000);
  expect(cardCovers("b", "r1", 1000 + CARD_FRESH_MS - 1)).toBe(true);
});

test("card stopped polling long ago → pills resume", () => {
  recordCardPoll("c", { busy: true }, 1000);
  expect(cardCovers("c", "r1", 1000 + CARD_FRESH_MS + 1)).toBe(false);
});

test("card showed the final reply and went idle → a later, different reply is NOT covered", () => {
  recordCardPoll("d", { replyId: "r1", busy: false }, 1000);
  expect(cardCovers("d", "r1", 1500)).toBe(true);
  expect(cardCovers("d", "r2", 1500)).toBe(false);
});

test("a reply the card already showed stays covered", () => {
  recordCardPoll("e", { replyId: "r1", busy: true }, 1000);
  expect(cardCovers("e", "r1", 1000 + CARD_FRESH_MS * 5)).toBe(true);
});

test("another bot's card does not cover this bot", () => {
  recordCardPoll("f", { busy: true }, 1000);
  expect(cardCovers("g", "r1", 1000)).toBe(false);
});

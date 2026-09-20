/**
 * Tracks which bots the screen card is actively showing replies for, so the
 * server's reply watcher can stay quiet (no notch pill) for replies the card
 * already displays. The card polls grokbot_reply_check; each poll is recorded
 * here. Pure in-memory state — a restart just means pills resume, never lost.
 */

/** A card that polled this recently is presumed to still be watching (it polls every ~4s). */
export const CARD_FRESH_MS = 8_000;

interface CardView { at: number; live: boolean; shown: Set<string> }
const views = new Map<string, CardView>();

/**
 * Record one poll. `replyId` is the reply the card was just handed (if any).
 * The card stops polling once the bot has answered AND gone idle, so that poll
 * marks the view not-live: anything landing after it is NOT covered by the card.
 */
export function recordCardPoll(botId: string, o: { replyId?: string; busy: boolean }, now = Date.now()): void {
  const v = views.get(botId) ?? { at: now, live: true, shown: new Set<string>() };
  v.at = now;
  if (o.replyId) v.shown.add(o.replyId);
  v.live = !(o.replyId && !o.busy);
  views.set(botId, v);
}

/** True when the card has already shown this reply, or is still polling and will show it. */
export function cardCovers(botId: string, replyId: string | undefined, now = Date.now()): boolean {
  const v = views.get(botId);
  if (!v) return false;
  if (replyId && v.shown.has(replyId)) return true;
  return v.live && now - v.at < CARD_FRESH_MS;
}

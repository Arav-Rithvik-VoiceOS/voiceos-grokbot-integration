/**
 * "<bot> replied" notifications: at most one per bot, never for a reply the
 * user already saw. The same rules as Muse's NotificationCoordinator, kept per
 * bot so Jarvis and Jerome can each have one waiting.
 *
 *  - One per bot: once a bot's notification is up, more replies from that bot
 *    add none until the user looks at that bot again (Open or Close on the
 *    notification, or its chat on screen in the card, which is also where a
 *    send from the card or by voice lands).
 *  - Seen in the card: a reply the open card's chat pane already showed never
 *    notifies. The pane reads its chat only while the card is visible, so a
 *    recent read means the user has that chat on screen; a reply there waits
 *    until the card stops reading (the notch closed), then notifies.
 *
 * Pure in-memory state: a restart forgets it, so at worst one more notification.
 */

/**
 * The name a notification says: the bot's own name without its " · team"
 * suffix ("jarvis · VoiceOS" → "jarvis"). VoiceOS refuses a sender name that
 * contains "VoiceOS" (no one may pose as the app) and would show "Grok Bot".
 */
export const shortBotName = (name: string): string =>
  (name.split(" · ")[0] ?? "").trim().slice(0, 64) || name.trim().slice(0, 64) || "Bot";

/** The chat pane reads its bot every few seconds while visible; a read this recent means it is still on screen. */
export const CARD_SHOWING_MS = 12_000;
/**
 * VoiceOS does not tell the app when a notification is swiped away, so a
 * waiting mark ends on its own after this long: a dismissed notification can
 * never silence a bot for good.
 */
export const WAITING_MS = 30 * 60_000;

export type ReplyDecision =
  /** Every reply was already shown in the card: drop it. */
  | "seen"
  /** The card is showing this bot's chat right now: check again later. */
  | "wait"
  /** This bot's notification is already up: it covers this reply. */
  | "covered"
  /** Notify now (the bot is marked as waiting). */
  | "notify";

export class ReplyNotices {
  private readonly waiting = new Map<string, number>();
  private readonly card = new Map<string, { at: number; shown: Set<string> }>();
  constructor(private readonly now: () => number = Date.now) {}

  /** The card's chat pane read this bot while visible: the user has these replies on screen. */
  cardShowing(botId: string, replyIds: Iterable<string | undefined>): void {
    const view = this.card.get(botId) ?? { at: 0, shown: new Set<string>() };
    view.at = this.now();
    for (const id of replyIds) if (id) view.shown.add(id);
    this.card.set(botId, view);
    this.waiting.delete(botId);
  }

  /** The user looked at this bot (Open or Close on its notification). */
  looked(botId: string): void {
    this.waiting.delete(botId);
  }

  /** What to do with these new replies from one bot. "notify" reserves the bot's one notification. */
  decide(botId: string, replyIds: readonly (string | undefined)[]): ReplyDecision {
    const view = this.card.get(botId);
    if (view && replyIds.length && replyIds.every((id) => !!id && view.shown.has(id))) return "seen";
    if (view && this.now() - view.at < CARD_SHOWING_MS) return "wait";
    const since = this.waiting.get(botId);
    if (since !== undefined && this.now() - since < WAITING_MS) return "covered";
    this.waiting.set(botId, this.now());
    return "notify";
  }

  /** The notification did not go out: the next reply may try again. */
  failed(botId: string): void {
    this.waiting.delete(botId);
  }
}

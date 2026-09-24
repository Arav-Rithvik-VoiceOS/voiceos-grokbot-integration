import { IntegrationError, normalize, type Agent, type TranscriptEntry } from "./client.ts";

export const PREPARE_DESCRIPTION = "Check the live Grok Bot roster before opening a message. Use FIRST for group messages or when recipient identity is uncertain; single-bot fast intents can call grokbot_send directly. Pass names as the user said them. This read-only lookup does not send. On success call nextTool with the returned args. On failure stop and explain the recipient could not be found; do not guess another bot, create a bot, or retry automatically.";
export const SEND_DESCRIPTION = "Open the live chat with one Grok Bot, with the user's message typed into the card's message box. Use when the user asks to message, ask, or tell one bot something. It does NOT send: the user reviews the draft and presses send in the card, then keeps chatting there. Accepts a known bot name or an exact ID from grokbot_prepare_message. Unknown, ambiguous, or group recipients are rejected; do not substitute another bot. After it opens, tell the user their draft is ready to send.";
export const GROUP_DESCRIPTION = "Open a Grok Bot group chat (an existing group, or a new one from the named bots), with the user's message typed into the card's message box. Use when the user asks to message several bots or a group. It does NOT send: the user can edit the draft, group name and members, then presses send in the card and keeps chatting there. Use AFTER grokbot_prepare_message succeeds for this request, copying its returned args including resolved group/member IDs. Never call after a missing or ambiguous recipient lookup.";
export const THREAD_DESCRIPTION = "Read what one Grok Bot teammate said, found, or did. Use for ANY question about a bot's messages or results: what it said, summarize its work, answer a question from it, or draft something from it. Returns the message text in `thread`; read it and do what the user asked in your own words. Set show only when the user asks to see or open the conversation.";
// The card composer's send — the ONLY tool that sends a message. It has no
// confirmation block: the user typed the text and pressed send inside the card,
// which is the approval. The model must not pick it.
export const CARD_SEND_DESCRIPTION = "Internal — called only by the Grok Bot card's message box, never by voice. Do not call this tool; for a spoken request use grokbot_send or grokbot_group, which open the card with the draft for the user to send.";
export const CONTEXT_DESCRIPTION = "Internal: copy confirmationContext unchanged from the successful grokbot_prepare_message result, if present. Never compose it yourself.";

/** Sending requires an exact identity: partial matching can target another bot. */
export function resolveMessageRecipient(value: string, agents: Agent[]): Agent {
  const token = value.trim();
  const byId = agents.find(a => a.id === token);
  if (byId) return byId;
  const name = normalize(token);
  const matches = name ? agents.filter(a => normalize(a.name) === name) : [];
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) throw new IntegrationError("not_found", `More than one conversation is named "${token}". Which one do you mean?`);
  throw new IntegrationError("not_found", `I couldn't find a bot or group called "${token}" in the current roster. If you just created it, it may not be available yet. Try again once it appears in Grok Bot.`);
}

export interface MessageArgs {
  bot?: string;
  group?: string;
  members?: string | string[];
  groupName?: string;
  message?: string;
}

export function resolveMessageGroup(args: MessageArgs, agents: Agent[]) {
  const groups = agents.filter(a => a.isGroup);
  const bots = agents.filter(a => !a.isGroup);
  const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every(id => b.includes(id));
  let existing = args.group !== undefined ? resolveMessageRecipient(args.group, groups) : undefined;
  const tokens = args.members === undefined && existing ? existing.memberIds ?? []
    : (Array.isArray(args.members) ? args.members : String(args.members ?? "").split(",")).map(t => t.trim()).filter(Boolean);
  const memberIds = [...new Set(tokens.map(t => resolveMessageRecipient(t, bots).id))];
  if (!existing && memberIds.length >= 2) {
    const matches = groups.filter(a => sameSet(a.memberIds ?? [], memberIds));
    if (matches.length > 1) throw new IntegrationError("not_found", "More than one group has those bots. Name the group you want to message.");
    existing = matches[0];
  }
  return { existing, memberIds, bots, sameSet };
}

// ── Thread text for the model ────────────────────────────────────────────────
//
// The model cannot see a card, only the result JSON. So a thread read returns
// the message text itself; the model then answers any question from it. The
// size limit keeps a long research dump from filling the model's context.
export const THREAD_CHAR_BUDGET = 12000;

export interface ThreadLine { from: string; text: string; at?: string }

/** Transcript entries → plain lines for the model, oldest first. Walks from the
 * newest entry back and stops when the size limit is full, so the newest
 * messages always survive; a message that only fits in part is cut at its end. */
export function threadForModel(bot: Agent, entries: TranscriptEntry[], budget = THREAD_CHAR_BUDGET) {
  const lines: ThreadLine[] = [];
  for (const e of entries) {
    let text = "";
    let from = bot.name;
    if (e.kind === "send-message") {
      const m = e.message;
      text = typeof m === "string" ? m : String((m as Record<string, unknown> | null)?.content ?? "");
      from = e.author?.name ?? bot.name;
    } else if (e.kind === "message") {
      text = String(e.content ?? "");
      const isUser = String(e.role ?? "").toLowerCase() === "user";
      from = isUser ? (e.fromAgent?.name ?? "user") : (e.fromAgent?.name ?? bot.name);
    } else {
      continue; // tool calls and other internal entries are not conversation
    }
    text = text.trim();
    if (!text) continue;
    lines.push({ from, text, ...(e.timestampMs ? { at: new Date(e.timestampMs).toISOString() } : {}) });
  }
  const thread: ThreadLine[] = [];
  let left = budget;
  let truncated = false;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line.text.length > left) {
      truncated = true;
      if (left >= 200) thread.unshift({ ...line, text: line.text.slice(0, left - 1) + "…" });
      break;
    }
    thread.unshift(line);
    left -= line.text.length;
  }
  return { thread, truncated };
}

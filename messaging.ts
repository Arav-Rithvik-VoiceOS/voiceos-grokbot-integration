import { IntegrationError, normalize, type Agent, type TranscriptEntry } from "./client.ts";
import { CONNECT_TYPES, entryState } from "./requestState.ts";

export const PREPARE_DESCRIPTION = "Check the live Grok Bot roster before opening a message. Use FIRST for group messages or when recipient identity is uncertain; single-bot fast intents can call grokbot_send directly. Pass names as the user said them. This read-only lookup does not send. On success call nextTool with the returned args. On failure stop and explain the recipient could not be found; do not guess another bot, create a bot, or retry automatically.";
export const SEND_DESCRIPTION = "Send the user's message to one Grok Bot right away, then open its live chat, where the user keeps chatting. The message goes out as written, so write it TO the bot the way the user would type it ('ask Pepper how the test is going' → 'How's the test going?'). Use when the user asks to message, ask, or tell one bot something. Accepts a known bot name or an exact ID from grokbot_prepare_message. Unknown, ambiguous, or group recipients are rejected; do not substitute another bot. After it returns, tell the user the message was sent.";
export const GROUP_DESCRIPTION = "Send the user's message to a Grok Bot group chat right away (an existing group, or a new one created from two or more named bots), then open that group's live chat. Use when the user asks to message several bots or a group. Spoken member or name changes are saved before it sends. Without a message, or with fewer than two bots for a new group, it only opens the group pane. Use AFTER grokbot_prepare_message succeeds for this request, copying its returned args including resolved group/member IDs. Never call after a missing or ambiguous recipient lookup.";
export const THREAD_DESCRIPTION = "Read what one Grok Bot teammate said, found, or did. Use for ANY question about a bot's messages or results: what it said, summarize its work, answer a question from it, or draft something from it. Returns the message text in `thread`; read it and do what the user asked in your own words. Set show only when the user asks to see or open the conversation. Accounts a bot needs (Gmail, Google Calendar, Slack, …) cannot be connected by voice or in VoiceOS: tell the user to press \"Open in Grok Bot\" on that request in the bot's card, or open the bot's chat in the Grok Bot app, and connect it there.";
// The card composer's send — the ONLY tool that sends a message. It has no
// confirmation block: the user typed the text and pressed send inside the card,
// which is the approval. The model must not pick it.
export const CARD_SEND_DESCRIPTION = "Internal — called only by the Grok Bot card's message box, never by voice. Do not call this tool; for a spoken request use grokbot_send or grokbot_group.";
export const CONTEXT_DESCRIPTION = "Internal: copy confirmationContext unchanged from the successful grokbot_prepare_message result, if present. Never compose it yourself.";

/** A spoken message goes out at once, with no box to fix it in, so tidy what
 * the voice layer hands over: a capital first letter and end punctuation (a
 * "?" when it opens like a question). Typed card sends are never touched. */
const QUESTION = /^(how|what|what's|whats|why|when|where|who|whose|which|can|could|would|will|should|shall|is|are|am|was|were|do|does|did|have|has|had|may|might|any|how's|hows|where's|who's)\b/i;
export function tidySpoken(text: string): string {
  let t = text.trim().replace(/\s+/g, " ");
  if (!t) return t;
  // "how's it going" → "How's it going"; leave words that already mix case (iPhone, eBay).
  const first = t.match(/^[a-z][a-z']*(?![A-Za-z0-9])/)?.[0];
  if (first) t = first[0].toUpperCase() + t.slice(1);
  if (!/[.?!…)"'”’:]$/.test(t)) t += QUESTION.test(t) ? "?" : ".";
  return t;
}

/** The send intent's choice for one bot: its name, then its role (title and
 * description), so the fast selector can route a task that names no bot. The
 * host hands the chosen string back verbatim, and it is resolved by exact
 * match against this same function, never parsed. Max 200 chars (SDK limit). */
export function botChoiceLabel(bot: Agent): string {
  const role = [bot.title, bot.description].map(s => (s ?? "").replace(/\s+/g, " ").trim()).filter(Boolean).join(": ");
  const head = `${bot.name} — `;
  if (!role || head.length > 190) return bot.name;
  const label = head + role;
  return label.length <= 200 ? label : label.slice(0, 199).trimEnd() + "…";
}

/** Sending requires an exact identity: partial matching can target another bot. */
export function resolveMessageRecipient(value: string, agents: Agent[]): Agent {
  const token = value.trim();
  const byId = agents.find(a => a.id === token);
  if (byId) return byId;
  const name = normalize(token);
  const matches = name ? agents.filter(a => normalize(a.name) === name) : [];
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) throw new IntegrationError("not_found", `More than one conversation is named "${token}". Which one do you mean?`);
  const labeled = agents.filter(a => botChoiceLabel(a) === token);
  if (labeled.length === 1) return labeled[0];
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

/** A pending "connect your account" card as a line the model can act on. */
function connectLine(e: TranscriptEntry): string {
  const m = (e.message && typeof e.message === "object" ? e.message : {}) as Record<string, unknown>;
  if (typeof m.type !== "string" || !CONNECT_TYPES.has(m.type) || entryState(e) !== "pending") return "";
  const names = [m.connector, m.provider, m.platform, ...(Array.isArray(m.connectors) ? m.connectors : [])]
    .filter((v): v is string => typeof v === "string" && !!v.trim());
  const what = names.length ? names.join(", ") : "an account";
  return `[Asks the user to connect ${what}. This is done only in the Grok Bot app: "Open in Grok Bot" on this request in the card opens this chat there.]`;
}

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
      // A connect card has no text, and the model can't see the card. Say what
      // it asks and where it's done, so the answer isn't "do it in the card".
      if (!text.trim()) text = connectLine(e);
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

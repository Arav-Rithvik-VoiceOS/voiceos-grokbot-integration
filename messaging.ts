import { IntegrationError, normalize, type Agent, type TranscriptEntry } from "./client.ts";
import { CONNECT_TYPES, entryState } from "./requestState.ts";

export const PREPARE_DESCRIPTION = "Use FIRST to verify the recipient of a group send or a send with no named bot against the live roster. Pass a name exactly as spoken, or a short task/topic for routing an unnamed request. Respect the recipient returned by this tool. If it asks which bot, ask the user and stop. This tool does not send anything.";
// Two surfaces, like the official Claude Code and Manus integrations:
// - SEND_DESCRIPTION is the short plain text the USER reads in the tool list.
//   scripts/build-intents.ts copies it into voiceos.integration.json.
// - SEND_MODEL_DESCRIPTION is the routing text the MODEL reads (when to call it,
//   how to write the message). server.src.ts registers it on the MCP tool.
export const SEND_DESCRIPTION = "Ask or tell one of your bots something. Its chat opens so you can keep talking.";
export const SEND_MODEL_DESCRIPTION = "Send the user's message to one Grok Bot right away and open its live chat. Use when asked to send, tell, ask, or assign a task to a bot. Write the message to the bot, preserving the user's meaning and full task. Use an explicitly named bot as spoken. For an unnamed task, omit bot and supply any relevant project/topic in task. A clear role match takes precedence over the primary bot. If the resolver asks which bot, ask the user without sending.";
export const SEND_BOT_DESCRIPTION = "The bot's name as spoken or the exact ID from preparation. For an unnamed task omit the bot. The live roster supplies a clear role or project match, then the primary bot if available. Ask which bot when an explicit name is ambiguous.";
export const GROUP_DESCRIPTION = "Send the user's message to a Grok Bot group chat right away (an existing group, or a new one created from two or more named bots), then open that group's live chat. Use when the user asks to message several bots or a group. Spoken member or name changes are saved before it sends. Without a message, or with fewer than two bots for a new group, it only opens the group pane. Use AFTER grokbot_prepare_message succeeds for this request, copying its returned args including resolved group/member IDs, and adding the message. Never call after a missing or ambiguous recipient lookup.";
export const THREAD_DESCRIPTION = "Read what one Grok Bot teammate said, found, or did. Use for ANY question about a bot's messages or results: what it said, summarize its work, answer a question from it, or draft something from it. Returns the message text in `thread`; read it and do what the user asked in your own words. Set show only when the user asks to see or open the conversation. Accounts a bot needs (Gmail, Google Calendar, Slack, …) cannot be connected by voice or in VoiceOS: tell the user to press \"Open in Grok Bot\" on that request in the bot's card, or open the bot's chat in the Grok Bot app, and connect it there.";
// The card composer's send — the ONLY tool that sends a message. It has no
// confirmation block: the user typed the text and pressed send inside the card,
// which is the approval. The model must not pick it.
export const CARD_SEND_DESCRIPTION = "Internal — called only by the Grok Bot card's message box, never by voice. Do not call this tool; for a spoken request use grokbot_send or grokbot_group.";
export const CONTEXT_DESCRIPTION = "Internal: copy confirmationContext unchanged from the successful grokbot_prepare_message result, if present. Never compose it yourself.";

/** A spoken message goes out at once, with no box to fix it in, so tidy what
 * the voice layer hands over: a capital first letter and end punctuation (a
 * "?" when it opens like a question). Line breaks stay: a long pasted task
 * keeps its paragraphs, so only spaces within a line and blank-line runs are
 * squeezed. Typed card sends are never touched. */
const QUESTION = /^(how|what|what's|whats|why|when|where|who|whose|which|can|could|would|will|should|shall|is|are|am|was|were|do|does|did|have|has|had|may|might|any|how's|hows|where's|who's)\b/i;
export function tidySpoken(text: string): string {
  let t = text.replace(/\r\n?/g, "\n").replace(/[^\S\n]+/g, " ").replace(/ ?\n ?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
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

/** Spoken names use whole words. "Jerome" can identify "Jerome · BISV Hacks";
 * "Jer" cannot. Groups keep their full names and card actions carry stable IDs. */
export function spokenNames(bot: Agent): string[] {
  if (bot.isGroup) return [bot.name];
  const personal = bot.name.split(/\s+[·|—–-]\s+/u)[0].trim();
  const first = personal.split(/\s+/)[0];
  const aliases = /^(?:a|an|the|my|our|grok|bot|agent|team)$/i.test(first) ? [] : [first];
  return [...new Set([bot.name, personal, ...aliases])].filter(Boolean);
}

export function resolveMessageRecipient(value: string, agents: Agent[]): Agent {
  const token = value.trim();
  const byId = agents.find(a => a.id === token);
  return byId ?? resolveSpokenRecipient(token, agents);
}

/** A name from the user's speech cannot bypass ambiguity by matching an ID. */
export function resolveSpokenRecipient(token: string, agents: Agent[]): Agent {
  const name = normalize(token);
  const matches = name ? agents.filter(a => spokenNames(a).some(n => normalize(n) === name)) : [];
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    const labels = matches.map(a => botChoiceLabel(a));
    const choices = matches.map((a,i) => labels.indexOf(labels[i]) === labels.lastIndexOf(labels[i]) ? labels[i] : `${labels[i]} (ID ${a.id})`).join(" or ");
    throw new IntegrationError("not_found", `More than one conversation matches "${token}". Which one do you mean: ${choices}?`);
  }
  const labeled = agents.filter(a => botChoiceLabel(a) === token);
  if (labeled.length === 1) return labeled[0];
  throw new IntegrationError("not_found", `I couldn't find a bot or group called "${token}" in the current roster. Which bot did you mean?`);
}

export interface MessageArgs {
  requestText?: string;
  task?: string;
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

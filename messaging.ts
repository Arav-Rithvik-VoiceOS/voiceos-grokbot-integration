import { IntegrationError, normalize, type Agent } from "./client.ts";

export const PREPARE_DESCRIPTION = "Check the live Grok Bot roster before drafting any message. Use FIRST whenever the user asks to tell, ask, message, or send a task to a bot or group. Pass recipient names as the user said them. This read-only lookup does not send or request confirmation. On success call nextTool with the returned args, including confirmationContext. On failure tell the user the recipient could not be found yet and STOP; do not call a send tool, guess another bot, create a bot, or retry automatically.";
export const SEND_DESCRIPTION = "Send a message to one verified Grok Bot after the user reviews its thread confirmation. Use only AFTER grokbot_prepare_message succeeds for this request, copying its returned args including bot ID and confirmationContext. Never call for an unverified name or failed lookup. The confirmation appears before this handler runs. Leave via unset on voice calls.";
export const GROUP_DESCRIPTION = "Send to a verified Grok Bot group after the user reviews its thread confirmation. Use only AFTER grokbot_prepare_message succeeds for this request, copying its returned args including resolved group/member IDs and confirmationContext. Never call after a missing or ambiguous recipient lookup. The user can edit the draft, group name and members. Leave via unset on voice calls.";
// The card composer's send. It has NO confirmation block on purpose: the user
// already typed the text and pressed send inside the card, so a second host
// dialog would only re-ask what they just did. The model must not pick it.
export const CARD_SEND_DESCRIPTION = "Internal — called only by the Grok Bot card's message box, never by voice. Do not call this tool; for a spoken request use grokbot_prepare_message then grokbot_send, which shows the user a confirmation first.";
export const CONTEXT_DESCRIPTION = "Internal: copy confirmationContext unchanged from the successful grokbot_prepare_message result. Contains the live roster for the confirmation; never compose it yourself.";

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

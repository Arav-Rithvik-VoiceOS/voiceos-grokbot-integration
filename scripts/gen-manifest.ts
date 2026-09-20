/** Freeze the package thread into the send tools BEFORE execution. */
import { readFileSync, writeFileSync } from "node:fs";

import { renderCard, toBot, toGroup, toThread, GROK_COLOR_IDS, GROK_SHAPE_IDS } from "../cards.ts";
import { listAgents, transcriptTail } from "../client.ts";
import { PREPARE_DESCRIPTION, SEND_DESCRIPTION, CARD_SEND_DESCRIPTION, GROUP_DESCRIPTION, CONTEXT_DESCRIPTION, THREAD_DESCRIPTION } from "../messaging.ts";

const root = new URL("..", import.meta.url);
const MARK = `data:image/png;base64,${readFileSync(new URL("mark.png", root)).toString("base64")}`;
const MARK_IMG = `<img class="voiceos-mk" style="width:16px;height:16px;border-radius:5px;object-fit:contain;display:inline-block;vertical-align:middle" src="${MARK}" alt="Grok Bot">`;
const widget = (name: string, demo: unknown = { data: {}, args: {} }) =>
  readFileSync(new URL(`widgets/${name}.html`, root), "utf8")
    .split('class="mark"><i></i>')
    .join(`class="mark">${MARK_IMG}`)
    .replace("__VOICEOS_DEMO__", () => JSON.stringify(demo));

const confirmation = (name: string, height: number, confirmLabel: string) => ({
  schemaVersion: 1,
  root: { type: "widget", html: widget(name), height, confirmLabel },
});

// Confirmation iframes cannot call tools. Freeze only real roster/history data;
// voice arguments and edits arrive through the host's voiceos:init bridge.
const agents = await listAgents();
const histories = await Promise.allSettled(agents.map(async agent =>
  [agent.id, toThread((await transcriptTail(agent.id, 6)).entries ?? [])] as const));
const threads = Object.fromEntries(histories.flatMap(r => r.status === "fulfilled" ? [r.value] : []));
const snapshot = { confirmation: true, bots: agents.filter(a => !a.isGroup).map(toBot),
  groups: agents.filter(a => a.isGroup).map(toGroup), threads, me: "" };
function threadConfirmation(tool: string) {
  const data = structuredClone({ ...snapshot, tool });
  let html = renderCard("thread", { data });
  // Keep the full roster; discard oldest history first to meet the host cap.
  while (html.length > 60_000) {
    const longest = Object.values(data.threads).sort((a, b) => JSON.stringify(b).length - JSON.stringify(a).length)[0];
    if (!longest?.length) throw new Error(`${tool}: confirmation exceeds 60,000 chars`);
    longest.shift();
    html = renderCard("thread", { data });
  }
  return { schemaVersion: 1, root: { type: "widget", html, height: 360, label: "Grok Bot thread", confirmLabel: "↑" } };
}

// The `bot` slot's choices are the LIVE roster: server.ts publishes the names in
// each tool's tools/list _meta under "voiceos/intent-slot-values".
const BOT_SLOT = { type: "enum", valuesFrom: "tool", required: true };

const manifest = {
  schemaVersion: 1,
  id: "com.arav.grokbot",
  // Bump on any manifest change (tools/schema/permissions). NOTE: a plain restart
  // does NOT re-sync the cache even on a bump — push the new manifest into
  // config.json's installedIntegrations[].manifest (see the cache-push step).
  version: "1.0.22",
  name: "Grok Bot",
  summary: "Talk to your Grok Bot AI teammates by voice.",
  description:
    "See your Grok Bot teammates, message one, catch up on what a bot said, create a new bot, or start a group chat with several at once — all by voice, from the notch.",
  categories: ["Productivity"],
  icon: "icon.png",
  publisher: { id: "arav", name: "Arav Dharnikota" },
  runtime: { kind: "local-mcp", command: "/bin/zsh", args: ["run.sh"] },
  auth: { kind: "none" },
  permissions: [
    { kind: "network", domains: ["*.cursorvm.com"] },
    { kind: "background" },
    { kind: "notify" }, // triggerReminder: reply-pings + card-send confirmation
  ],
  tools: [
    {
      name: "view_bot_desktop_live",
      title: "View a bot's live screen",
      description:
        "Show a live view of a Grok Bot teammate's computer while it works. Use when the user asks to see a bot's screen, watch what a bot is doing, or what a bot is working on right now — e.g. \"show me Pepper's screen\", \"what's Jerome working on\".",
      inputSchema: {
        type: "object",
        properties: {
          bot: { type: "string", description: "The bot's name as the user said it, e.g. 'Pepper'." },
        },
        required: ["bot"],
      },
    },
    {
      name: "grokbot_open_computer_window",
      title: "Open a bot's computer window",
      // Card-only: the live screen card invokes this hardened path when the user
      // TAPS the screen. There is no voice route — opening the big window is a
      // deliberate click, never a spoken command.
      uiCallable: true,
      description:
        "Internal — invoked by the live screen card when the user taps it, to open that bot's computer in a larger window. Do not call from voice.",
      inputSchema: {
        type: "object",
        properties: {
          bot: { type: "string", description: "The bot's name or identifier as the user said it, e.g. 'Pepper'." },
        },
        required: ["bot"],
      },
    },
    {
      // The screen card's message bar polls this after a send to show the bot's
      // reply. uiCallable, read-only, no confirmation.
      name: "grokbot_reply_check",
      title: "Check a bot's latest reply",
      uiCallable: true,
      description:
        "Internal — polled by the screen card's message bar after the user sends a message, to show the bot's reply on the card. Do not call from voice.",
      inputSchema: {
        type: "object",
        properties: {
          bot: { type: "string", description: "The exact bot ID shown on the card." },
          since: { type: "number", description: "Epoch milliseconds: only replies at or after this time count." },
        },
        required: ["bot", "since"],
      },
    },
    {
      // A sent receipt calls this once on load to re-list the follow-ups sent
      // from its message bar (the host reloads the static card when the notch
      // reopens). uiCallable, read-only, no confirmation.
      name: "grokbot_sent_recent",
      title: "List the user's latest messages to a bot",
      uiCallable: true,
      description:
        "Internal — called once by a sent receipt card when it loads, to re-list the follow-up messages the user sent from that card. Do not call from voice.",
      inputSchema: {
        type: "object",
        properties: {
          bot: { type: "string", description: "The exact bot or group ID shown on the card." },
        },
        required: ["bot"],
      },
    },
    {
      name: "grokbot_show",
      title: "Show bots",
      description:
        "Show the user's Grok Bot AI teammates, or one bot's live progress. Use when the user asks to see their bots, what bots they have, or what a specific bot is doing right now.",
      inputSchema: {
        type: "object",
        properties: {
          bot: { type: "string", description: "A bot's name as the user said it, e.g. 'Pepper'. Omit to list every bot." },
        },
      },
    },
    {
      name: "grokbot_thread",
      title: "Read a bot's messages",
      description: THREAD_DESCRIPTION,
      inputSchema: {
        type: "object",
        properties: {
          bot: { type: "string", description: "The bot's name as the user said it." },
          limit: { type: "number", description: "How many recent messages; omit for a short default." },
          show: { type: "boolean", description: "True only when the user asks to see or open the conversation. Omit to just read it." },
        },
        required: ["bot"],
      },
    },
    {
      name: "grokbot_prepare_message",
      title: "Check message recipients",
      description: PREPARE_DESCRIPTION,
      inputSchema: {
        type: "object",
        properties: {
          bot: { type: "string", description: "One bot's name as the user said it, or a known ID. Omit for groups." },
          group: { type: "string", description: "An existing group's name as the user said it, or its ID." },
          members: { anyOf: [{ type: "array", items: { type: "string" } }, { type: "string" }], description: "Group members as the user said them, or their IDs." },
          groupName: { type: "string", description: "A new group name, composed as the user would type it." },
          message: { type: "string", description: "The draft, composed as the user would type it, with lead-in commands removed." },
        },
        required: [],
      },
    },
    {
      name: "grokbot_send",
      title: "Send to a bot",
      uiCallable: true,
      confirmation: threadConfirmation("grokbot_send"),
      description: SEND_DESCRIPTION,
      inputSchema: {
        type: "object",
        properties: {
          confirmationContext: { type: "string", description: CONTEXT_DESCRIPTION },
          bot: { type: "string", description: "The exact bot ID returned by grokbot_prepare_message for this request. Do not guess or substitute a recipient." },
          message: {
            type: "string",
            description:
              "The message or task, composed the way the user would type it — their meaning kept, lead-in verbs like 'tell Pepper to' dropped.",
          },
          via: {
            type: "string",
            enum: ["card"],
            description:
              "Internal — leave unset on voice calls. Card-origin metadata only; VoiceOS approval is required before execution.",
          },
        },
        required: ["bot"],
      },
    },
    {
      // The card composer's send. uiCallable so the card may invoke it; NO
      // `confirmation` block on purpose — that is what stops VoiceOS from
      // floating its "Confirm action" dialog over the card. Keep it out of
      // check-installed's confirmTools expectation (it derives from `confirmation`).
      name: "grokbot_card_send",
      title: "Send from the bot card",
      uiCallable: true,
      description: CARD_SEND_DESCRIPTION,
      inputSchema: {
        type: "object",
        properties: {
          bot: { type: "string", description: "1:1 — the exact bot (or group) ID or name shown on the card." },
          group: { type: "string", description: "Group thread — the existing group's ID. Omit with members for a new group." },
          members: { anyOf: [{ type: "array", items: { type: "string" } }, { type: "string" }], description: "Group thread — member bot IDs (edited on the card)." },
          groupName: { type: "string", description: "Group thread — the (edited) group name." },
          message: { type: "string", description: "The text the user typed in the card." },
        },
        required: ["message"],
      },
    },
    {
      name: "grokbot_create",
      title: "Create a bot",
      description:
        "Create a new Grok Bot teammate with a name and instructions. Use when the user asks to make, create, or set up a new bot.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "A short name for the new bot, as the user said it." },
          description: {
            type: "string",
            description: "The bot's job / instructions, composed the way the user would write them from what they asked for.",
          },
          label: { type: "string", description: "A one- or two-word tag for the bot (e.g. 'School', 'Research'), as the user said it." },
          notifications: { type: "boolean", description: "Whether the bot should send notifications. Omit unless the user said." },
          color: { type: "string", enum: GROK_COLOR_IDS, description: "Avatar color, one of Grok Bot's palette names. Comes from the card; omit unless the user named a color." },
          shape: { type: "string", enum: GROK_SHAPE_IDS, description: "Avatar shape, one of Grok Bot's picker shapes. Comes from the card; omit unless the user named a shape." },
        },
        required: ["name", "description"],
      },
      confirmation: confirmation("create", 400, "Create Bot"),
    },
    {
      name: "grokbot_group",
      title: "Message a group chat",
      uiCallable: true,
      confirmation: threadConfirmation("grokbot_group"),
      description: GROUP_DESCRIPTION,
      inputSchema: {
        type: "object",
        properties: {
          confirmationContext: { type: "string", description: CONTEXT_DESCRIPTION },
          group: { type: "string", description: "An existing group's name as the user said it, or its exact id from a card. Omit for a new group." },
          members: {
            anyOf: [{ type: "array", items: { type: "string" } }, { type: "string" }],
            description: "Bots to include, as names the user said or exact ids. Omit to use an existing group's members, or to choose members in the card.",
          },
          groupName: { type: "string", description: "The new or edited group name, composed as the user would type it. Omit to preserve an existing name; leave empty to name a new group in the card." },
          message: { type: "string", description: "The drafted message, composed as the user would type it, with lead-in commands removed. The arrow sends the final edited text." },
          via: { type: "string", enum: ["card"], description: "Internal — leave unset on voice calls. Card-origin metadata only; VoiceOS approval is required before execution." },
        },
        required: [],
      },
    },
  ],
  // Fast intents: short, one-action commands skip the full agent turn. Each maps
  // to an existing tool above — same handler, same card. Messaging has no intent
  // on purpose: an intent runs ONE tool, so it would skip grokbot_prepare_message
  // and the send confirmation would fall back to the frozen roster.
  intents: [
    {
      name: "show_bots",
      tool: "grokbot_show",
      description: "Show the list of all the user's Grok bots. No bot is named. Not for one bot's screen, messages, or sending a message.",
      utterances: { en: ["Show my bots", "What bots do I have", "Show my Grok bots"] },
      response: { en: "Here are your bots." },
    },
    {
      name: "bot_status",
      tool: "grokbot_show",
      description: "Show the status or progress of ONE named bot. Not its live screen or computer, not its messages, not sending it a message.",
      utterances: { en: ["Show {bot}'s progress", "How is {bot} doing", "What's {bot}'s status"] },
      slots: { bot: BOT_SLOT },
      response: { en: "Here is {bot}." },
    },
    {
      name: "view_screen",
      tool: "view_bot_desktop_live",
      description: "Show the live screen of ONE named bot in the notch: see its screen, watch it, or what it is working on. Not a bigger or separate window, not its messages.",
      utterances: { en: ["Show me {bot}'s screen", "What's {bot} working on", "Watch {bot}"] },
      slots: { bot: BOT_SLOT },
      response: { en: "Here is {bot}'s screen." },
    },
    {
      name: "open_chat",
      tool: "grokbot_thread",
      description: "Open or show the conversation with ONE named bot. Only for seeing or opening the chat. Not for questions about what the bot said, summaries, or sending a message.",
      utterances: { en: ["Open my chat with {bot}", "Show {bot}'s messages", "Open {bot}'s conversation"] },
      slots: { bot: BOT_SLOT },
      fixedArgs: { show: true },
      response: { en: "Here is your chat with {bot}." },
    },
    {
      name: "create_bot",
      tool: "grokbot_create",
      description: "Create a new Grok bot when the user gives BOTH a name and what the bot should do. Not when either is missing.",
      utterances: { en: ["Create a bot named {name} that {description}", "Make a new bot called {name} to {description}"] },
      slots: { name: { type: "string", required: true }, description: { type: "string", required: true } },
      response: { en: "Creating {name}." },
    },
  ],
  // Speech-recognition hints for Agent voice commands (static; host keeps ~10).
  asr: { vocabulary: ["Grok Bot", "Grok"] },
};

writeFileSync(new URL("voiceos.integration.json", root), JSON.stringify(manifest, null, 2) + "\n");
console.error("wrote voiceos.integration.json");

import type { IntentDefinition } from "./sdk/intents.ts";
import type { PreToolUseHookInput, HookResult } from "./sdk/hooks.ts";
import { type Agent, normalize, IntegrationError } from "./client.ts";
import { toBot } from "./cards.ts";
import { resolveMessageRecipient } from "./messaging.ts";
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { defineHooks, INTENT_SLOT_VALUES_META_KEY, INTENT_REFRESH_NOTIFICATION_METHOD } from "./intentSdk.generated.js";

export const intents: IntentDefinition[] = [
  {
    name: "list_bots", tool: "grokbot_show",
    description: "List the user's Grok Bot teammates and group chats. Only list bots, without sending a message or opening a bot's computer.",
    utterances: { en: ["Show my Grok bots", "List my bots", "Show my bots", "Show me my bots", "List my Grok bots", "What bots do I have", "Grok Bot show", "Show Grok Bots"] },
    response: { en: "Getting your bots." },
  },
  {
    name: "show_bot", tool: "grokbot_show",
    description: "Open one known Grok Bot's conversation and current progress. Do not send a message or show its computer screen.",
    utterances: { en: ["Show Grok bot {bot}", "Show me {bot}", "What is {bot} doing", "Show {bot}'s progress", "How is {bot} doing", "What's {bot}'s status"] },
    slots: { bot: { type: "enum", valuesFrom: "tool", required: true } },
    response: { en: "Opening {bot}." },
  },
  {
    name: "send_message", tool: "grokbot_send",
    description: "Prepare one message to one known Grok Bot for the user's approval. Copy the message without the command lead-in, preserving its meaning. Multiple questions inside that message are one send. Reject unknown bots, groups, multiple recipients, or separate actions outside the message.",
    utterances: { en: ["Send a message to {bot} asking {message}", "Ask {bot} to {message}", "Message {bot} saying {message}", "Send {bot} a message saying {message}", "Tell Grok bot {bot} to {message}", "Grok Bot send {bot} {message}"] },
    slots: {
      bot: { type: "enum", valuesFrom: "tool", required: true },
      message: { type: "string", required: true, examples: ["summarize today's updates", "check the latest build"] },
    },
    response: { en: "Sending your message to {bot}." },
  },
  {
  "name": "view_screen",
  "tool": "view_bot_desktop_live",
  "description": "Show the live screen of ONE named bot in the notch: see its screen, watch it, or what it is working on. Not a bigger or separate window, not its messages.",
  "utterances": {
    "en": [
      "Show me {bot}'s screen",
      "What's {bot} working on",
      "Watch {bot}"
    ]
  },
  "slots": {
    "bot": {
      "type": "enum",
      "valuesFrom": "tool",
      "required": true
    }
  },
  "response": {
    "en": "Here is {bot}'s screen."
  }
},
  {
  "name": "open_chat",
  "tool": "grokbot_thread",
  "description": "Open or show the conversation with ONE named bot. Only for seeing or opening the chat. Not for questions about what the bot said, summaries, or sending a message.",
  "utterances": {
    "en": [
      "Open my chat with {bot}",
      "Show {bot}'s messages",
      "Open {bot}'s conversation"
    ]
  },
  "slots": {
    "bot": {
      "type": "enum",
      "valuesFrom": "tool",
      "required": true
    }
  },
  "fixedArgs": {
    "show": true
  },
  "response": {
    "en": "Here is your chat with {bot}."
  }
},
  {
  "name": "create_bot",
  "tool": "grokbot_create",
  "description": "Create a new Grok bot when the user gives BOTH a name and what the bot should do. Not when either is missing.",
  "utterances": {
    "en": [
      "Create a bot named {name} that {description}",
      "Make a new bot called {name} to {description}"
    ]
  },
  "slots": {
    "name": {
      "type": "string",
      "required": true
    },
    "description": {
      "type": "string",
      "required": true
    }
  },
  "response": {
    "en": "Creating {name}."
  }
},
];

/** Names must resolve to exactly one individual bot under the send resolver. */
export function botIntentNames(agents: Agent[]): string[] {
  const individuals = agents.filter(a => !a.isGroup);
  const names = individuals.filter(a => a.name.trim() && a.name.length <= 200 && normalize(a.name)
    && individuals.filter(b => normalize(b.name) === normalize(a.name)).length === 1)
    .map(a => a.name).sort();
  // SDK dynamic enums support 30 choices. Never silently publish a partial roster.
  return names.length <= 30 ? names : [];
}

export class IntentRoster {
  private agents: Agent[] = [];
  private updatedAt = 0;
  private pending?: Promise<Agent[]>;
  private signature = "";
  onChoices: (names: string[]) => void = () => {};

  constructor(private readonly read: () => Promise<Agent[]>, private readonly now = Date.now) {}

  refresh(): Promise<Agent[]> {
    if (this.pending) return this.pending;
    this.pending = this.read().then(agents => {
      this.agents = agents;
      this.updatedAt = this.now();
      this.publish(botIntentNames(agents));
      return agents;
    }, error => {
      this.agents = [];
      this.updatedAt = 0;
      this.publish([]);
      throw error;
    }).finally(() => { this.pending = undefined; });
    return this.pending;
  }

  private publish(names: string[]) {
    const signature = JSON.stringify(names);
    if (signature === this.signature) return;
    this.signature = signature;
    this.onChoices(names);
  }

  /** Cached, read-only SDK hook: no gateway round trip delays the fast path. */
  beforeTool(input: PreToolUseHookInput): HookResult {
    if (input.toolName !== "grokbot_send") return {};
    try {
      if (!this.updatedAt || this.now() - this.updatedAt > 90_000)
        throw new Error("Grok Bot's roster is unavailable. Try again once the bots are connected.");
      if (typeof input.args.bot !== "string") throw new Error("Choose a Grok Bot to message.");
      const bot = resolveMessageRecipient(input.args.bot, this.agents.filter(a => !a.isGroup));
      let threads = {};
      if (typeof input.args.confirmationContext === "string") {
        const context = JSON.parse(input.args.confirmationContext);
        if (context.bots?.some((b: { id: string; name: string }) => b.id === bot.id && b.name === bot.name)
          && Array.isArray(context.threads?.[bot.id])) threads = { [bot.id]: context.threads[bot.id] };
      }
      return {
        updatedArgs: {
          ...input.args,
          // Preserve the enum name for host validation; pin its identity separately.
          recipientId: bot.id,
          confirmationContext: JSON.stringify({ bots: [toBot(bot)], groups: [], threads }),
        },
      };
    } catch (error) {
      return { decision: "block", responseText: error instanceof Error ? error.message : "Could not verify that bot." };
    }
  }
}

export function registerIntentSupport(server: McpServer, tools: Pick<RegisteredTool, "update">[], roster: IntentRoster, onError: (error: unknown) => void) {
  roster.onChoices = names => {
    for (const tool of tools) tool.update({ _meta: { [INTENT_SLOT_VALUES_META_KEY]: { bot: names } } });
  };
  defineHooks(server, { preToolUse: (input: PreToolUseHookInput) => roster.beforeTool(input) });
  const refresh = () => { void roster.refresh().catch(onError); };
  server.server.setNotificationHandler(z.object({ method: z.literal(INTENT_REFRESH_NOTIFICATION_METHOD) }), refresh);
  let timer: ReturnType<typeof setInterval> | undefined;
  return {
    start() { refresh(); timer ??= setInterval(refresh, 30_000); timer.unref(); },
    stop() { clearInterval(timer); timer = undefined; },
  };
}

/** Recheck the approved name/ID pair against the live roster before any send. */
export function resolveApprovedRecipient(botRef: string, recipientId: string | undefined, agents: Agent[]) {
  if (!recipientId) {
    // Existing prepared calls already carry an exact ID. A name-only fast call
    // without its preparation hook must fail rather than bypass verification.
    const byId = agents.find(a => a.id === botRef);
    if (byId) return byId;
    throw new IntegrationError("not_found", "The message recipient wasn't verified. Reload Grok Bot and try again.");
  }
  const bot = resolveMessageRecipient(botRef, agents);
  if (bot.id !== recipientId)
    throw new IntegrationError("not_found", "That bot changed after the message was prepared. Open a new message before sending.");
  return bot;
}

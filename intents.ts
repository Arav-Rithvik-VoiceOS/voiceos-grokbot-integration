import type { IntentDefinition } from "./sdk/intents.ts";
import type { PreToolUseHookInput, TranscriptHookInput, HookResult } from "./sdk/hooks.ts";
import { type Agent, normalize, IntegrationError, log, isWaking, withoutWaking } from "./client.ts";
import { confirmationContext, confirmationRows, type ConfirmRow } from "./cards.ts";
import { resolveMessageRecipient, botChoiceLabel } from "./messaging.ts";
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { defineHooks, INTENT_SLOT_VALUES_META_KEY, INTENT_REFRESH_NOTIFICATION_METHOD } from "./intentSdk.generated.js";

export const intents: IntentDefinition[] = [
  {
    name: "list_bots", tool: "grokbot_show",
    description: "List the user's Grok Bot teammates and group chats. Only list bots, without sending a message or opening a bot's computer. Never when the user gives a task or message to send, even one that names no bot ('send this task to Grok Bot').",
    utterances: { en: ["Show my Grok bots", "List my bots", "Show my bots", "Show me my bots", "List my Grok bots", "What bots do I have", "Grok Bot show", "Show Grok Bots"] },
    response: { en: "Getting your bots." },
  },
  {
    name: "show_bot", tool: "grokbot_show",
    description: "Open one known Grok Bot's conversation and current progress. Do not send a message or show its computer screen. Never when the user gives a task or message to send.",
    utterances: { en: ["Show Grok bot {bot}", "Show me {bot}", "What is {bot} doing", "Show {bot}'s progress", "How is {bot} doing", "What's {bot}'s status"] },
    slots: { bot: { type: "enum", valuesFrom: "tool", required: true } },
    response: { en: "Opening {bot}." },
  },
  {
    name: "send_message", tool: "grokbot_send",
    description: "Send a message or task to one Grok Bot right away and open its live chat. Each bot choice is its name, then its role. A name the user says wins, even if another bot's role fits better. If the user names no bot, or the name is unclear or misheard, pick the one bot whose role clearly fits the task (school work → the school bot); 'Grok Bot', 'a bot' or 'my bot' is the app, not a name. If two bots fit equally or none fits, do not pick. 'Send this task to …' and 'dispatch …' are sends. Write the message TO the bot, the way the user would type it: it is sent exactly as written. Make reported speech direct ('ask <bot> how the test is going' → 'How's the test going?'). Drop the lead-in, keep the meaning and line breaks, capital first letter, right end punctuation. A long task is one whole message. Reject groups, multiple recipients, or separate actions outside the message.",
    utterances: { en: ["Send a message to {bot} asking {message}", "Ask {bot} {message}", "Ask {bot} to {message}", "Message {bot} saying {message}", "Send {bot} a message saying {message}", "Tell Grok bot {bot} to {message}", "Grok Bot send {bot} {message}", "Have {bot} {message}", "Get {bot} to {message}", "Send this task to {bot}: {message}", "Send this to {bot}: {message}", "Dispatch a task to {bot}: {message}", "Dispatch {message} to {bot}", "Give {bot} this task: {message}", "Give {bot} a task to {message}"] },
    slots: {
      bot: { type: "enum", valuesFrom: "tool", required: true },
      message: { type: "string", required: true, examples: ["How's the screen test going?", "Summarize today's updates.", "Can you check the latest build?"] },
    },
    // Not "{bot}": the choice is the bot's whole name-and-role label.
    response: { en: "Sending your message." },
  },
  {
    name: "view_screen", tool: "view_bot_desktop_live",
    description: "Show the live screen of ONE named bot in the notch: see its screen, watch it, or what it is working on. Not a bigger or separate window, not its messages.",
    utterances: { en: ["Show me {bot}'s screen", "What's {bot} working on", "Watch {bot}"] },
    slots: { bot: { type: "enum", valuesFrom: "tool", required: true } },
    response: { en: "Here is {bot}'s screen." },
  },
  {
    name: "open_chat", tool: "grokbot_thread",
    description: "Open or show the conversation with ONE named bot. Only for seeing or opening the chat. Not for questions about what the bot said, summaries, or sending a message.",
    utterances: { en: ["Open my chat with {bot}", "Show {bot}'s messages", "Open {bot}'s conversation"] },
    slots: { bot: { type: "enum", valuesFrom: "tool", required: true } },
    fixedArgs: { show: true },
    response: { en: "Here is your chat with {bot}." },
  },
  {
    name: "create_bot", tool: "grokbot_create",
    description: "Create a new Grok bot when the user gives BOTH a name and what the bot should do. Not when either is missing.",
    utterances: { en: ["Create a bot named {name} that {description}", "Make a new bot called {name} to {description}"] },
    slots: {
      name: { type: "string", required: true },
      description: { type: "string", required: true },
    },
    response: { en: "Creating {name}." },
  },
  {
    name: "mute_bot", tool: "grokbot_notifications",
    description: "Turn OFF notifications for ONE named bot. Not for all bots, and not to turn them on.",
    utterances: { en: ["Turn off notifications for {bot}", "Turn off {bot}'s notifications", "Mute {bot}", "Stop notifications from {bot}", "Silence {bot}"] },
    slots: { bot: { type: "enum", valuesFrom: "tool", required: true } },
    fixedArgs: { enabled: false },
    response: { en: "Turning off {bot}'s notifications." },
  },
  {
    name: "unmute_bot", tool: "grokbot_notifications",
    description: "Turn ON notifications for ONE named bot. Not for all bots, and not to turn them off.",
    utterances: { en: ["Turn on notifications for {bot}", "Turn on {bot}'s notifications", "Unmute {bot}", "Notify me about {bot}"] },
    slots: { bot: { type: "enum", valuesFrom: "tool", required: true } },
    fixedArgs: { enabled: true },
    response: { en: "Turning on {bot}'s notifications." },
  },
  {
    name: "help", tool: "grokbot_help",
    description: "Show how to set up and use Grok Bot, and what the user can say to it. Only a guide; do not list, message or create bots.",
    utterances: { en: ["How do I use Grok Bot", "Help me set up Grok Bot", "How do I set up Grok Bot", "What can Grok Bot do", "Grok Bot help", "Show me how to use Grok Bot", "How does Grok Bot work"] },
    response: { en: "Here's how Grok Bot works." },
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

/** The send intent's choices: the same bots as botIntentNames, each as its
 * name-and-role label so the selector can route a task that names no bot. A
 * label that reads as another bot's name falls back to its own name, and any
 * clash left publishes plain names, so every choice resolves to one bot. */
export function botIntentLabels(agents: Agent[]): string[] {
  const individuals = agents.filter(a => !a.isGroup);
  const names = botIntentNames(agents);
  const labels = names.map(name => {
    const bot = individuals.find(a => a.name === name)!;
    const label = botChoiceLabel(bot);
    return individuals.some(b => b !== bot && normalize(b.name) === normalize(label)) ? name : label;
  });
  return new Set(labels.map(normalize)).size === labels.length ? labels : names;
}

/** Plain names for the show/thread/screen intents; labels for send. */
export interface BotChoices { names: string[]; labels: string[] }

/** How long a send's hook waits for the recipient's recent rows. The host
 * gives preToolUse 2 s in all and fails open past it, and an unhooked send
 * arrives without its pinned recipient, so it is refused: history is only worth
 * a bounded wait, never the send. */
const RECENT_WAIT_MS = 800;
const ROSTER_MAX_AGE_MS = 90_000;
/** How long a hook waits to reload a stale or failed roster. Timers stop while
 * the Mac sleeps, so on wake the cache is always old, and the first reload can
 * fail before Wi-Fi is back. Plus RECENT_WAIT_MS, this stays inside the 2 s. */
const ROSTER_WAIT_MS = 1_000;

/** A turn that may be for Grok Bot: it names the app, a bot, or dispatching. */
const GROK_TURN = /\bgrok\b|\bbots?\b|\bdispatch/i;
/** The host keeps at most 2,000 characters of one hook's context. */
const ROSTER_CONTEXT_MAX = 2_000;
const ROSTER_CONTEXT_HEAD = "Grok Bot routing (current, from the live Grok Bot app): Grok Bot is an app with several bots. 'Grok Bot', 'my bot' or 'my Grok bot' is never another name for one bot, even if saved memory or earlier turns say so: that is out of date. If the user names a bot, use that bot. If not, choose by role below: call grokbot_send with the one bot whose role fits the task best, and never fall back to a usual or default bot. If two fit equally or none fits, ask which bot. Bots (name — role):";

/** How long a spoken turn counts as the one a send belongs to. */
const TURN_MAX_AGE_MS = 120_000;
// Words that say nothing about which bot fits: the request's frame, not its topic.
const ROLE_STOP = new Set(("the and for you your can could would should please hey grok bot bots task tasks ask asking send sending message tell dispatch "
  + "saying say want wants let know there any what whats this that these those with about from into out all are was were has have had will just "
  + "get got make need needs today tomorrow now some its them they their then than also our who how why when where which see check help him her "
  + "his she one not never own under without every more most very really yes yeah okay like thing things").split(" "));
const roleWords = (text: string) => new Set(text.toLowerCase().replace(/['’]s\b/g, "").split(/[^a-z0-9]+/)
  .filter(w => w.length >= 3 && !ROLE_STOP.has(w)).map(w => (w.length > 4 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w)));

/** Whether a turn says one of these bots' names as a whole word or words
 * ("Jasper", "F.I.N.C.H." spoken as "Finch", "Finch's"). */
export function namesABot(text: string, bots: Agent[]): boolean {
  const spoken = ` ${text.replace(/['’]s\b/gi, "").split(/\s+/).map(normalize).filter(Boolean).join(" ")} `;
  return bots.some(b => {
    const name = b.name.split(/\s+/).map(normalize).filter(Boolean).join(" ");
    return !!name && spoken.includes(` ${name} `);
  });
}

/** Same word, or one starts the other ("sponsor" / "sponsorships", "hack" / "hackathon"). */
const sameRoot = (a: string, b: string) => a === b || (Math.min(a.length, b.length) >= 4 && (a.startsWith(b) || b.startsWith(a)));

/** The one bot whose role (title, then description) best matches a turn that
 * names no bot. A word counts double in the title, and a word several roles
 * share counts less (split between them). No clear winner → undefined. */
export function botForTask(text: string, bots: Agent[]): Agent | undefined {
  const roles = bots.map(b => ({ b, title: [...roleWords(b.title ?? "")], all: [...roleWords(`${b.title ?? ""} ${b.description ?? ""}`)], score: 0 }));
  for (const w of roleWords(text)) {
    const hits = roles.filter(r => r.all.some(x => sameRoot(w, x)));
    for (const r of hits) r.score += (r.title.some(x => sameRoot(w, x)) ? 2 : 1) / hits.length;
  }
  const [top, next] = roles.sort((x, y) => y.score - x.score);
  return top && top.score > 0 && top.score > (next?.score ?? 0) ? top.b : undefined;
}

/** A model-copied confirmationContext, or undefined when missing or mangled. */
function copiedContext(value: unknown): Record<string, any> | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const context = JSON.parse(value);
    return context && typeof context === "object" && !Array.isArray(context) ? context : undefined;
  } catch { return undefined; }
}

export class IntentRoster {
  private agents: Agent[] = [];
  private updatedAt = 0;
  private pending?: Promise<Agent[]>;
  private pendingWakes = false;
  /** The last spoken turn, from the transcript hook. In memory only, never logged. */
  private lastTurn?: { text: string; at: number };
  private signature = "";
  onChoices: (choices: BotChoices) => void = () => {};
  /** The recipient's recent confirmation rows; the server wires the gateway in. */
  recentRows: (botId: string) => Promise<ConfirmRow[]> = async () => [];

  constructor(private readonly read: () => Promise<Agent[]>, private readonly now = Date.now) {}

  /** A background read (see withoutWaking) never wakes a parked box, so a
   * read that may wake it does not wait on one. Only the latest read lands. */
  refresh(): Promise<Agent[]> {
    const wakes = isWaking();
    if (this.pending && (this.pendingWakes || !wakes)) return this.pending;
    const pending: Promise<Agent[]> = this.read().then(agents => {
      if (this.pending !== pending) return agents;
      this.agents = agents;
      this.updatedAt = this.now();
      this.publish({ names: botIntentNames(agents), labels: botIntentLabels(agents) });
      return agents;
    }, error => {
      // A parked box still has the same bots: keep their names, stay stale.
      if (this.pending === pending && !(error instanceof IntegrationError && error.kind === "parked")) {
        this.agents = [];
        this.updatedAt = 0;
        this.publish({ names: [], labels: [] });
      }
      throw error;
    }).finally(() => { if (this.pending === pending) this.pending = undefined; });
    this.pending = pending;
    this.pendingWakes = wakes;
    return pending;
  }

  private publish(choices: BotChoices) {
    const signature = JSON.stringify(choices);
    if (signature === this.signature) return;
    this.signature = signature;
    this.onChoices(choices);
  }

  /** The cached roster, reloaded first when it is stale or its last load
   * failed. A reload that is slow (a parked box takes ~3 s to wake) or finds
   * the box parked falls back to the last roster: the send re-checks the
   * recipient against the live one before it runs. With no roster at all, the
   * reload error is thrown as it is, so the block says why. */
  private async fresh() {
    if (this.updatedAt && this.now() - this.updatedAt <= ROSTER_MAX_AGE_MS) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.refresh(),
        new Promise((_, fail) => {
          timer = setTimeout(() => fail(new Error("Grok Bot is slow to answer. Try again in a moment.")), ROSTER_WAIT_MS);
        }),
      ]);
    } catch (error) {
      if (!this.agents.length) throw error;
    } finally { clearTimeout(timer); }
  }

  /** Each bot's role for a turn about Grok Bot, so the model routes a task
   * that names no bot ("send this to Grok Bot …", "ask my bot …") by role
   * instead of guessing a familiar name. Cache only: the transcript hook has
   * 500 ms, too little for a gateway read. */
  transcriptContext(transcript: string): string | undefined {
    const bots = this.agents.filter(a => !a.isGroup);
    if (!bots.length || !GROK_TURN.test(transcript)) return undefined;
    let text = ROSTER_CONTEXT_HEAD;
    for (const b of bots) {
      const line = `\n- ${botChoiceLabel(b)}`;
      if (text.length + line.length > ROSTER_CONTEXT_MAX) break;
      text += line;
    }
    return text;
  }

  noteTurn(text: string) { this.lastTurn = { text, at: this.now() }; }

  /** The model's pick for a send whose turn named no bot is a guess: saved
   * memory can say "Grok Bot" means one bot, and the model follows it over
   * the roles in the turn. When the turn names no bot and one bot's role
   * clearly fits its words better, that bot gets the message instead. */
  private routeUnnamed(picked: Agent, bots: Agent[]): Agent | undefined {
    const turn = this.lastTurn;
    if (!turn || this.now() - turn.at > TURN_MAX_AGE_MS || namesABot(turn.text, bots)) return undefined;
    const best = botForTask(turn.text, bots);
    return best && best.id !== picked.id ? best : undefined;
  }

  private async recent(botId: string): Promise<ConfirmRow[] | undefined> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.recentRows(botId),
        new Promise<undefined>(done => { timer = setTimeout(done, RECENT_WAIT_MS); }),
      ]);
    } catch { return undefined; } finally { clearTimeout(timer); }
  }

  /** Identity comes from the cached roster, never a round trip; only a send
   * that arrives without prepared rows waits, briefly, to read them. The
   * confirmation's roster and rows are rebuilt here, never passed through. */
  async beforeTool(input: PreToolUseHookInput): Promise<HookResult> {
    // Creating a bot always shows its card. The manifest `confirmation` only
    // sets the default of the user's ask switch, and no manifest field locks
    // it; a hook's requireConfirmation adds a confirmation the switch cannot remove.
    if (input.toolName === "grokbot_create") return { requireConfirmation: true };
    if (input.toolName === "grokbot_group") return this.beforeGroup(input);
    if (input.toolName !== "grokbot_send") return {};
    try {
      await this.fresh();
      if (typeof input.args.bot !== "string") throw new Error("Choose a Grok Bot to message.");
      const individuals = this.agents.filter(a => !a.isGroup);
      let bot = resolveMessageRecipient(input.args.bot, individuals);
      const routed = this.routeUnnamed(bot, individuals);
      if (routed) { log(`send hook: no bot named; ${bot.name} → ${routed.name} by role`); bot = routed; }
      // Cosmetic only: a copy that is mangled, or prepared for another bot, just
      // loses its rows, and a send without prepared rows reads them itself.
      const context = copiedContext(input.args.confirmationContext);
      const copied = Array.isArray(context?.bots) && context.bots.some((b: any) => b?.id === bot.id && b?.name === bot.name)
        && Array.isArray(context.threads?.[bot.id]) ? confirmationRows(context.threads[bot.id], true) : undefined;
      const rows = copied ?? await this.recent(bot.id);
      return {
        updatedArgs: {
          ...input.args,
          // Preserve the enum name for host validation; pin its identity separately.
          // A send routed by role names its new bot, so the result and card agree.
          ...(routed ? { bot: bot.name } : {}),
          recipientId: bot.id,
          confirmationContext: confirmationContext(individuals, rows?.length ? { [bot.id]: rows } : {}, [bot.id], true),
        },
      };
    } catch (error) {
      return { decision: "block", responseText: error instanceof Error ? error.message : "Could not verify that bot." };
    }
  }

  /** A group send's recipients are verified when it runs; here its prepared
   * context is only made safe to draw: roster from the live cache, rows rebuilt. */
  private async beforeGroup(input: PreToolUseHookInput): Promise<HookResult> {
    if (input.args.confirmationContext === undefined) return {};
    try { await this.fresh(); }
    catch (error) { return { decision: "block", responseText: (error as Error).message }; }
    const copied = copiedContext(input.args.confirmationContext)?.threads;
    const threads: Record<string, ConfirmRow[]> = {};
    for (const g of this.agents.filter(a => a.isGroup))
      if (Array.isArray(copied?.[g.id])) threads[g.id] = confirmationRows(copied[g.id], true);
    const members = (Array.isArray(input.args.members) ? input.args.members : String(input.args.members ?? "").split(","))
      .filter((m): m is string => typeof m === "string").map(m => m.trim());
    return { updatedArgs: { ...input.args, confirmationContext: confirmationContext(this.agents, threads, members) } };
  }
}

type IntentTool = Pick<RegisteredTool, "update">;
/** `named` tools get plain bot names; `labeled` tools get name-and-role labels. */
export function registerIntentSupport(server: McpServer, tools: { named: IntentTool[]; labeled: IntentTool[] }, roster: IntentRoster, onError: (error: unknown) => void) {
  roster.onChoices = ({ names, labels }) => {
    for (const tool of tools.named) tool.update({ _meta: { [INTENT_SLOT_VALUES_META_KEY]: { bot: names } } });
    for (const tool of tools.labeled) tool.update({ _meta: { [INTENT_SLOT_VALUES_META_KEY]: { bot: labels } } });
  };
  // Background: keeps names current, never wakes a parked box.
  const refresh = () => { void withoutWaking(() => roster.refresh()).catch(onError); };
  defineHooks(server, {
    transcript: (input: TranscriptHookInput) => {
      const transcript = String(input?.transcript ?? "");
      roster.noteTurn(transcript);
      const context = roster.transcriptContext(transcript);
      // stderr only, and never the spoken text: proves the host called the hook.
      if (context) log(`transcript hook: added roster roles (${context.length} chars)`);
      return context ? { additionalContext: context } : {};
    },
    preToolUse: async (input: PreToolUseHookInput) => {
      const result = await roster.beforeTool(input);
      // stderr only: names and shapes, never message text.
      if (result.decision === "block")
        log(`preToolUse blocked ${input.toolName}: ${result.responseText}`, { input: Object.keys(input ?? {}), args: Object.keys(input?.args ?? {}), bot: typeof input?.args?.bot });
      return result;
    },
  });
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
  // The same individual roster the hook resolved against: a group sharing the
  // bot's name must not turn an approved send into "more than one".
  const bot = resolveMessageRecipient(botRef, agents.filter(a => !a.isGroup));
  if (bot.id !== recipientId)
    throw new IntegrationError("not_found", "That bot changed after the message was prepared. Open a new message before sending.");
  return bot;
}

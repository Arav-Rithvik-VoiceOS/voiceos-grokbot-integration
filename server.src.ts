/**
 * Product layer: the tools VoiceOS's agent can see.
 *
 * Tool names here must match voiceos.integration.json exactly — the manifest is
 * what the agent routes on, this is what actually runs. All gateway access goes
 * through client.ts; every card comes from cards.ts (Arav's hand-designed
 * widgets in ./widgets, injected with live data).
 */
// FIRST import, on purpose: rebinds console.log/info/warn/debug to stderr
// before any dependency runs, so no stray stdout line corrupts the MCP wire.
import "./stdoutGuard.ts";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  IntegrationError,
  SERVICE_NAME,
  TOOLKIT,
  type Agent,
  createAgent,
  createGroup,
  setGroupMembers,
  renameGroup,
  type AutomationRun,
  entryText,
  isBotReply,
  listAgents as readAgents,
  listAllAutomations,
  log,
  openComputerWindow,
  openGrokBotApp,
  openBotChat,
  resolveAgent,
  resolveMembers,
  sendPrompt,
  transcriptTail,
  type TranscriptEntry,
  agentScreen,
} from "./client.ts";
import { recordCardPoll, cardCovers } from "./cardWatch.ts";
import { connectCard, screenCard, showCard, threadCard, groupThreadCard, sentCard, sentGroupCard, toBot, toGroup, toThread, confirmationRows, confirmationContext, type ConfirmRow, GROK_COLOR_IDS, GROK_SHAPE_IDS, normalizeColorId, normalizeShapeId } from "./cards.ts";

import { PREPARE_DESCRIPTION, SEND_DESCRIPTION, CARD_SEND_DESCRIPTION, GROUP_DESCRIPTION, CONTEXT_DESCRIPTION, resolveMessageRecipient, resolveMessageGroup, threadForModel, THREAD_DESCRIPTION, type MessageArgs } from "./messaging.ts";
import { conversationSnapshot, conversationImage, conversationEntry, performConversationAction } from "./conversationService.ts";
import { ComposerFiles, sweepStaleAttachments, teachTask, type ComposerArgs, type TeachAction } from "./composerService.ts";
import { needsAttention, toCardThread, type CardItem } from "./conversation.ts";
import { IntentRoster, resolveApprovedRecipient, registerIntentSupport } from "./intents.ts";
import { INTENT_SLOT_VALUES_META_KEY } from "./intentSdk.generated.js";

const server = new McpServer({ name: TOOLKIT, version: "1.0.0" });
const intentRoster = new IntentRoster(readAgents);
const listAgents = () => intentRoster.refresh();
/** A recipient's last few messages as a confirmation draws them. Bounded: the
 * model copies prepare's context into the send verbatim, and rendered markdown
 * (tables, highlighted code) is far larger than its text. */
const recentRows = async (id: string): Promise<ConfirmRow[]> =>
  confirmationRows(toThread((await transcriptTail(id, 6)).entries ?? [], 12_000));
intentRoster.recentRows = recentRows;

/** A tool result: JSON for the model, plus (optionally) a live glance card. */
function result(payload: Record<string, unknown>, glance?: Record<string, unknown>) {
  const body = glance ? { ...payload, ...glance } : payload;
  return { content: [{ type: "text" as const, text: JSON.stringify(body) }] };
}

// ── Reply-ping: notch reminder ("pill") + background watch ───────────────────
//
// triggerReminder pushes a pill under the notch with NO active tool call. It's a
// server→host reverse MCP request (method decoded from the shipped app); needs
// { "kind": "notify" } in voiceos.integration.json. Best-effort by design: a
// reminder failure must never make the send look failed.
const ReminderResult = z.object({ notificationId: z.string().min(1) });

/** A reminder button: `id` must match a key in REMINDER_ACTIONS below. */
type ReminderButton = { id: string; label: string };

async function triggerReminder(
  message: string,
  opts: { speak?: boolean; actions?: ReminderButton[]; data?: Record<string, unknown> } = {},
): Promise<string | null> {
  const text = message.trim().slice(0, 2000);
  if (!text) return null;
  const params: { message: string; speak?: boolean; actions?: ReminderButton[]; data?: Record<string, unknown> } = {
    message: text,
  };
  if (opts.speak === false) params.speak = false;
  if (opts.actions?.length) params.actions = opts.actions;
  if (opts.data) params.data = opts.data;
  try {
    const res = await server.server.request({ method: "voiceos/reminders/trigger", params }, ReminderResult);
    return res.notificationId;
  } catch (error) {
    log("triggerReminder failed:", error);
    return null;
  }
}

// ── Reminder buttons ──────────────────────────────────────────────────────────
//
// A reminder can carry up to 3 buttons. On a click the host sends us the
// reverse request `voiceos/reminders/action` { notificationId, actionId, data }
// (decoded from the shipped 0.2.41 app). We answer { ok: true } once the effect
// is done — the host then dismisses the card; a throw keeps the card up with an
// error. A button cannot return a card: the only reply the host accepts is
// { ok: true }. Handlers are a fixed map; incoming ids are never evaluated.
const REMINDER_ACTION_METHOD = "voiceos/reminders/action";
const ReminderActionRequest = z.object({
  method: z.literal(REMINDER_ACTION_METHOD),
  params: z.object({
    notificationId: z.string().min(1).max(128),
    actionId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    data: z.record(z.unknown()).optional(),
  }),
});

/** The two buttons on a "<bot> replied." pill. */
const REPLY_BUTTONS: ReminderButton[] = [
  { id: "open_chat", label: "Open" },
  { id: "close", label: "Close" },
];

const REMINDER_ACTIONS: Record<string, (data: Record<string, unknown> | undefined) => Promise<void>> = {
  // Open this bot's chat in the Grok Bot app.
  async open_chat(data) {
    const botId = typeof data?.botId === "string" ? data.botId : "";
    await openBotChat(botId);
  },
  // Nothing to do: answering ok is what makes the host dismiss the card.
  async close() {},
};

server.server.setRequestHandler(ReminderActionRequest, async ({ params }) => {
  const run = REMINDER_ACTIONS[params.actionId];
  if (!run) throw new Error("This button is no longer available.");
  await run(params.data);
  return { ok: true as const };
});

// Cadence + limits for the thread watch. Jonah confirmed a background poll may
// run for days; a normal reply/turn is far shorter, so MAX_WATCH_MS is only a
// safety valve against a "working" flag that never clears. A task that ENDS its
// turn and returns much later (a scheduled / "I'll come back" task) is out of
// scope here by design — that is the separate scheduled-tasks feature.
const POLL_MS = 5_000; // Jonah-approved cadence
const MAX_WATCH_MS = 6 * 60 * 60_000; // safety cap only; going idle is the real stop
const IDLE_STARTUP_MS = 3 * 60_000; // give up if the bot never engages at all
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Is the bot mid-turn — working, thinking, or composing? */
const isBusy = (a?: Agent): boolean =>
  Boolean(a?.isRunningTurn || a?.isRunning || a?.isComposingMessage);

/** A human turn in the thread (either our VoiceOS send or one typed in-app). */
const isUserTurn = (e: TranscriptEntry): boolean => e.kind === "message" && e.role === "user";

/** Collapse a reply to a short line that fits a small pill. */
const summarize = (text: string, max = 140): string => {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? one.slice(0, max - 1).trimEnd() + "…" : one;
};

/**
 * Fire-and-forget: after a send, watch THIS bot's thread and ping the notch ONCE
 * ("<bot> replied.") on its first reply, then stop; also stop when the bot goes
 * idle (its turn ends). We only ever watch a bot the user just messaged
 * through VoiceOS, and we stop the instant it's done, so an idle bot is never
 * polled. `seen` is the transcript baseline captured BEFORE the send, and
 * `ourText` is exactly what we sent — the one human turn we own. Any OTHER human
 * turn means the user is now typing straight into the Grok Bot app, so we hand
 * the thread back and stop: we only ping chats started through VoiceOS.
 */
function watchThreadThenNotify(bot: Agent, seen: Iterable<string | undefined>, ourText: string): void {
  void (async () => {
    const known = new Set(seen);
    const t0 = Date.now();
    let sawActivity = false; // saw it working, or saw at least one reply
    let absorbedOwn = false; // have we accounted for our own VoiceOS send yet?
    try {
      while (Date.now() - t0 < MAX_WATCH_MS) {
        await sleep(POLL_MS);

        // Status first, so a reply can be phrased as "needs an answer".
        let me: Agent | undefined;
        try {
          me = (await listAgents()).find((a) => a.id === bot.id);
        } catch {
          /* one status miss is harmless — keep going */
        }
        const busy = isBusy(me);
        if (busy) sawActivity = true;

        // New messages since we last looked.
        let entries: Awaited<ReturnType<typeof transcriptTail>>["entries"];
        try {
          entries = (await transcriptTail(bot.id, 12)).entries;
        } catch {
          continue; // a poll miss — try again next tick
        }
        const fresh = (entries ?? []).filter((e) => !known.has(e.id));
        for (const e of fresh) known.add(e.id);

        // User takeover: our own send is the one human turn whose text matches
        // what we sent — absorb it and keep going. ANY other human turn is the
        // user typing into the Grok Bot app directly, so stop and ping nothing
        // more (don't ping the reply that answers their in-app message).
        let takeover = false;
        for (const u of fresh) {
          if (!isUserTurn(u)) continue;
          if (!absorbedOwn && entryText(u).trim() === ourText.trim()) {
            absorbedOwn = true;
            continue;
          }
          takeover = true;
          break;
        }
        if (takeover) return;

        const replies = fresh.filter(isBotReply);

        // ONE silent pill per send: "<bot> replied." with Open / Close. It never
        // quotes the reply, and once it's up we stop watching, so a bot that
        // posts three messages still gives one pill. The next VoiceOS send
        // starts a new watch, which can ping again.
        if (replies.length) {
          sawActivity = true;
          // The screen card is on screen and shows this reply itself (its message
          // bar polls grokbot_reply_check), so a pill would only repeat it.
          if (cardCovers(bot.id, replies[replies.length - 1].id)) {
            if (!busy) return;
            continue;
          }
          await triggerReminder(`${bot.name} replied.`, {
            speak: false,
            actions: REPLY_BUTTONS,
            data: { botId: bot.id },
          });
          return;
        }

        // Turn is over: it engaged, it's idle, and nothing fresh is left.
        if (sawActivity && !busy && replies.length === 0) return;

        // Never engaged at all → the send didn't wake it; give up quietly.
        if (!sawActivity && Date.now() - t0 > IDLE_STARTUP_MS) return;
      }
    } catch (error) {
      log("thread watch failed:", error);
    }
  })();
}

// ── Automation watch: ping when a scheduled task ("automation") finishes ──────
//
// Grok scheduled tasks are "automations". Each carries nextRunAt (epoch ms) and
// a runs[] history where a run gets finishedAt when it completes. We sleep until
// the soonest task is about to fire, poll ONLY around that window until a new run
// finishes, then ping ONE pill with its final result — "<bot> · <task>: …".
// Between fires we make no calls. All enabled tasks are watched, and a run that
// finished while we slept is still caught on the next pull, so we needn't be
// awake at the exact tick. Only fires while this process is alive (Jonah OK'd a
// long-lived background poll).
const AUTO_LEAD_MS = 60_000; // wake this early before a due time (also the arming window)
const AUTO_POLL_MS = 20_000; // cadence while a run is due or in flight
const AUTO_GRACE_MS = 15 * 60_000; // keep short-polling this long past a due time — Grok fires LATE (seen ~5 min)
const AUTO_MAX_IDLE_MS = 30 * 60_000; // re-pull the list at least this often

/**
 * The bot's final message for a finished run. Matches the run's own requestId
 * first (exact), else the run's time window. A run is marked finished a beat
 * BEFORE its output message is queryable in the transcript, so we retry a few
 * times to bridge that lag before giving up (caller falls back to "… ran.").
 */
async function automationResultText(agentId: string, run: AutomationRun): Promise<string> {
  const from = (run.startedAt ?? 0) - 5_000;
  const to = (run.finishedAt ?? Date.now()) + 60_000;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const entries = (await transcriptTail(agentId, 20)).entries ?? [];
      const replies = entries.filter(isBotReply);
      // Exact: a reply carrying this run's requestId.
      const exact = run.requestId ? replies.filter((e) => e.requestId === run.requestId) : [];
      if (exact.length) return entryText(exact[exact.length - 1]);
      // Else: newest reply inside the run's time window.
      const win = replies.filter((e) => typeof e.timestampMs === "number" && e.timestampMs >= from && e.timestampMs <= to);
      if (win.length) return entryText(win[win.length - 1]);
    } catch {
      /* transient — retry */
    }
    await sleep(2_500); // the message can land a second or two after finishedAt
  }
  return "";
}

/**
 * Long-lived background loop: ping when any ENABLED scheduled task finishes a
 * run. Started once at boot; self-heals on error and never throws. The first
 * successful pull baselines existing runs so old history never pings.
 */
function startAutomationWatch(): void {
  void (async () => {
    const pinged = new Set<string>(); // finished run ids already handled
    let baselined = false;
    let armedUntil = 0; // stay in short-poll until this time (survives a late fire)
    for (;;) {
      try {
        const enabled = (await listAllAutomations()).filter((e) => e.automation?.isEnabled);

        // agentId → name for the pill label (best-effort).
        const nameById = new Map<string, string>();
        try {
          for (const a of await listAgents()) nameById.set(a.id, a.name);
        } catch {
          /* names are a nicety */
        }

        for (const e of enabled) {
          for (const run of e.automation.runs ?? []) {
            if (!run.finishedAt || pinged.has(run.id)) continue;
            pinged.add(run.id);
            if (!baselined) continue; // finished before we started → don't ping history
            const bot = nameById.get(e.agentId) ?? "A bot";
            const text = await automationResultText(e.agentId, run);
            const body = text
              ? `${bot} · ${e.automation.name}: ${summarize(text)}`
              : `${bot} · ${e.automation.name} ran.`;
            await triggerReminder(body, { speak: false });
          }
        }
        baselined = true;

        // Decide the next sleep. Grok fires automations LATE (observed ~5 min
        // after the cron time), so a fire being imminent ARMS a grace window:
        // we keep short-polling until AUTO_GRACE_MS past the due time, even after
        // nextRunAt rolls forward to the next occurrence. Otherwise we sleep until
        // the soonest upcoming fire (capped, to refresh the list).
        const now = Date.now();
        const inFlight = enabled.some((e) => (e.automation.runs ?? []).some((r) => r.startedAt && !r.finishedAt));
        for (const e of enabled) {
          const nr = e.automation.nextRunAt;
          // A due time that's imminent OR recently passed arms the grace window.
          if (typeof nr === "number" && nr - now <= AUTO_LEAD_MS && now - nr <= AUTO_GRACE_MS) {
            armedUntil = Math.max(armedUntil, nr + AUTO_GRACE_MS);
          }
        }
        const upcoming = enabled
          .map((e) => e.automation.nextRunAt)
          .filter((t): t is number => typeof t === "number" && t - now > AUTO_LEAD_MS);
        const soonest = upcoming.length ? Math.min(...upcoming) : Infinity;

        const sleepMs =
          inFlight || now < armedUntil
            ? AUTO_POLL_MS
            : Math.max(AUTO_POLL_MS, Math.min(soonest - AUTO_LEAD_MS - now, AUTO_MAX_IDLE_MS));
        await sleep(sleepMs);
      } catch (error) {
        log("automation watch cycle failed:", error);
        await sleep(AUTO_MAX_IDLE_MS); // app not signed in / gateway down → back off
      }
    }
  })();
}

// ── Failure policy, in one place ─────────────────────────────────────────────
// Serialize handlers so batched tool calls can't interleave shared state.
let _toolChain: Promise<unknown> = Promise.resolve();

async function handle(
  tool: string,
  run: () => Promise<ReturnType<typeof result>>,
): Promise<ReturnType<typeof result>> {
  const turn = _toolChain.then(() => runTool(tool, run));
  _toolChain = turn.then(() => undefined, () => undefined);
  return turn;
}

async function runTool(
  tool: string,
  run: () => Promise<ReturnType<typeof result>>,
): Promise<ReturnType<typeof result>> {
  try {
    return await run();
  } catch (error) {
    log(`${tool} failed:`, error);
    // "Not set up / needs a refresh" isn't a crash — it's the first-run state.
    // Speak the fix, open the app, and show the Connect card. No OAuth page.
    if (error instanceof IntegrationError && (error.kind === "setup" || error.kind === "not_connected")) {
      openGrokBotApp();
      return result({ ok: false, needsSetup: true, message: error.message }, connectCard());
    }
    throw new Error(
      error instanceof IntegrationError ? error.message : `The ${SERVICE_NAME} request failed unexpectedly.`,
    );
  }
}

function statusWord(a: Agent): string {
  if (a.awaitingUserResponse) return "waiting for you";
  if (a.isComposingMessage) return "typing";
  if (a.isRunning ?? a.isRunningTurn) return "working";
  return "idle";
}

/** The live conversation card for one transcript page: a group opens in the
 * thread card's existing-group mode, a bot in its 1:1 mode. */
function conversationCard(bot: Agent, agents: Agent[], tail: { entries?: TranscriptEntry[]; nextBeforeSeq?: number }) {
  const entries = tail.entries ?? [];
  return bot.isGroup
    ? groupThreadCard(agents, { id: bot.id, name: bot.name, members: bot.memberIds ?? [] }, entries, "", tail.nextBeforeSeq)
    : threadCard(bot, entries, "", agents, tail.nextBeforeSeq);
}

// ── READ: grokbot_show ───────────────────────────────────────────────────────
const showTool = server.registerTool(
  "grokbot_show",
  {
    title: "Show bots",
    description:
      "Show the user's Grok Bot AI teammates, or one bot's live progress. Use when the user asks to see their bots, what bots they have, or what a specific bot is doing right now.",
    inputSchema: {
      bot: z
        .string()
        .optional()
        .describe("A bot's name as the user said it, e.g. 'Pepper'. Omit to list every bot."),
    },
    annotations: { readOnlyHint: true },
    _meta: { [INTENT_SLOT_VALUES_META_KEY]: { bot: [] } },
  },
  async (args: { bot?: string }) =>
    handle("grokbot_show", async () => {
      const agents = await listAgents();
      const focus = args.bot?.trim();
      // One short transcript page per bot and group. On the roster it fills the
      // show card's chat panes, so a tapped bot opens populated (showCard drops
      // these if they would push the card over the glance cap). On older
      // gateways that omit the authoritative awaitingUserResponse flag, the same
      // page infers it from a pending request or question.
      const recent: Record<string, CardItem[]> = {};
      const cursors: Record<string, number | undefined> = {};
      await Promise.all(
        agents.filter((b) => !focus || b.awaitingUserResponse === undefined).map(async (b) => {
          try {
            const tail = await transcriptTail(b.id, 6);
            const thread = toCardThread(tail.entries ?? []);
            if (b.awaitingUserResponse === undefined && needsAttention(thread)) b.awaitingUserResponse = true;
            recent[b.id] = thread;
            cursors[b.id] = tail.nextBeforeSeq;
          } catch {
            // One unreachable transcript must not hide the entire roster.
          }
        }),
      );
      if (focus) {
        // Open the requested conversation directly, in the thread card.
        const bot = await resolveAgent(focus, agents);
        // Best-effort, like the roster's panes: a just-created bot or a slow
        // gateway still opens the conversation (its live refresh fills it in).
        let tail: Awaited<ReturnType<typeof transcriptTail>> = {};
        let historyUnavailable = false;
        try { tail = await transcriptTail(bot.id, 30); }
        catch (error) { historyUnavailable = true; log("grokbot_show transcript read failed:", error); }
        return result(
          { focus: bot.name, status: statusWord(bot), task: (bot.lastMessagePreview ?? "").trim() || null,
            ...(historyUnavailable ? { historyUnavailable: true } : {}), message: `${bot.name} is ${statusWord(bot)}.` },
          conversationCard(bot, agents, tail),
        );
      }
      const card = showCard(agents, undefined, recent, cursors);
      const bots = agents.filter((a) => !a.isGroup);
      const groups = agents.filter((a) => a.isGroup);
      return result(
        {
          count: bots.length,
          bots: bots.map((b) => ({ name: b.name, status: statusWord(b) })),
          groups: groups.map(g => ({ name: g.name, members: g.memberIds ?? [] })),
          message: bots.length === 0 && groups.length === 0 ? "You don't have any Grok bots or group chats yet." : `You have ${bots.length} bot${bots.length === 1 ? "" : "s"} and ${groups.length} group chat${groups.length === 1 ? "" : "s"}.`,
        },
        card,
      );
    }),
);

// Card-origin operations share the existing host grant and serialized transport.
// Read results contain data only, so refreshing never replaces an edited card.
async function cardRequest(tool: string, run: () => Promise<Record<string, unknown>>) {
  return handle(tool, async () => {
    try { return result(await run()); }
    catch (error) { return result({ ok: false, message: error instanceof Error ? error.message : "The request failed." }); }
  });
}

const composerFiles = new ComposerFiles(undefined, async (botId, message) => {
  const bot = (await listAgents()).find(b => b.id === botId);
  if (!bot || bot.isGroup) return;
  const baseline = (await transcriptTail(botId, 12)).entries ?? [];
  return () => watchThreadThenNotify(bot, baseline.map(e => e.id), message);
});
// Staged copies are private user files: remove them on every exit (host gone,
// SIGINT/SIGTERM), and sweep what a killed or crashed server left behind.
process.once("exit", () => composerFiles.cleanupSync());
void sweepStaleAttachments().catch(error => log("attachment sweep failed:", error));
server.registerTool("grokbot_card_files", {
  title: "Attach files from the bot card",
  description: "Internal — only for explicit attachment picker, removal, send, and status actions in the Grok Bot card. Never call from a voice or model request.",
  inputSchema: { bot: z.string(), action: z.enum(["pick", "status", "remove", "send"]), jobId: z.string().optional(), attachmentId: z.string().optional(), attachments: z.array(z.string()).max(20).optional(), message: z.string().max(12000).optional(), clientNonce: z.string().max(128).optional() },
}, (args: ComposerArgs) => cardRequest("grokbot_card_files", () => composerFiles.handle(args)));
server.registerTool("grokbot_card_teach", {
  title: "Teach a task from the bot card",
  description: "Internal — only for the user's Teach a task controls in the Grok Bot card. Prepare the computer without recording; start, save, or discard only on the user's corresponding click. Never call from voice or model requests.",
  inputSchema: { bot: z.string(), action: z.enum(["prepare", "status", "start", "save", "discard"]) },
}, (args: { bot: string; action: TeachAction }) => cardRequest("grokbot_card_teach", () => teachTask(args.bot, args.action)));

server.registerTool("grokbot_card_snapshot", {
  title: "Refresh conversation",
  description: "Internal read-only tool for the visible Grok Bot conversation card. Use grokbot_thread for spoken requests.",
  inputSchema: { bot: z.string().optional(), beforeSeq: z.number().int().optional() },
  annotations: { readOnlyHint: true },
}, (args: { bot?: string; beforeSeq?: number }) => cardRequest("grokbot_card_snapshot", async () => {
  const snapshot = await conversationSnapshot(args.bot, args.beforeSeq);
  return { ok: true, bots: snapshot.agents.filter(a => !a.isGroup).map(toBot), groups: snapshot.agents.filter(a => a.isGroup).map(toGroup), thread: snapshot.thread, nextBeforeSeq: snapshot.nextBeforeSeq };
}));

server.registerTool("grokbot_card_entry", {
  title: "Load complete conversation message",
  description: "Internal read-only loader for complete Grok Bot messages. The card automatically reads bounded chunks; no user action or native-app handoff is needed.",
  inputSchema: { bot: z.string(), entryId: z.string(), offset: z.number().int().min(0).optional(), version: z.string().optional() },
  annotations: { readOnlyHint: true },
}, (args: { bot: string; entryId: string; offset?: number; version?: string }) => cardRequest("grokbot_card_entry", () => conversationEntry(args.bot, args.entryId, args.offset, args.version)));

server.registerTool("grokbot_card_image", {
  title: "Load conversation image",
  description: "Internal read-only image loader for Grok Bot cards. Resolves only an image belonging to the specified transcript entry.",
  inputSchema: { bot: z.string(), entryId: z.string(), index: z.number().int().min(0) },
  annotations: { readOnlyHint: true },
}, (args: { bot: string; entryId: string; index: number }) => cardRequest("grokbot_card_image", () => conversationImage(args.bot, args.entryId, args.index)));

server.registerTool("grokbot_card_action", {
  title: "Respond to a conversation card",
  description: "Internal — only invoke from a user's click on a Grok Bot card. Never select or dismiss an answer on the user's behalf. Handles the exact selected options or opens Grok Bot's native authentication and approval flow.",
  inputSchema: { bot: z.string(), entryId: z.string().optional(), action: z.enum(["answer", "dismiss", "open"]), values: z.array(z.string()).optional(), custom: z.string().max(12000).optional() },
}, (args: { bot: string; entryId?: string; action: "answer" | "dismiss" | "open"; values?: string[]; custom?: string }) => cardRequest("grokbot_card_action", () => performConversationAction(args)));

// ── READ: grokbot_thread ─────────────────────────────────────────────────────
const threadTool = server.registerTool(
  "grokbot_thread",
  {
    title: "Read a bot's messages",
    description: THREAD_DESCRIPTION,
    inputSchema: {
      bot: z.string().describe("The bot's name as the user said it."),
      limit: z.number().int().min(1).max(20).optional().describe("How many recent messages; omit for a short default."),
      show: z.boolean().optional().describe("True only when the user asks to see or open the conversation. Omit to just read it."),
    },
    annotations: { readOnlyHint: true },
  },
  async (args: { bot: string; limit?: number; show?: boolean }) =>
    handle("grokbot_thread", async () => {
      const agents = await listAgents();
      const bot = await resolveAgent(args.bot.trim(), agents);
      const tail = await transcriptTail(bot.id, args.limit ?? 20);
      const entries = tail.entries ?? [];
      const { thread, truncated } = threadForModel(bot, entries);
      // No card unless asked: a glance on a read step parks the confirmation of
      // a send that follows it ("summarize what Pepper said and tell Friday").
      return result(
        {
          bot: bot.name,
          messages: thread.length,
          thread,
          truncated,
          message: thread.length ? `Latest from ${bot.name}.` : `No recent messages from ${bot.name}.`,
        },
        args.show ? conversationCard(bot, agents, tail) : undefined,
      );
    }),
);

// Resolve live identities before selecting a tool that opens confirmation.
server.registerTool("grokbot_prepare_message", {
  title: "Check message recipients",
  description: PREPARE_DESCRIPTION,
  inputSchema: {
    bot: z.string().optional().describe("One bot's name as the user said it, or a known ID. Omit for groups."),
    group: z.string().optional().describe("An existing group's name as the user said it, or its ID."),
    members: z.union([z.array(z.string()), z.string()]).optional().describe("Group members as the user said them, or their IDs."),
    groupName: z.string().optional().describe("A new group name, composed as the user would type it."),
    message: z.string().optional().describe("The draft, composed as the user would type it, with lead-in commands removed."),
  },
  annotations: { readOnlyHint: true },
}, async (args: MessageArgs) => handle("grokbot_prepare_message", async () => {
  const agents = await listAgents();
  if (args.bot !== undefined && (args.group !== undefined || args.members !== undefined)) {
    throw new IntegrationError("not_found", "Choose one bot or a group of bots.");
  }
  let target: Agent | undefined;
  let resolved: MessageArgs;
  if (args.bot !== undefined) {
    target = resolveMessageRecipient(args.bot, agents.filter(a => !a.isGroup));
    resolved = { bot: target.id, ...(args.message !== undefined ? { message: args.message } : {}) };
  } else {
    const { existing, memberIds } = resolveMessageGroup(args, agents);
    target = existing;
    if (!existing && !memberIds.length && args.members === undefined && args.groupName === undefined) {
      throw new IntegrationError("not_found", "Which bot or group do you want to message?");
    }
    resolved = { ...args, ...(existing ? { group: existing.id } : {}), members: memberIds };
  }
  const threads: Record<string, ConfirmRow[]> = {};
  if (target) {
    try { threads[target.id] = await recentRows(target.id); }
    catch { /* Registration can precede the first transcript. */ }
  }
  const send = args.bot !== undefined;
  const keep = [...(target ? [target.id, ...(target.memberIds ?? [])] : []), ...(Array.isArray(resolved.members) ? resolved.members : [])];
  const context = confirmationContext(send ? agents.filter(a => !a.isGroup) : agents, threads, keep, send);
  // NO glance here, on purpose. A tool result that carries _voiceos_glance makes
  // the notch present it as the turn's result (the host snapshots it as the
  // answer), and the grokbot_send confirmation that follows a moment later is
  // parked instead of shown: the user sees a bare "Pepper" header and no send
  // card. Plain JSON keeps the notch in its thinking state until the
  // confirmation opens.
  return result({ ready: true, nextTool: args.bot !== undefined ? "grokbot_send" : "grokbot_group",
    args: { ...resolved, confirmationContext: context }, message: "Recipients verified. Use the returned args to open the message confirmation." });
}));

// The "Sent to group" receipt (sent-group.html): a RECEIPT like the 1:1 send,
// not the group thread view — a send should end on "sent", the same for voice
// and card. `receipt` carries the block so a card can swap itself to it.
function groupReceipt(agents: Agent[], group: { id: string; name: string; members: string[] }, message: string) {
  const card = sentGroupCard(agents, group, message);
  return result(
    { sent: true, group: group.id, groupName: group.name, members: group.members, sentMessage: message,
      message: `Sent your message to ${group.name}.`, receipt: card._voiceos_glance.blocks[0] },
    card,
  );
}

// ── WRITE: the one send path, shared by the voice tool and the card tool ──
// Resolves the recipient by exact identity, sends once, starts the reply
// watch, and returns the "sent" glance card. Both tools below call this so a
// change here (e.g. the reply ping) can never drift between voice and card.
async function performSend(botRef: string, rawMessage: string | undefined, { allowGroup = false, verifyApproval = false, recipientId = undefined as string | undefined } = {}) {
  const message = rawMessage?.trim() ?? "";
  const agents = await listAgents();
  const bot = verifyApproval ? resolveApprovedRecipient(botRef, recipientId, agents) : resolveMessageRecipient(botRef, agents);
  if (bot.isGroup && !allowGroup) throw new IntegrationError("not_found", "Use the group message tool for this conversation.");
  if (!message) throw new IntegrationError("not_found", "What should I send?");

  // A group picked on the card: send as-is (no member/name edits here — the
  // voice tool grokbot_group owns those) and hand back the GROUP receipt, so
  // the card can swap to the same "Sent to group" view voice sends get.
  if (bot.isGroup) {
    await sendPrompt(bot.id, message);
    return groupReceipt(agents, { id: bot.id, name: bot.name, members: bot.memberIds ?? [] }, message);
  }

  // Baseline the transcript BEFORE sending, so we can spot the reply.
  const base = await transcriptTail(bot.id, 12);
  const seen = new Set((base.entries ?? []).map((e) => e.id));

  await sendPrompt(bot.id, message);

  // NO send-confirmation pill here. The sent glance card below already shows
  // "<bot>'s on it" (it carries the bot's live working state), so a reminder
  // would double it AS A NOTIFICATION — which is not what a send is. Pills are
  // reserved for the bot's actual REPLY landing later (watchThreadThenNotify).

  // Acknowledge immediately (the card must appear right when the user
  // speaks), then watch in the background and ping under the notch when the
  // reply lands. No foreground wait — replies run ~40s, past what VoiceOS
  // lets a tool block for.
  watchThreadThenNotify(bot, seen, message);

  // Reflect the bot's real, current status on the card (working / thinking /
  // …) rather than its pre-send snapshot — best-effort, and never blocks or
  // fails the send if the refresh doesn't come back.
  let current = bot;
  try {
    const fresh = (await listAgents()).find((x) => x.id === bot.id);
    if (fresh) current = fresh;
  } catch {
    /* keep the pre-send snapshot */
  }
  const card = sentCard(current, message);
  return result(
    { sent: true, bot: bot.name, sentMessage: message, message: `Sent your message to ${bot.name}.`, receipt: card._voiceos_glance.blocks[0] },
    card,
  );
}

// ── WRITE: VoiceOS shows the manifest thread BEFORE calling this handler ──
const sendTool = server.registerTool(
  "grokbot_send",
  {
    title: "Send to a bot",
    description: SEND_DESCRIPTION,
    inputSchema: {
      confirmationContext: z.string().optional().describe(CONTEXT_DESCRIPTION),
      bot: z.string().describe("One Grok Bot's name as spoken, or its exact ID from grokbot_prepare_message. The SDK hook verifies the recipient before confirmation."),
      recipientId: z.string().optional().describe("Internal: recipient ID pinned by the preparation hook. Never compose or change this value."),
      message: z
        .string()
        .optional()
        .describe("The message or task, composed the way the user would type it — their meaning kept, lead-in verbs like 'tell Pepper to' dropped."),
      // Must be declared here too (not just the manifest): the MCP layer parses
      // args against THIS schema and strips anything not listed, so without it
      // the card's via:"card" never reaches the handler.
      via: z
        .enum(["card"])
        .optional()
        .describe("Internal — leave unset on voice calls. Card-origin metadata only; VoiceOS approval is required before execution."),
    },
    _meta: { [INTENT_SLOT_VALUES_META_KEY]: { bot: [] } },
  },
  async (args: { bot: string; message?: string; via?: string; recipientId?: string }) =>
    handle("grokbot_send", () => performSend(args.bot, args.message, { verifyApproval: true, recipientId: args.recipientId })),
);

// ── WRITE: grokbot_card_send — the card composer's send, NO host confirmation ──
// Same handler as grokbot_send, but the manifest entry has no `confirmation`
// block, so VoiceOS never floats its "Confirm action" JSON dialog over the
// card. The user's own keystrokes + send click in the card ARE the approval.
// Guarded like grokbot_send: exact recipient identity, empty text refused.
server.registerTool(
  "grokbot_card_send",
  {
    title: "Send from the bot card",
    description: CARD_SEND_DESCRIPTION,
    inputSchema: {
      bot: z.string().optional().describe("1:1 — the exact bot (or group) ID or name shown on the card."),
      group: z.string().optional().describe("Group thread — the existing group's ID. Omit with `members` for a new group."),
      members: z.union([z.array(z.string()), z.string()]).optional().describe("Group thread — member bot IDs (edited on the card)."),
      groupName: z.string().optional().describe("Group thread — the (edited) group name."),
      message: z.string().describe("The text the user typed in the card."),
    },
  },
  async (args: { bot?: string; group?: string; members?: string | string[]; groupName?: string; message: string }) =>
    handle("grokbot_card_send", () =>
      args.bot !== undefined
        ? performSend(args.bot, args.message, { allowGroup: true })
        : performGroupSend(args)),
);

// ── WRITE: grokbot_create (confirmation: create.html) ────────────────────────
server.registerTool(
  "grokbot_create",
  {
    title: "Create a bot",
    description:
      "Create a new Grok Bot teammate with a name and instructions. Use when the user asks to make, create, or set up a new bot.",
    inputSchema: {
      name: z.string().describe("A short name for the new bot, as the user said it."),
      description: z
        .string()
        .describe("The bot's job / instructions, composed the way the user would write them from what they asked for."),
      label: z.string().optional().describe("A one- or two-word tag for the bot (e.g. 'School', 'Research'), as the user said it."),
      notifications: z.boolean().optional().describe("Whether the bot should send notifications. Omit unless the user said."),
      // Avatar look — picked on the card's live preview and forwarded to Grok
      // Bot as avatarColor/avatarShape (its own palette + picker ids).
      // Lenient on purpose: VoiceOS caches the create card, so a stale card may
      // still send a hex or circ|sq|hex. normalizeColorId/normalizeShapeId map
      // anything reasonable onto Grok's real ids; the manifest advertises the enums.
      color: z.string().optional().describe(`Avatar color, one of ${GROK_COLOR_IDS.join("|")}. Comes from the card; omit unless the user named a color.`),
      shape: z.string().optional().describe(`Avatar shape, one of ${GROK_SHAPE_IDS.join("|")}. Comes from the card; omit unless the user named a shape.`),
    },
  },
  async (args: { name: string; description: string; label?: string; notifications?: boolean; color?: string; shape?: string }) =>
    handle("grokbot_create", async () => {
      const name = args.name?.trim();
      if (!name) throw new IntegrationError("not_found", "What should the bot be called?");
      const created = await createAgent(name, args.description?.trim() ?? "", {
        title: args.label?.trim() || undefined,
        notificationsEnabled: args.notifications,
        avatarColor: normalizeColorId(args.color),
        avatarShape: normalizeShapeId(args.shape),
      });
      // Show the refreshed roster with the new bot in it.
      const agents = await listAgents();

      const readyToMessage = !!created?.id && agents.some(a => a.id === created.id);
      return result({ created: true, name, botId: created?.id, readyToMessage,
        message: readyToMessage ? `Created ${name}. Check the live recipient before messaging it.`
          : `Created ${name}, but it isn't available for messaging in the current roster yet. Try again once it appears in Grok Bot.` }, showCard(agents));
    }),
);

// ── WRITE: the one GROUP send path, shared by grokbot_group and the card tool ──
// Saves member/name edits (or creates the group on first send), sends once,
// and ends on the "Sent to group" receipt.
async function performGroupSend(args: { group?: string; members?: string | string[]; groupName?: string; message?: string }) {
  const agents = await listAgents();
  const { existing, memberIds, bots, sameSet } = resolveMessageGroup(args, agents);
  const message = args.message?.trim() ?? "";
  const name = args.groupName?.trim() ?? existing?.name ?? "";
  if (!message) throw new IntegrationError("not_found", "What should I send?");
  if (memberIds.length < (existing ? 1 : 2)) throw new IntegrationError("not_found", existing ? "Keep at least one bot in the group." : "Choose at least two bots for a new group.");
  let target = existing;
  const savedName = name || memberIds.map(id => bots.find(a => a.id === id)!.name).join(" + ");
  if (target) {
    if (!sameSet(target.memberIds ?? [], memberIds)) await setGroupMembers(target.id, memberIds);
    if (target.name !== savedName) await renameGroup(target, savedName);
  } else {
    target = await createGroup(savedName, memberIds);
    if (!target?.id) throw new IntegrationError("upstream", "The group was not created.");
  }
  await sendPrompt(target.id, message);
  // End on the "Sent to group" RECEIPT, exactly like a 1:1 send ends on
  // "Message sent" — not the thread view, which reads as "catch up on a
  // bot" and leaves the user thinking the conversation lives in the notch.
  return groupReceipt(agents, { id: target.id, name: savedName, members: memberIds }, message);
}

// ── GROUP: one live thread for existing and new groups ────────────────────
server.registerTool(
  "grokbot_group",
  {
    title: "Message a group chat",
    description: GROUP_DESCRIPTION,
    inputSchema: {
      confirmationContext: z.string().optional().describe(CONTEXT_DESCRIPTION),
      group: z.string().optional().describe("An existing group's name as the user said it, or its exact id from a card. Omit for a new group."),
      members: z.union([z.array(z.string()), z.string()]).optional()
        .describe("Bots to include, as names the user said or exact ids. Omit to use an existing group's members, or to choose members in the card."),
      groupName: z.string().optional().describe("The new or edited group name, composed as the user would type it. Omit to preserve an existing name; leave empty to name a new group in the card."),
      message: z.string().optional().describe("The drafted message, composed as the user would type it, with lead-in commands removed. The arrow sends the final edited text."),
      via: z.enum(["card"]).optional().describe("Internal — leave unset on voice calls. Card-origin metadata only; VoiceOS approval is required before execution."),
    },
  },
  async (args: { group?: string; members?: string | string[]; groupName?: string; message?: string; via?: string }) =>
    handle("grokbot_group", () => performGroupSend(args)),
);

// ── READ: view_bot_desktop_live (live screen of the bot's computer) ──────────
const screenTool = server.registerTool(
  "view_bot_desktop_live",
  {
    title: "View a bot's live screen",
    description:
      "Show a live view of a Grok Bot teammate's computer while it works. Use when the user asks to see a bot's screen, watch what a bot is doing, or what a bot is working on right now — e.g. \"show me Pepper's screen\", \"what's Jerome working on\".",
    inputSchema: {
      bot: z.string().describe("The bot's name as the user said it, e.g. 'Pepper'."),
    },
    annotations: { readOnlyHint: true },
  },
  async (args: { bot: string }) =>
    handle("view_bot_desktop_live", async () => {
      const bot = await resolveAgent(args.bot.trim());
      // Every bot has its OWN cloud desktop (its "forever box"), which persists
      // between tasks — so the screen is worth showing whenever that desktop
      // answers, not only while a turn is running. agentScreen() maps the box
      // to its public socket and proves a VNC desktop is behind it; when the
      // box is absent or silent the card shows its idle state instead of a
      // broken viewer.
      const probe = await agentScreen(bot.id);
      const live = probe.live;
      const working = Boolean(bot.isRunning || bot.isRunningTurn || bot.isComposingMessage);
      return result(
        {
          bot: bot.name,
          status: statusWord(bot),
          live,
          message: live
            ? working
              ? `Live view of ${bot.name}'s screen.`
              : `${bot.name}'s desktop is up but ${bot.name} is idle right now.`
            : `${bot.name}'s computer is not running right now.`,
        },
        screenCard(bot, live ? { wsUrl: probe.wsUrl!, viewerUrl: probe.viewerUrl! } : undefined),
      );
    }),
);

// ── CARD: grokbot_open_computer_window (larger native interactive screen) ──────
// Card-only: opened when the user TAPS the live screen card; no voice intent.
server.registerTool(
  "grokbot_open_computer_window",
  {
    title: "Open a bot's computer window",
    description:
      "Internal — invoked by the live screen card when the user taps it, to open that bot's computer in a larger window. Do not call from voice.",
    inputSchema: {
      bot: z.string().describe("The bot's name or identifier as the user said it, e.g. 'Pepper'."),
    },
    annotations: { readOnlyHint: true },
  },
  async (args: { bot: string }) =>
    handle("grokbot_open_computer_window", async () => {
      // Voice supplies a spoken name; the screen card supplies its exact id.
      // resolveMembers preserves strict name matching while accepting that id.
      const [bot] = await resolveMembers([args.bot.trim()]);
      const probe = await agentScreen(bot.id);
      if (!probe.live || !probe.wsUrl) {
        return result({
          opened: false,
          bot: bot.name,
          live: false,
          message: `${bot.name}'s computer is not running right now.`,
        });
      }

      const avatar = toBot(bot);
      await openComputerWindow({
        botId: bot.id,
        botName: bot.name,
        botColor: avatar.color,
        botShape: avatar.shape,
        wsUrl: probe.wsUrl,
      });
      return result({
        opened: true,
        bot: bot.name,
        live: true,
        viewOnly: false,
        message: `Opened ${bot.name}'s computer in an interactive window.`,
      });
    }),
);

// ── CARD: grokbot_reply_check — the screen card's message bar polls this ──────
// After a send the card asks, every few seconds, whether the bot has answered
// yet (card requests are capped at 64 per card, so the card polls only for a
// bounded window). Read-only, plain JSON (no glance): the card renders it.
// `since` is epoch ms — only replies at or after it count, so an older message
// is never mistaken for the answer.
server.registerTool(
  "grokbot_reply_check",
  {
    title: "Check a bot's latest reply",
    description:
      "Internal — polled by the screen card's message bar after the user sends a message, to show the bot's reply on the card. Do not call from voice.",
    inputSchema: {
      bot: z.string().describe("The exact bot ID shown on the card."),
      since: z.number().describe("Epoch milliseconds: only replies at or after this time count."),
    },
    annotations: { readOnlyHint: true },
  },
  async (args: { bot: string; since: number }) =>
    handle("grokbot_reply_check", async () => {
      const [bot] = await resolveMembers([args.bot.trim()]);
      const me = (await listAgents()).find((a) => a.id === bot.id);
      const { entries } = await transcriptTail(bot.id, 12);
      const replies = (entries ?? []).filter((e) => isBotReply(e) && (e.timestampMs ?? 0) >= args.since && entryText(e).trim());
      const last = replies[replies.length - 1];
      recordCardPoll(bot.id, { replyId: last?.id, busy: isBusy(me) });
      return result({
        bot: bot.name,
        busy: isBusy(me),
        awaiting: Boolean(me?.awaitingUserResponse),
        reply: last ? { id: last.id, text: summarize(entryText(last), 600) } : null,
      });
    }),
);

// ── CARD: grokbot_sent_recent — the sent receipts restore their follow-ups ────
// A receipt is static HTML: when the notch closes and reopens, the host reloads
// it and every follow-up the user sent from its message bar is gone from the
// card. On load the receipt asks for the user's latest messages in this
// conversation and re-lists the ones after its own. Read-only, plain JSON (no
// glance). It does NOT record a card poll: receipts show no replies, so the
// reply pill must keep firing.
server.registerTool(
  "grokbot_sent_recent",
  {
    title: "List the user's latest messages to a bot",
    description:
      "Internal — called once by a sent receipt card when it loads, to re-list the follow-up messages the user sent from that card. Do not call from voice.",
    inputSchema: {
      bot: z.string().describe("The exact bot or group ID shown on the card."),
    },
    annotations: { readOnlyHint: true },
  },
  async (args: { bot: string }) =>
    handle("grokbot_sent_recent", async () => {
      const target = resolveMessageRecipient(args.bot, await listAgents());
      const { entries } = await transcriptTail(target.id, 30);
      const messages = (entries ?? [])
        .filter((e) => e.role === "user")
        .map((e) => entryText(e).trim())
        .filter(Boolean)
        .slice(-12);
      return result({ bot: target.name, messages });
    }),
);

const intentSupport = registerIntentSupport(server, [showTool, sendTool, threadTool, screenTool], intentRoster, error => log("Intent roster refresh failed:", error));
await server.connect(new StdioServerTransport());

// Exit when the host goes away. The background loops below (automation watch,
// thread watches, intent roster refresh) keep the event loop alive forever, so
// without this every VoiceOS quit left an orphaned server (PPID 1) polling the
// gateway. The SDK's StdioServerTransport never listens for stdin EOF — its
// onclose fires only on an explicit close() — so watch stdin directly, plus
// onclose for that case. One onclose handler: a second assignment would replace it.
let exiting = false;
function exitOnHostGone(reason: string): void {
  if (exiting) return;
  exiting = true;
  intentSupport.stop();
  log(`${reason}; exiting`);
  process.exit(0);
}
process.stdin.once("end", () => exitOnHostGone("stdin ended"));
process.stdin.once("close", () => exitOnHostGone("stdin closed"));
server.server.onclose = () => exitOnHostGone("MCP transport closed");

intentSupport.start();
log("server started, awaiting MCP requests on stdio");

// Background: ping when a scheduled task (automation) finishes. Fire-and-forget;
// it self-heals and never blocks the server.
startAutomationWatch();

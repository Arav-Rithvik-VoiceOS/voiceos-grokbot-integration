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
  withoutWaking,
  SERVICE_NAME,
  TOOLKIT,
  type Agent,
  createAgent,
  hasGatewaySession,
  hasGrokBotApp,
  createGroup,
  setGroupMembers,
  setAgentNotifyOnUpdates,
  renameGroup,
  type AutomationRun,
  entryText,
  isBotReply,
  listAgents as readAgents,
  listAllAutomations,
  log,
  openComputerWindow,
  openGrokBotApp,
  resolveAgent,
  resolveMembers,
  sendPrompt,
  transcriptTail,
  type TranscriptEntry,
  agentScreen,
} from "./client.ts";
import { recordCardPoll, cardCovers } from "./cardWatch.ts";
import { RFB_B64 } from "./assets.generated.ts";
import { connectCard, guideCard, showCard, type ShowOpen, toBot, toGroup, toThread, confirmationRows, confirmationContext, type ConfirmRow, GROK_COLOR_IDS, GROK_SHAPE_IDS, normalizeColorId, normalizeShapeId } from "./cards.ts";

import { PREPARE_DESCRIPTION, SEND_DESCRIPTION, CARD_SEND_DESCRIPTION, GROUP_DESCRIPTION, CONTEXT_DESCRIPTION, resolveMessageRecipient, tidySpoken, resolveMessageGroup, threadForModel, THREAD_DESCRIPTION, type MessageArgs } from "./messaging.ts";
import { conversationSnapshot, conversationImage, conversationEntry, performConversationAction } from "./conversationService.ts";
import { needsAttention, toCardThread, type CardItem } from "./conversation.ts";
import { IntentRoster, registerIntentSupport } from "./intents.ts";
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

/**
 * The "Show notifications from bots" setup toggle (manifest preference
 * SHOW_BOT_NOTIFICATIONS, default on). VoiceOS injects preferences as env vars;
 * a boolean arrives as a string, and an unset var (older install) means off.
 */
const notificationsEnabled = (): boolean =>
  /^(true|1|yes|on)$/i.test((process.env.SHOW_BOT_NOTIFICATIONS ?? "").trim());

/**
 * A bot's own "Notify on updates" switch in the Grok Bot app. Both switches must
 * be on to ping: the VoiceOS toggle above and this per-bot one. Unset (an older
 * app, or a roster miss) means on, the app's own default.
 */
const botNotifies = (bot: Agent | undefined): boolean => bot?.notifyOnUpdatesEnabled !== false;

/** A reminder button: `id` must match a key in REMINDER_ACTIONS below. */
type ReminderButton = { id: string; label: string };

async function triggerReminder(
  message: string,
  opts: { speak?: boolean; actions?: ReminderButton[]; data?: Record<string, unknown> } = {},
): Promise<string | null> {
  if (!notificationsEnabled()) return null;
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
// error. Since VoiceOS 0.2.42 the answer may also carry `view` (glance blocks)
// and `responseText`: the host opens that card in the notch, with no agent turn.
// Handlers are a fixed map; incoming ids are never evaluated.
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

/** What a button may hand back: a card for the notch (and optional fallback
 * text, which we leave out: the host would draw it above the card). */
type ReminderReply = { view: { blocks: unknown[] }; responseText?: string } | void;

/** The notch card for one bot's conversation (the roster card on its chat
 * pane), with a "New messages" line above replies newer than `newSince`. */
async function reminderView(botId: string, newSince?: number) {
  const agents = await listAgents();
  const bot = agents.find((a) => a.id === botId);
  if (!bot) throw new Error("This bot no longer exists in Grok Bot.");
  // Best-effort, like grokbot_show: the pane's live refresh fills in a missed read.
  let tail: Awaited<ReturnType<typeof transcriptTail>> = {};
  try { tail = await transcriptTail(bot.id, 30); }
  catch (error) { log("reminder view transcript read failed:", error); }
  const since = typeof newSince === "number" && Number.isFinite(newSince) ? { newSince } : {};
  return (await conversationCard(agents, { ...openOf(bot), ...since }, tail))._voiceos_glance;
}

// Built when the pill fires, so Open answers at once: the host shows "Running…"
// on the button for as long as the handler takes. One per bot (the newest
// pill); the card's live refresh brings it up to date as it opens.
const READY_VIEWS = new Map<string, { newSince: number; view: Awaited<ReturnType<typeof reminderView>> }>();
async function prepareReminderView(botId: string, newSince: number): Promise<void> {
  try { READY_VIEWS.set(botId, { newSince, view: await reminderView(botId, newSince) }); }
  catch (error) { log("reminder view prebuild failed:", error); } // Open builds it then
}

const REMINDER_ACTIONS: Record<string, (data: Record<string, unknown> | undefined) => Promise<ReminderReply>> = {
  // Open this bot's conversation in the notch (`newSince`: the watch's boundary, epoch ms).
  async open_chat(data) {
    const botId = typeof data?.botId === "string" ? data.botId : "";
    if (!botId) throw new Error("This notification does not name a bot.");
    const newSince = typeof data?.newSince === "number" ? data.newSince : undefined;
    const ready = READY_VIEWS.get(botId);
    if (ready && ready.newSince === newSince) return { view: ready.view };
    return { view: await reminderView(botId, newSince) };
  },
  // Nothing to do: answering ok is what makes the host dismiss the card.
  async close() {},
};

server.server.setRequestHandler(ReminderActionRequest, async ({ params }) => {
  const run = REMINDER_ACTIONS[params.actionId];
  if (!run) throw new Error("This button is no longer available.");
  const reply = await run(params.data);
  return { ok: true as const, ...(reply ?? {}) };
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
  if (!notificationsEnabled() || !botNotifies(bot)) return; // nothing to ping, so don't poll
  // Background: never wakes a box the Grok Bot app parked.
  void withoutWaking(async () => {
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
        // The user muted this bot in the Grok Bot app (or by voice) mid-watch.
        if (me && !botNotifies(me)) return;

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
          // Open draws "New messages" above the first reply newer than this.
          const times = replies.map((e) => e.timestampMs).filter((t): t is number => typeof t === "number");
          const newSince = times.length ? Math.min(...times) - 1 : t0;
          await prepareReminderView(bot.id, newSince);
          await triggerReminder(`${bot.name} replied.`, {
            speak: false,
            actions: REPLY_BUTTONS,
            data: { botId: bot.id, newSince },
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
  });
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
  if (!notificationsEnabled()) return; // env is fixed at process start; nothing to ping
  // Background: never wakes a box the Grok Bot app parked.
  void withoutWaking(async () => {
    const pinged = new Set<string>(); // finished run ids already handled
    let baselined = false;
    let armedUntil = 0; // stay in short-poll until this time (survives a late fire)
    for (;;) {
      try {
        const enabled = (await listAllAutomations()).filter((e) => e.automation?.isEnabled);

        // agentId → name for the pill label, and the bots muted in the Grok Bot
        // app (best-effort: a roster miss pings, the app's default).
        const nameById = new Map<string, string>();
        const muted = new Set<string>();
        try {
          for (const a of await listAgents()) {
            nameById.set(a.id, a.name);
            if (!botNotifies(a)) muted.add(a.id);
          }
        } catch {
          /* names are a nicety */
        }

        for (const e of enabled) {
          for (const run of e.automation.runs ?? []) {
            if (!run.finishedAt || pinged.has(run.id)) continue;
            pinged.add(run.id);
            if (!baselined) continue; // finished before we started → don't ping history
            if (muted.has(e.agentId)) continue;
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
  });
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

/** One short transcript page per bot and group, for the roster card's chat
 * panes (showCard drops them if they would push the card over the glance cap).
 * On older gateways that omit the authoritative awaitingUserResponse flag, the
 * same page infers it from a pending request or question.
 * The pages are a preload, so they get ROSTER_PRELOAD_MS: a bot whose read is
 * slower is left out, and its pane fills from the live chat when opened. Before
 * the budget, one hanging read held the card back for its whole timeout plus
 * the curl retry (16 s), and a voice send's card took up to half a minute. */
const ROSTER_PRELOAD_MS = 1_500;
async function rosterThreads(agents: Agent[], skip?: string) {
  const recent: Record<string, CardItem[]> = {};
  const cursors: Record<string, number | undefined> = {};
  let late = false;
  const reads = Promise.all(agents.filter((b) => b.id !== skip).map(async (b) => {
    try {
      const tail = await transcriptTail(b.id, 6);
      // Past the budget the card is already built; do not touch it.
      if (late) return;
      const thread = toCardThread(tail.entries ?? []);
      if (b.awaitingUserResponse === undefined && needsAttention(thread)) b.awaitingUserResponse = true;
      recent[b.id] = thread;
      cursors[b.id] = tail.nextBeforeSeq;
    } catch {
      // One unreachable transcript must not hide the entire roster.
    }
  }));
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([reads, new Promise<void>((r) => { timer = setTimeout(r, ROSTER_PRELOAD_MS); })]);
  clearTimeout(timer);
  late = true;
  return { recent, cursors };
}

/** The roster card opened on one conversation — the same card "Show my bots"
 * shows, so voice and taps land on one surface with one back button. `tail` is
 * the opened conversation's longer page; `message` is its draft in the box, or
 * with `sent` the message voice already sent, which flies into the orb on open.
 * A new group (`members`) has no conversation yet: the card opens its
 * new-group pane, and the first send creates it. */
async function conversationCard(agents: Agent[], open: ShowOpen, tail: { entries?: TranscriptEntry[]; nextBeforeSeq?: number } = {}, message = "", sent = false) {
  const focus = "bot" in open ? open.bot : "group" in open ? open.group : undefined;
  const { recent, cursors } = await rosterThreads(agents, focus);
  if (focus) { recent[focus] = toCardThread(tail.entries ?? []); cursors[focus] = tail.nextBeforeSeq; }
  return showCard(agents, undefined, recent, cursors, { open, message, sent });
}
const openOf = (bot: Agent): ShowOpen => (bot.isGroup ? { group: bot.id } : { bot: bot.id });

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
      if (focus) {
        // Open the requested conversation directly, on the roster card's chat pane.
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
          await conversationCard(agents, openOf(bot), tail),
        );
      }
      const { recent, cursors } = await rosterThreads(agents);
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

// ── READ: grokbot_help ───────────────────────────────────────────────────────
// The setup guide must open even before Grok Bot is set up, so it never throws
// the Connect card: each step is checked on this Mac (files and the preference
// only), and the roster read that counts bots is best-effort and time-boxed.
const HELP_STEPS = [
  { key: "app", text: "Install the Grok Bot app on this Mac and open it." },
  { key: "signedIn", text: "Sign in to Grok Bot. VoiceOS uses that session, so there are no keys to paste." },
  { key: "bots", text: "Make a first bot, for example: \"Create a bot named Scout that checks my inbox.\"" },
  { key: "notifications", text: "Optional: turn on \"Show notifications from bots\" in Grok Bot's settings in VoiceOS to get a ping when a bot replies.", optional: true },
] as const;
const HELP_PHRASES = [
  "Show my bots",
  "Ask <bot> to summarize today",
  "Show me <bot>'s screen",
  "What did <bot> find?",
  "Start a group with <bot> and <bot>",
  "Create a bot named <name> that <does something>",
  "Turn off <bot>'s notifications",
];
const HELP_ROSTER_MS = 2_500;

server.registerTool(
  "grokbot_help",
  {
    title: "How to use Grok Bot",
    description:
      "Show how to set up and use Grok Bot: a card with the setup steps (checked on this Mac), then things the user can say. Use when the user asks how to use or set up Grok Bot, what Grok Bot can do, or for help with this integration.",
    inputSchema: {
      page: z
        .enum(["setup", "keychain", "ideas"])
        .optional()
        .describe(
          "'ideas' when the user asks only what they can do or say with Grok Bot; 'keychain' when they ask about a Keychain / password popup from Grok Bot or macOS; omit to start on setup.",
        ),
    },
    annotations: { readOnlyHint: true },
  },
  async (args: { page?: "setup" | "keychain" | "ideas" }) =>
    handle("grokbot_help", async () => {
      const signedIn = hasGatewaySession();
      let agents: Agent[] = [];
      let bots: number | undefined;
      if (signedIn) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          agents = await Promise.race([
            listAgents(),
            new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("roster read timed out")), HELP_ROSTER_MS); }),
          ]);
          bots = agents.filter((a) => !a.isGroup).length;
        } catch (error) {
          log("grokbot_help roster read failed:", error);
        } finally {
          clearTimeout(timer);
        }
      }
      // A signed-in session proves the app is there even if it lives elsewhere.
      const setup = { app: hasGrokBotApp() || signedIn, signedIn, ...(bots === undefined ? {} : { bots }), notifications: notificationsEnabled() };
      const done: Record<string, boolean> = { app: setup.app, signedIn, bots: (bots ?? 0) > 0, notifications: setup.notifications };
      const steps = HELP_STEPS.map((s) => ({ step: s.text, done: done[s.key], ...("optional" in s ? { optional: true } : {}) }));
      const next = steps.find((s) => !s.done && !s.optional);
      return result(
        {
          steps,
          ...(bots === undefined && signedIn ? { botsUnknown: true } : {}),
          thingsToSay: HELP_PHRASES,
          message: next ? `Next step: ${next.step}` : "Grok Bot is set up. The card shows things to say.",
        },
        guideCard(setup, agents, args.page === "ideas" ? 2 : args.page === "keychain" ? 1 : 0),
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
        args.show ? await conversationCard(agents, openOf(bot), tail) : undefined,
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
    // No `message`: the model writes it once, in grokbot_send / grokbot_group.
    // Taking it here too made a long task get typed twice (~15 s more).
  },
  annotations: { readOnlyHint: true },
}, async (args: MessageArgs) => handle("grokbot_prepare_message", async () => {
  const agents = await listAgents();
  if (args.bot !== undefined && (args.group !== undefined || args.members !== undefined)) {
    throw new IntegrationError("not_found", "Choose one bot or a group of bots.");
  }
  // No recipient at all ("send this task to Grok Bot"): hand back each bot's
  // role so the model picks one. Plain JSON, no glance: grokbot_show would
  // put the roster card on screen before the send's card.
  if (args.bot === undefined && args.group === undefined && args.members === undefined && args.groupName === undefined) {
    const bots = agents.filter(a => !a.isGroup);
    if (!bots.length) throw new IntegrationError("not_found", "You don't have any Grok bots yet.");
    return result({ ready: false, nextTool: "grokbot_send",
      bots: bots.map(b => ({ id: b.id, name: b.name, role: [b.title, b.description].map(t => (t ?? "").trim()).filter(Boolean).join(": ") })),
      message: "The user named no bot. Pick the one bot whose role fits the task and call grokbot_send with its id as bot and the whole message. If none or several fit, ask the user which bot." });
  }
  let target: Agent | undefined;
  let resolved: MessageArgs;
  if (args.bot !== undefined) {
    target = resolveMessageRecipient(args.bot, agents.filter(a => !a.isGroup));
    resolved = { bot: target.id };
  } else {
    const { existing, memberIds } = resolveMessageGroup(args, agents);
    target = existing;
    if (!existing && !memberIds.length && args.members === undefined && args.groupName === undefined) {
      throw new IntegrationError("not_found", "Which bot or group do you want to message?");
    }
    const { message: _dropped, ...rest } = args;
    resolved = { ...rest, ...(existing ? { group: existing.id } : {}), members: memberIds };
  }
  const threads: Record<string, ConfirmRow[]> = {};
  if (target) {
    try { threads[target.id] = await recentRows(target.id); }
    catch { /* Registration can precede the first transcript. */ }
  }
  const send = args.bot !== undefined;
  const keep = [...(target ? [target.id, ...(target.memberIds ?? [])] : []), ...(Array.isArray(resolved.members) ? resolved.members : [])];
  const context = confirmationContext(send ? agents.filter(a => !a.isGroup) : agents, threads, keep, send);
  // NO glance here, on purpose: a glance on a pre-step becomes the turn's
  // result on screen, and the chat card grokbot_send / grokbot_group opens
  // a moment later must be the one the user sees.
  return result({ ready: true, nextTool: args.bot !== undefined ? "grokbot_send" : "grokbot_group",
    args: { ...resolved, confirmationContext: context }, message: "Recipients verified. Call nextTool with the returned args plus the message." });
}));

// ── WRITE: the one 1:1 send path — only the card's send arrow reaches it ──
// Resolves the recipient by exact identity, sends once and starts the reply
// watch. No receipt: the card that sent stays open and its live chat refreshes
// to show the message and the reply.
async function performSend(botRef: string, rawMessage: string | undefined) {
  const message = rawMessage?.trim() ?? "";
  const agents = await listAgents();
  const bot = resolveMessageRecipient(botRef, agents);
  if (!message) throw new IntegrationError("not_found", "What should I send?");

  // A group opened on the card: send as-is (member/name edits go through
  // performGroupSend, which the card uses for its group modes).
  if (bot.isGroup) {
    await sendPrompt(bot.id, message);
    return result({ sent: true, group: bot.id, groupName: bot.name, sentMessage: message, message: `Sent your message to ${bot.name}.` });
  }

  await sendToBot(bot, message);
  return result({ sent: true, bot: bot.name, sentMessage: message, message: `Sent your message to ${bot.name}.` });
}

/** Send once to one bot and start the reply watch. `base` is a transcript
 * page read BEFORE this send (the reply watch skips what it already had). */
async function sendToBot(bot: Agent, message: string, base?: { entries?: TranscriptEntry[] }) {
  const seen = new Set(((base ?? await transcriptTail(bot.id, 12)).entries ?? []).map((e) => e.id));
  await sendPrompt(bot.id, message);
  // Acknowledge immediately, then watch in the background and ping under the
  // notch when the reply lands. No foreground wait — replies run ~40s, past
  // what VoiceOS lets a tool block for.
  watchThreadThenNotify(bot, seen, message);
}

// ── WRITE: grokbot_send — voice sends at once, then opens the bot's chat ──
// No confirmation card and no draft to approve: "Send a message to Pepper"
// sends, and the card opens on Pepper's chat with the message flying from the
// box into the orb, the same as a tap send. No `readOnlyHint` (it sends), and
// no `confirmation`, so the host's ask switch defaults to "Don't ask".
const sendTool = server.registerTool(
  "grokbot_send",
  {
    title: "Send to a bot",
    description: SEND_DESCRIPTION,
    inputSchema: {
      confirmationContext: z.string().optional().describe(CONTEXT_DESCRIPTION),
      bot: z.string().describe("One Grok Bot's name as spoken, or its exact ID from grokbot_prepare_message. The SDK hook verifies the recipient."),
      recipientId: z.string().optional().describe("Internal: recipient ID pinned by the preparation hook. Never compose or change this value."),
      message: z
        .string()
        .optional()
        .describe("The message or task, written TO the bot the way the user would type it: meaning kept, lead-in verbs like 'tell Pepper to' dropped, reported speech made direct ('ask Pepper how the test is going' → 'How's the test going?')."),
      // Must be declared here too (not just the manifest): the MCP layer parses
      // args against THIS schema and strips anything not listed, so without it
      // the card's via:"card" never reaches the handler.
    },
    _meta: { [INTENT_SLOT_VALUES_META_KEY]: { bot: [] } },
  },
  async (args: { bot: string; message?: string; recipientId?: string }) =>
    handle("grokbot_send", async () => {
      const agents = await listAgents();
      const bot = resolveMessageRecipient(args.recipientId ?? args.bot, agents.filter((a) => !a.isGroup));
      const text = tidySpoken(args.message ?? "");
      // Read BEFORE sending: the card's history then ends just before this
      // message, which arrives as the fly-in and the live chat's next refresh.
      const tail = await transcriptTail(bot.id, 20);
      if (!text) {
        return result({ opened: true, sent: false, bot: bot.name, message: `Opened ${bot.name}. Nothing was sent.` },
          await conversationCard(agents, { bot: bot.id }, tail));
      }
      await sendToBot(bot, text, tail);
      return result(
        { sent: true, bot: bot.name, sentMessage: text, message: `Sent your message to ${bot.name}.` },
        await conversationCard(agents, { bot: bot.id }, tail, text, true),
      );
    }),
);

// ── WRITE: grokbot_card_send — the card composer's send, NO host confirmation ──
// The one tool that sends. The manifest entry has no `confirmation` block, so
// VoiceOS never floats its "Confirm action" dialog over the card: the user's
// own keystrokes + send click in the card ARE the approval. Exact recipient
// identity, empty text refused.
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
        ? performSend(args.bot, args.message)
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

// ── WRITE: grokbot_notifications (confirmation: declarative card) ────────────
// The per-bot "Notify on updates" switch from the Grok Bot app. The reply and
// scheduled-task pings above read it, so muting here silences that bot's pills.
const notifyTool = server.registerTool(
  "grokbot_notifications",
  {
    title: "Bot notifications",
    description:
      "Turn one Grok Bot's notifications on or off (the bot's \"Notify on updates\" switch in the Grok Bot app). Off means no notch ping when that bot replies or finishes a scheduled task. Use when the user asks to mute, silence, unmute, or turn on/off notifications for a bot. Not for all bots at once: that is the \"Show notifications from bots\" setting in Grok Bot's VoiceOS settings.",
    inputSchema: {
      bot: z.string().describe("The bot's name as the user said it."),
      enabled: z.boolean().describe("true to turn the bot's notifications on, false to turn them off."),
    },
  },
  async (args: { bot: string; enabled: boolean }) =>
    handle("grokbot_notifications", async () => {
      const agents = await listAgents();
      const bot = await resolveAgent(args.bot?.trim() ?? "", agents);
      const enabled = args.enabled === true;
      if (botNotifies(bot) !== enabled) await setAgentNotifyOnUpdates(bot.id, enabled);
      const word = enabled ? "on" : "off";
      const note = enabled && !notificationsEnabled()
        ? " \"Show notifications from bots\" is off in Grok Bot's VoiceOS settings, so turn that on too to see them."
        : "";
      return result(
        { bot: bot.name, notifications: enabled, message: `Turned ${word} notifications for ${bot.name}.${note}` },
        {
          _voiceos_glance: {
            blocks: [
              { type: "header", title: bot.name.slice(0, 60), trailing: `Notifications ${word}` },
            ],
          },
        },
      );
    }),
);

// ── WRITE: the one GROUP send path — only the card's send arrow reaches it ──
// Saves member/name edits (or creates the group on first send) and sends once.
// The card that sent stays open: an existing group's chat refreshes, and a new
// group's pane becomes that group's chat from the returned id.
async function performGroupSend(args: { group?: string; members?: string | string[]; groupName?: string; message?: string }) {
  const s = await sendToGroup(args, await listAgents());
  // The card that sent keeps going: a new group's pane turns into that group's
  // chat from the returned id, name and members.
  return result({ sent: true, group: s.group, groupName: s.groupName, members: s.members, created: s.created,
    sentMessage: s.sentMessage, message: `Sent your message to ${s.groupName}.` });
}

/** Save member/name edits (or create the group) and send once. */
async function sendToGroup(args: { group?: string; members?: string | string[]; groupName?: string; message?: string }, agents: Agent[]) {
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
  return { group: target.id, groupName: savedName, members: memberIds, created: !existing, sentMessage: message };
}

// ── WRITE: grokbot_group — voice sends at once, then opens the group chat ──
// With a message, an existing group (by name, or the same member set) or a new
// one with at least two bots gets it at once: spoken member/name edits are
// saved, a new group is created, and the card opens on that group's chat with
// the message flying into its avatars. Without a message, or with too few bots
// for a new group, it only opens the pane (a new group's is created on the
// card's first send).
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
      message: z.string().optional().describe("The message to send, written TO the group the way the user would type it: lead-in commands removed, reported speech made direct."),
    },
  },
  async (args: { group?: string; members?: string | string[]; groupName?: string; message?: string }) =>
    handle("grokbot_group", async () => {
      const agents = await listAgents();
      const { existing, memberIds, sameSet } = resolveMessageGroup(args, agents);
      const draft = tidySpoken(args.message ?? "");
      if (draft && (existing || memberIds.length >= 2)) {
        // Read BEFORE sending (see grokbot_send). A new group has no history.
        const tail = existing ? await transcriptTail(existing.id, 20) : {};
        const s = await sendToGroup({ ...args, message: draft }, agents);
        // Re-read the roster: it now has the new group, or the saved edits.
        return result(
          { sent: true, group: s.groupName, members: s.members, created: s.created, sentMessage: s.sentMessage,
            message: `${s.created ? `Created ${s.groupName} and sent` : "Sent"} your message${s.created ? "" : ` to ${s.groupName}`}.` },
          await conversationCard(await listAgents(), { group: s.group }, tail, s.sentMessage, true),
        );
      }
      if (existing) {
        // Spoken member/name changes open as pending edits on the group's pane;
        // the card's send saves them (performGroupSend) before it sends.
        const members = sameSet(existing.memberIds ?? [], memberIds) ? undefined : memberIds;
        const newName = args.groupName?.trim();
        const groupName = newName && newName !== existing.name ? newName : undefined;
        const edits = [members && "members", groupName && "name"].filter(Boolean).join(" and ");
        const tail = await transcriptTail(existing.id, 20);
        return result(
          { opened: true, sent: false, group: existing.name, draft,
            ...(members ? { members } : {}), ...(groupName ? { groupName } : {}),
            message: `Opened ${existing.name}.${edits ? ` The new ${edits} save when you send.` : ""}` },
          await conversationCard(agents, { group: existing.id, ...(members ? { members } : {}), ...(groupName ? { groupName } : {}) }, tail, draft),
        );
      }
      const name = args.groupName?.trim() ?? "";
      const ready = draft ? " Your message is in the box: add at least two bots, then press send." : "";
      return result(
        { opened: true, sent: false, newGroup: true, members: memberIds, draft,
          message: `Opened a new group${name ? ` called ${name}` : ""}. Pick members if needed.${ready}` },
        await conversationCard(agents, { members: memberIds, ...(name ? { groupName: name } : {}) }, {}, draft),
      );
    }),
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
      const agents = await listAgents();
      const bot = await resolveAgent(args.bot.trim(), agents);
      // Every bot has its OWN cloud desktop (its "forever box"), which persists
      // between tasks. The probe here only tells the model whether it is up; the
      // card's screen pane runs its own probe (grokbot_card_screen) and streams it.
      const probe = await agentScreen(bot.id);
      const live = probe.live;
      const working = Boolean(bot.isRunning || bot.isRunningTurn || bot.isComposingMessage);
      // The same roster card taps reach (chat → screen, with a back button), opened
      // on this bot's screen pane. History is a nicety one Back away: best-effort.
      let tail: Awaited<ReturnType<typeof transcriptTail>> = {};
      try { tail = await transcriptTail(bot.id, 30); }
      catch (error) { log("view_bot_desktop_live transcript read failed:", error); }
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
        await conversationCard(agents, { bot: bot.id, screen: true }, tail),
      );
    }),
);

// ── CARD: grokbot_open_computer_window (larger native interactive screen) ──────
// Card-only: opened when the user TAPS the live screen pane; no voice intent.
server.registerTool(
  "grokbot_open_computer_window",
  {
    title: "Open a bot's computer window",
    description:
      "Internal — invoked by the show card's live screen pane when the user taps it, to open that bot's computer in a larger window. Do not call from voice.",
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

// ── CARD: grokbot_card_screen — the show card's screen pane fetches the feed ──
// Card-only: invoked when the user opens the in-card screen pane (the chat header's
// screen button). Returns the live websockify socket AND the noVNC viewer bundle,
// so the show card — THE surface, rendered every turn — need not carry the 57KB
// viewer itself; it rides this result only when a stream exists. Plain JSON (no glance):
// the pane renders it with its own bundled RFB loader. Do not call from voice.
server.registerTool(
  "grokbot_card_screen",
  {
    title: "Open a bot's screen in the card",
    description:
      "Internal — invoked by the show card's screen pane to load a bot's live desktop inside the card. Do not call from voice.",
    inputSchema: {
      bot: z.string().describe("The exact bot ID shown on the card."),
    },
    annotations: { readOnlyHint: true },
  },
  async (args: { bot: string }) =>
    handle("grokbot_card_screen", async () => {
      // Voice supplies a spoken name; the card supplies its exact id — resolveMembers accepts both.
      const [bot] = await resolveMembers([args.bot.trim()]);
      const probe = await agentScreen(bot.id);
      const live = Boolean(probe.live && probe.wsUrl);
      return result({
        bot: bot.name,
        live,
        wsUrl: live ? probe.wsUrl! : "",
        // The gzip+base64 noVNC client, only when there is a stream to show.
        viewer: live ? RFB_B64 : "",
        message: live ? undefined : `${bot.name}'s computer is not running right now.`,
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

const intentSupport = registerIntentSupport(server, { named: [showTool, threadTool, screenTool, notifyTool], labeled: [sendTool] }, intentRoster, error => log("Intent roster refresh failed:", error));
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

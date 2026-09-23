/**
 * UI layer: the notch cards.
 *
 * Messaging HTML/CSS/JS in widgets/thread.html, sent.html, and sent-group.html
 * is copied byte-for-byte from the user's handoff. The separate messaging
 * adapter supplies live data, host tool calls, and frame bounds at render time.
 * The live conversation (widgets/live-chat.js) and the composer's attach/teach
 * menu (widgets/composer-kit.js) are injected the same way, into the thread
 * card and the show card's chat pane only — never into receipts.
 *
 * This file runs in the UNSANDBOXED server process, so it may read the widget
 * files from disk; only the card iframe itself is network/fs-restricted.
 */
import type { Agent, TranscriptEntry } from "./client.ts";
// Every card asset (widget HTML, adapters, CSS, the mark, the RFB viewer) is
// frozen into assets.generated.ts by scripts/inline-assets.mjs so `bun build`
// inlines it into the shared single-file server.ts. Reading these from disk
// broke every shared build (the widgets/ folder never ships). Regenerate with
// `node scripts/inline-assets.mjs` after changing any widget; build-publish runs
// it automatically. The mark is a data: URI because the card sandbox blocks the
// network; it is a 32px copy (the mark draws at 16px), embedded once per card.
import {
  WIDGETS, MESSAGING_ADAPTER, CONFIRMATION_ADAPTER, MESSAGING_CSS, MARK_DATA_URI, RFB_B64,
  LIVE_CHAT_JS, LIVE_CHAT_CSS, MARKDOWN_CSS, COMPOSER_KIT_JS, COMPOSER_KIT_CSS, SHOW_ADAPTER,
} from "./assets.generated.ts";
import { toCardThread, boundThread, type CardItem } from "./conversation.ts";

type CardName = "connect" | "show" | "sent-group" | "sent" | "create" | "thread" | "screen";

/** Swap the widgets' placeholder glyph (`.mark > i`) for the real logo, bare (no
 * tile), per the design handoff. Only the `.mark` glyph is targeted — but the
 * `.mark` element may carry its own attributes (e.g. screen.html's inline
 * `style`), so match the open tag with any attributes and replace just the inner
 * `<i></i>` placeholder, keeping the element (and its attributes) intact. A plain
 * `class="mark"><i></i>` string match missed those and left the empty glyph.
 * The logo is ONE CSS background per card, not an inline <img> per mark: the
 * thread card writes its mark three times (markup + two header templates), and
 * three copies of the data URI cost ~12KB of the 96k glance cap. A <b>, not an
 * <i>, so the handoff's `.mark i` placeholder styles never apply to it. */
const MARK_CSS = `.voiceos-mk{display:inline-block;flex:none;width:16px;height:16px;border-radius:5px;vertical-align:middle;background:url(${MARK_DATA_URI}) center/contain no-repeat}`;
export function injectMark(html: string): string {
  let marks = 0;
  const out = html.replace(/(class="mark"[^>]*>)<i><\/i>/g, (_, open: string) =>
    (marks++, `${open}<b class="voiceos-mk" role="img" aria-label="Grok Bot"></b>`));
  return marks ? out.replace("<style>", () => `<style>${MARK_CSS}\n`) : out;
}

// The in-card VNC viewer (noVNC RFB, gzip+base64), built by `bun run build-rfb`.
// Only the screen card carries it, and only when there is a live stream — the
// idle screen card and every other card stay small. See scripts/build-rfb.ts
// for why the viewer must live inside the card at all. (RFB_B64 is embedded via
// assets.generated.ts — imported at the top of this file.)

/**
 * The cap that actually gates a glance: VoiceOS accepts a widget glance only
 * when JSON.stringify({ blocks }).length <= 96 000 (validateGlancePayload,
 * verified on 0.2.27). Over it, the card is silently dropped and the notch
 * shows the raw tool JSON. WIDGET_CAPS.htmlChars (131072) is a second, looser
 * check on the html alone.
 */
const MAX_GLANCE_CHARS = 96_000;
export const glanceChars = (card: { _voiceos_glance: { blocks: unknown[] } }) =>
  JSON.stringify({ blocks: card._voiceos_glance.blocks }).length;

const STRIP_COMMENTS = new Set<CardName>(["screen", "thread", "show"]);

/** The widget HTML with the real mark + real {data, args} injected. `fills`
 * replaces extra `__VOICEOS_<KEY>__` tokens (today: RFB on the screen card);
 * any token a widget declares but a call doesn't fill becomes the empty string. */
export function renderCard(
  name: CardName,
  payload: { data?: unknown; args?: unknown } = {},
  fills: Record<string, string> = {},
): string {
  const json = JSON.stringify({ data: payload.data ?? {}, args: payload.args ?? {} })
    .replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  // Function replacers so `$` in the data can't be read as a replacement pattern.
  // The live screen, thread and show cards sit near the 96k glance cap, so their
  // source comments are dropped at render time (before any data/viewer/asset
  // fill, so only the template is touched). None of these templates has "/*"
  // inside a string — check-screen and tests/cards.test.ts guard that.
  const template = STRIP_COMMENTS.has(name) ? WIDGETS[name].replace(/\/\*[\s\S]*?\*\/\n?/g, "") : WIDGETS[name];
  let html = injectMark(template).replace(/__VOICEOS_([A-Z]+)__/g, (token, key: string) => key === "DEMO" ? token : fills[key] ?? "");
  const confirmation = Boolean((payload.data as { confirmation?: boolean })?.confirmation);
  if (["thread", "sent", "sent-group"].includes(name)) {
    html = html.replace(/^const DEMO=.*;$/m, () => `const DEMO=${json};`);
    // The live conversation (refresh, older messages, markdown, media, requests,
    // attach/teach) rides only on a real thread card. A confirmation is a
    // host-approved draft, and a sent receipt is a receipt: both keep their
    // original adapter, and receipts get none of the extra bytes. The new-group
    // mode (args.members, no args.group) has no conversation yet and no + menu,
    // so it skips the ~40KB of live code too.
    const args = payload.args as { group?: string; members?: unknown } | undefined;
    const newGroup = !args?.group && Array.isArray(args?.members);
    const live = name === "thread" && !confirmation && !newGroup;
    const script = confirmation ? pinnedConfirmationAdapter()
      : live ? `${LIVE_CHAT_JS}\n${COMPOSER_KIT_JS}\n${MESSAGING_ADAPTER}` : MESSAGING_ADAPTER;
    const css = confirmation ? `${MESSAGING_CSS}\n${MARKDOWN_CSS}`
      : live ? `${MESSAGING_CSS}\n${MARKDOWN_CSS}\n${LIVE_CHAT_CSS}\n${COMPOSER_KIT_CSS}` : MESSAGING_CSS;
    // One lexical scope per document, including after the in-place sent transition.
    // Original source files stay intact; the adapter overrides only live wiring.
    html = html.replace("<script>", "<script>\n(()=>{\n")
      .replace("</script>", () => `\n${script}\n})();\n</script>`);
    html = html.replace("<script>", () => `<style>${css}</style>\n<script>`);
  } else {
    html = html.replace("__VOICEOS_DEMO__", () => json);
    if (name === "show") {
      // show.html's top-level functions (openChat, invoke, CAN_INVOKE, D, …) are
      // script-global, so the glue in its own IIFE can wrap them without the
      // assets' helpers leaking into (or colliding with) the handoff's scope.
      // Anchor on <script>, not </style>: show.html has several style blocks.
      // After the data fill, so no asset text is ever read as a token.
      html = html.replace("</script>", () => `\n(()=>{\n${LIVE_CHAT_JS}\n${COMPOSER_KIT_JS}\n${SHOW_ADAPTER}\n})();\n</script>`)
        .replace("<script>", () => `<style>${MARKDOWN_CSS}\n${LIVE_CHAT_CSS}\n${COMPOSER_KIT_CSS}</style>\n<script>`);
    }
  }
  return pruneShapeCss(name, payload.data, html);
}

/** The confirmation adapter stages the resolved bot ID for `bot`. A fast intent
 * approves an enum NAME, and the host re-validates the edited args against that
 * enum — an ID there fails the approval. So a grokbot_send confirmation pins
 * the name it was opened with (the server re-resolves it with recipientId).
 * Built lazily: it only renders at freeze-confirms/test time, where a missing
 * anchor must fail the build instead of silently shipping an unpinned card. */
let _pinned: string | undefined;
export function pinnedConfirmationAdapter(adapter = CONFIRMATION_ADAPTER): string {
  if (adapter === CONFIRMATION_ADAPTER && _pinned) return _pinned;
  const stageAnchor = "stage = function(key, value) {";
  const bootAnchor = "confirmationBooted = true;";
  if (!adapter.includes(stageAnchor) || !adapter.includes(bootAnchor))
    throw new Error("confirmation-adapter.js changed: the recipient-pin anchors are missing");
  const out = `let confirmationBotRef;\n${adapter}`
    .replace(stageAnchor, () => `${stageAnchor}\n  if (key === 'bot' && typeof confirmationBotRef === 'string') value = confirmationBotRef;`)
    .replace(bootAnchor, () => `${bootAnchor}\n  if (DEMO.data.tool === 'grokbot_send') confirmationBotRef = event.data.args?.bot;`);
  if (adapter === CONFIRMATION_ADAPTER) _pinned = out;
  return out;
}

/** Every widget ships clip-path polygons for all 8 Grok avatar shapes (~6.5KB).
 * A read card only needs the shapes its bots actually use, and the screen card
 * in particular must stay under MAX_GLANCE_CHARS with the 57KB viewer bundle on
 * board — so drop the unused rules. The create card keeps all 8 (its picker
 * shows every shape); `blob` always stays because adapters use it as the
 * placeholder shape for unresolved recipients. A confirmation keeps all 8 too:
 * it is frozen into the manifest with an empty sample roster, and its real
 * bots arrive later over voiceos:init (pruning it left them as squares). */
function pruneShapeCss(name: CardName, data: unknown, html: string): string {
  const bots = (data as { bots?: { shape?: string }[] } | undefined)?.bots;
  if (name === "create" || (data as { confirmation?: boolean } | undefined)?.confirmation || !Array.isArray(bots)) return html;
  const used = new Set<string>(["blob", ...bots.map((b) => b.shape ?? "blob")]);
  return html.replace(/\.av\.([a-z]+),\.shapes button\.\1\{clip-path:polygon\([^)]*\)\}/g, (rule, shape: string) =>
    used.has(shape) ? rule : "");
}

/** A read tool's glance: one widget block. Heights are a starting point — each
 * widget re-reports its true height over voiceos:resize (host clamps 60–420). */
export function glance(
  name: CardName,
  payload: { data?: unknown; args?: unknown },
  height: number,
  label: string,
  fills: Record<string, string> = {},
) {
  return {
    _voiceos_glance: {
      blocks: [{ type: "widget" as const, html: renderCard(name, payload, fills), height, label }],
    },
  };
}

// ── gateway Agent → card `data` shape ────────────────────────────────────────

// Grok Bot stores a named color + shape per bot. Both lists below are lifted
// from Grok Bot's own bundle (its avatar palette and its avatar picker), so a
// bot looks the same in our cards as it does in the Grok Bot app.
//
// Colors: Grok's palette id → its exact hex. `black` exists in the palette but
// Grok hides it from the picker, so we do too.
export const GROK_COLOR_HEX = {
  orange: "#FF6700", yellow: "#FF9800", red: "#FF263C", magenta: "#FF309B", violet: "#9159FE",
  blue: "#1084FE", cyan: "#00BCA6", green: "#00C972", brown: "#936439", gray: "#777777",
} as const;
export type GrokColor = keyof typeof GROK_COLOR_HEX;
export const GROK_COLOR_IDS = Object.keys(GROK_COLOR_HEX) as [GrokColor, ...GrokColor[]];

// Shapes: the 8 Grok lets a user pick. Its bundle knows 10 more (bean, egg,
// capsule, …) that only arrive via bot templates; those fall back to the
// nearest pickable shape so nothing silently turns into a circle.
export const GROK_SHAPE_IDS = ["blob", "pebble", "squircle", "tablet", "wedge", "hex", "cloud", "teardrop"] as const;
export type GrokShape = (typeof GROK_SHAPE_IDS)[number];
const SHAPE_FALLBACK: Record<string, GrokShape> = {
  bean: "pebble", egg: "blob", capsule: "tablet", cylinder: "squircle", gem: "hex",
  crystal: "hex", shield: "squircle", dome: "cloud", arch: "tablet", leaf: "teardrop",
};

const colorHex = (c?: string): string => {
  if (!c) return GROK_COLOR_HEX.orange;
  if (c.startsWith("#")) return c;
  return GROK_COLOR_HEX[c.toLowerCase() as GrokColor] ?? GROK_COLOR_HEX.orange;
};
const shapeKind = (s?: string): GrokShape => {
  const id = (s ?? "").toLowerCase();
  if ((GROK_SHAPE_IDS as readonly string[]).includes(id)) return id as GrokShape;
  return SHAPE_FALLBACK[id] ?? "blob";
};

// ── Tolerant input → Grok id (what the create tool sends to the gateway) ─────
// VoiceOS caches the create card + schema in its config.json, so a stale card
// can still send the OLD vocabulary (a design hex like #3D7BFF, or circ|sq|hex)
// or a spoken synonym ("purple", "circle"). Map all of that to a real Grok id
// instead of failing the create. Returns undefined for nothing/unknown so Grok
// picks its own default.
const LEGACY_COLOR: Record<string, GrokColor> = {
  purple: "violet", pink: "magenta", teal: "cyan", turquoise: "cyan", grey: "gray", black: "gray",
  gold: "yellow", amber: "orange", crimson: "red", navy: "blue",
};
const LEGACY_SHAPE: Record<string, GrokShape> = {
  circ: "blob", circle: "blob", round: "blob", dot: "blob",
  sq: "squircle", square: "squircle", rounded: "squircle", rect: "squircle",
  hexagon: "hex", triangle: "wedge", drop: "teardrop", tear: "teardrop", pill: "tablet",
};
const hexToRgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
export function normalizeColorId(input?: string): GrokColor | undefined {
  const c = (input ?? "").trim().toLowerCase();
  if (!c) return undefined;
  if (c in GROK_COLOR_HEX) return c as GrokColor;
  if (LEGACY_COLOR[c]) return LEGACY_COLOR[c];
  if (/^#[0-9a-f]{6}$/.test(c)) {
    // Nearest palette entry by RGB distance.
    const [r, g, b] = hexToRgb(c);
    let best: GrokColor = "orange", bestD = Infinity;
    for (const [id, hex] of Object.entries(GROK_COLOR_HEX) as [GrokColor, string][]) {
      const [pr, pg, pb] = hexToRgb(hex.toLowerCase());
      const d = (r - pr) ** 2 + (g - pg) ** 2 + (b - pb) ** 2;
      if (d < bestD) { bestD = d; best = id; }
    }
    return best;
  }
  return undefined;
}
export function normalizeShapeId(input?: string): GrokShape | undefined {
  const s = (input ?? "").trim().toLowerCase();
  if (!s) return undefined;
  if ((GROK_SHAPE_IDS as readonly string[]).includes(s)) return s as GrokShape;
  return LEGACY_SHAPE[s] ?? SHAPE_FALLBACK[s];
}

function statusOf(a: Agent): "working" | "idle" | "thinking" | "waiting" {
  if (a.awaitingUserResponse) return "waiting";
  if (a.isComposingMessage) return "thinking";
  // The gateway's isRunning is authoritative when present; isRunningTurn is the
  // older field and can stay set after the turn has ended.
  if (a.isRunning ?? a.isRunningTurn) return "working";
  return "idle";
}

/** Relative time label ("now", "5m", "3h", "Yesterday", "Mon", "Sep 3").
 * widgets/live-chat.js carries an exact port of this for refreshed items. */
export function relTime(ms?: number): string {
  if (!ms) return "";
  const min = Math.floor((Date.now() - ms) / 60000);
  if (min < 1) return "now";
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  if (day === 1) return "Yesterday";
  if (day < 7) return new Date(ms).toLocaleDateString(undefined, { weekday: "short" });
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** One bot in the card's `data.bots` shape. */
export function toBot(a: Agent) {
  return {
    id: a.id,
    name: a.name,
    label: a.title ?? "",
    color: colorHex(a.avatarColor),
    shape: shapeKind(a.avatarShape),
    status: statusOf(a),
    task: (a.lastMessagePreview ?? "").trim(),
    time: relTime(a.lastActivityAt),
  };
}

/** One group in the card's `data.groups` shape. */
export function toGroup(a: Agent) {
  return {
    id: a.id,
    name: a.name,
    members: a.memberIds ?? [],
    last: (a.lastMessagePreview ?? "").trim(),
    time: relTime(a.lastActivityAt),
  };
}

/** A message as baked into a card: the CardItem plus `t`, its relative-time
 * label. `t` is presentation only — it is added here, at render time, and never
 * to snapshot/entry results (it would change their version hashes); the live
 * chat recomputes it with its port of relTime. */
export type BakedItem = CardItem & { t?: string };
const withTime = (items: CardItem[]): BakedItem[] =>
  items.map((item) => {
    const t = relTime(item.timestampMs);
    return t ? { ...item, t } : item;
  });

/**
 * transcript entries → the card's `thread` shape (every user-facing message:
 * text as sanitized markdown `html`, media by name/index only, choices,
 * requests, notices, "Messaged" rows). "me" is the human; bot and inter-agent
 * turns sit on the bot side with `bot` = the sending bot. `maxChars` bounds
 * the serialized thread (oversized messages become 160-char previews).
 */
export function toThread(entries: TranscriptEntry[], maxChars?: number): BakedItem[] {
  const items = toCardThread(entries);
  return withTime(maxChars === undefined ? items : boundThread(items, maxChars));
}

type Glance = ReturnType<typeof glance>;
const fits = (card: Glance) => glanceChars(card) <= MAX_GLANCE_CHARS;

/** Bake as much history as the glance cap allows. Oversized messages become
 * deferred previews first (boundThread halves its budget until the card fits;
 * the live chat loads them in full). Too many short messages to defer: keep
 * only the newest, and tell `render` the history is incomplete so it omits
 * nextBeforeSeq (that cursor would skip the dropped ones; the first refresh
 * brings a fresh one). */
function fitThread(items: CardItem[], render: (thread: BakedItem[], complete: boolean) => Glance): Glance {
  for (const budget of [40_000, 20_000, 10_000, 5_000, 4_000]) {
    const card = render(withTime(boundThread(items, budget)), true);
    if (fits(card)) return card;
  }
  for (let keep = items.length >> 1; keep > 0; keep >>= 1) {
    const card = render(withTime(boundThread(items.slice(-keep), 4_000)), false);
    if (fits(card)) return card;
  }
  return render([], false);
}

// ── Card builders per tool ───────────────────────────────────────────────────

/** show.html — roster (+ groups). `threads` is an optional per-bot recent-message
 * map (id → CardItems, bots and groups) so the in-card chat pane opens
 * populated; `nextBeforeSeqs` are their "Earlier messages" cursors. Histories
 * are a nicety (the pane refreshes as it opens), so they shrink, then drop —
 * the roster itself always fits. */
export function showCard(
  agents: Agent[],
  me?: string,
  threads: Record<string, CardItem[]> = {},
  nextBeforeSeqs: Record<string, number | undefined> = {},
) {
  const bots = agents.filter((a) => !a.isGroup).map(toBot);
  const groups = agents.filter((a) => a.isGroup).map(toGroup);
  const card = (ids: string[], perThread: number) => {
    const baked = Object.fromEntries(ids.map((id) => [id, withTime(boundThread(threads[id], perThread))]));
    const seqs = Object.fromEntries(ids.filter((id) => typeof nextBeforeSeqs[id] === "number").map((id) => [id, nextBeforeSeqs[id]]));
    return glance("show", { data: { bots, groups, me: me ?? "", threads: baked, nextBeforeSeqs: seqs }, args: {} }, 320, "Grok Bot");
  };
  // Roster order: the first rows are the ones on screen, so they keep theirs longest.
  const ids = agents.map((a) => a.id).filter((id) => threads[id]?.length);
  for (let perThread = 8_000; perThread >= 1_000; perThread /= 2) {
    const c = card(ids, perThread);
    if (fits(c)) return c;
  }
  for (let keep = ids.length >> 1; keep > 0; keep >>= 1) {
    const c = card(ids.slice(0, keep), 1_000);
    if (fits(c)) return c;
  }
  return card([], 0);
}

/** The thread card's roster: every individual bot, for orbs, names and the
 * Members view. It never shows a bot's latest-message line (`task`, the show
 * card's row text), and with 30 bots those lines would crowd real messages
 * out of the glance budget, so it is left empty here. */
const threadRoster = (agents: Agent[]) =>
  agents.filter((a) => !a.isGroup).map((a) => ({ ...toBot(a), task: "" }));

/** thread.html 1:1 mode — one bot + its recent messages (`args.bot`). Pass
 * `agents` (the roster) so a message from ANOTHER bot resolves that bot's orb +
 * name for the "Message from …" line; without it, only the thread bot is known.
 * `nextBeforeSeq` (from the same transcript page) enables "Earlier messages". */
export function threadCard(bot: Agent, entries: TranscriptEntry[], message = "", agents?: Agent[], nextBeforeSeq?: number) {
  const bots = threadRoster(agents ?? [bot]);
  if (!bots.some((b) => b.id === bot.id)) bots.unshift({ ...toBot(bot), task: "" });
  return fitThread(toCardThread(entries), (thread, complete) =>
    glance(
      "thread",
      {
        data: { bots, thread, me: "", ...(complete && typeof nextBeforeSeq === "number" ? { nextBeforeSeq } : {}) },
        args: { bot: bot.id, message },
      },
      360,
      "Grok Bot",
    ));
}

/**
 * thread.html new-group mode — build a group (pick members from the live roster
 * in the Members view, name it), then send. `data.bots` is the full roster the
 * Members view adds from; `args.members` are the preselected bot ids; nothing is
 * created until the card's composer invokes grokbot_group with a message.
 */
export function groupComposeCard(agents: Agent[], memberIds: string[], name?: string, message = "") {
  const roster = threadRoster(agents);
  return glance(
    "thread",
    { data: { bots: roster, groups: [], thread: [], me: "" }, args: { members: memberIds, groupName: name ?? "", message } },
    380,
    "Grok Bot",
  );
}

/**
 * thread.html existing-group mode — a group that already exists, addressed by
 * `args.group` (an id into `data.groups[]`); its history lives on that group's
 * `thread`. `data.bots` stays the full roster so the Members view still renders.
 * The draft stays in the composer until the user clicks its send arrow.
 */
export function groupThreadCard(
  agents: Agent[],
  group: { id: string; name: string; members: string[] },
  entries: TranscriptEntry[],
  message = "",
  nextBeforeSeq?: number,
) {
  const roster = threadRoster(agents);
  return fitThread(toCardThread(entries), (thread, complete) =>
    glance(
      "thread",
      {
        data: {
          bots: roster,
          groups: [{ id: group.id, name: group.name, members: group.members, time: relTime(Date.now()), thread }],
          me: "",
          ...(complete && typeof nextBeforeSeq === "number" ? { nextBeforeSeq } : {}),
        },
        args: { group: group.id, groupName: group.name, members: group.members, message },
      },
      380,
      "Grok Bot",
    ));
}

/** sent.html — post-send receipt for one bot. The card reads `args.bot` (id into
 * `data.bots[]`) and `args.message` (the outgoing bubble), and drives the orb /
 * subtitle off the bot's real `status`. */
export function sentCard(bot: Agent, message: string) {
  return glance(
    "sent",
    { data: { bots: [toBot(bot)] }, args: { bot: bot.id, message } },
    260,
    "Grok Bot",
  );
}

/** 1K uses the handoff's dedicated group receipt, including the saved group id. */
export function sentGroupCard(agents: Agent[], group: { id: string; name: string; members: string[] }, message: string) {
  return glance("sent-group", {
    data: { bots: agents.filter(a => !a.isGroup).map(toBot), groups: [group] },
    args: { group: group.id, groupName: group.name, members: group.members, message },
  }, 260, "Grok Bot");
}

/** connect.html — first-run / needs-sign-in status. */
export function connectCard(account?: { name?: string; email?: string }) {
  return glance("connect", { data: { account: account ?? { name: "You" } }, args: {} }, 340, "Grok Bot");
}

/**
 * screen.html — live view of a bot's computer. `stream.wsUrl` is the computer's
 * websockify WebSocket; the card opens it with its own bundled noVNC client
 * (RFB_B64). `stream.viewerUrl` is the pod's vnc.html, kept for reference
 * only (it is unusable in a browser: its assets 404 without the token header).
 * Clicking a live screen invokes the same hardened, view-only native window
 * used by `grokbot_open_computer_window`. Each bot has its own cloud computer,
 * so every bot's "screen" is its own persistent desktop. With no stream the
 * card shows its idle state and ships without the viewer bundle.
 *
 * If the live card would ever exceed the host's byte cap (viewer grew, widget
 * grew), degrade to the idle card instead of a card the host rejects.
 */
export function screenCard(bot: Agent, stream?: { wsUrl: string; viewerUrl: string }) {
  const payload = (live: boolean) => ({
    data: { bots: [toBot(bot)] },
    args: { bot: bot.id, stream: live ? stream!.wsUrl : "" },
  });
  if (stream) {
    const card = glance("screen", payload(true), 380, "Grok Bot", { RFB: RFB_B64 });
    if (glanceChars(card) <= MAX_GLANCE_CHARS) return card;
  }
  return glance("screen", payload(false), 380, "Grok Bot");
}

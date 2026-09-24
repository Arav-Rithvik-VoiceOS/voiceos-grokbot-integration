/**
 * UI layer: the notch cards.
 *
 * The widget HTML (widgets/*.html) is the user's design handoff, kept intact.
 * The roster card (show.html) is the ONE conversation surface: its chat pane
 * gets the live conversation (widgets/live-chat.js), the composer's attach
 * button (widgets/composer-kit.js) and the send / new-group / saved-state glue
 * (widgets/show-adapter.js), injected at render time. Voice opens that same
 * card on a chat pane through args.open. The old thread card, sent receipts
 * and confirmation adapter live in archive/.
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
  WIDGETS, MARK_DATA_URI, RFB_B64,
  LIVE_CHAT_JS, LIVE_CHAT_CSS, MARKDOWN_CSS, COMPOSER_KIT_JS, COMPOSER_KIT_CSS, SHOW_ADAPTER, SHOW_CSS,
} from "./assets.generated.ts";
import { toCardThread, boundThread, type CardItem } from "./conversation.ts";
import { renderMarkdown } from "./markdown.ts";

type CardName = "connect" | "show" | "create" | "screen";

/** Swap the widgets' placeholder glyph (`.mark > i`) for the real logo, bare (no
 * tile), per the design handoff. Only the `.mark` glyph is targeted — but the
 * `.mark` element may carry its own attributes (e.g. screen.html's inline
 * `style`), so match the open tag with any attributes and replace just the inner
 * `<i></i>` placeholder, keeping the element (and its attributes) intact. A plain
 * `class="mark"><i></i>` string match missed those and left the empty glyph.
 * The logo is ONE CSS background per card, not an inline <img> per mark: the
 * thread card writes its mark three times (markup + two header templates), and
 * three copies of the data URI cost ~12KB of the glance cap. A <b>, not an
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
 * when JSON.stringify({ blocks }).length <= INTEGRATION_UI_LIMITS.widgetGlanceChars
 * (validateGlancePayload). 0.2.41 ships { glanceChars: 32e3, widgetGlanceChars: 3e5,
 * widgetHtmlChars: 3e5, hookViewChars: 3e5 } (0.2.27 had 96 000). Over it, the
 * card is silently dropped and the notch shows the raw tool JSON, so cards keep
 * a margin under 300 000. Card-invoked tool RESULTS have their own, tighter cap
 * (WIDGET_TOOL_LIMITS.resultChars 131072): snapshots and entry chunks never grow
 * with this one.
 */
export const MAX_GLANCE_CHARS = 280_000;
export const glanceChars = (card: { _voiceos_glance: { blocks: unknown[] } }) =>
  JSON.stringify({ blocks: card._voiceos_glance.blocks }).length;

const STRIP_COMMENTS = new Set<CardName>(["screen", "show"]);

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
  // The live screen and show cards carry the most bytes, so their
  // source comments are dropped at render time (before any data/viewer/asset
  // fill, so only the template is touched). None of these templates has "/*"
  // inside a string — check-screen and tests/cards.test.ts guard that.
  const template = STRIP_COMMENTS.has(name) ? WIDGETS[name].replace(/\/\*[\s\S]*?\*\/\n?/g, "") : WIDGETS[name];
  let html = injectMark(template).replace(/__VOICEOS_([A-Z]+)__/g, (token, key: string) => key === "DEMO" ? token : fills[key] ?? "");
  html = html.replace("__VOICEOS_DEMO__", () => json);
  if (name === "show") {
    // show.html's top-level functions (openChat, invoke, CAN_INVOKE, D, …) are
    // script-global, so the glue in its own IIFE can wrap them without the
    // assets' helpers leaking into (or colliding with) the handoff's scope.
    // Anchor on <script>, not </style>: show.html has several style blocks.
    // After the data fill, so no asset text is ever read as a token.
    html = html.replace("</script>", () => `\n(()=>{\n${LIVE_CHAT_JS}\n${COMPOSER_KIT_JS}\n${SHOW_ADAPTER}\n})();\n</script>`)
      .replace("<script>", () => `<style>${MARKDOWN_CSS}\n${LIVE_CHAT_CSS}\n${COMPOSER_KIT_CSS}\n${SHOW_CSS}</style>\n<script>`);
  }
  return pruneShapeCss(name, payload.data, html);
}

/** Every widget ships clip-path polygons for all 8 Grok avatar shapes (~6.5KB).
 * A read card only needs the shapes its bots actually use, and the screen card
 * in particular must stay under MAX_GLANCE_CHARS with the 57KB viewer bundle on
 * board — so drop the unused rules. The create card keeps all 8 (its picker
 * shows every shape); `blob` always stays because adapters use it as the
 * placeholder shape for unresolved recipients. */
function pruneShapeCss(name: CardName, data: unknown, html: string): string {
  const bots = (data as { bots?: { shape?: string }[] } | undefined)?.bots;
  if (name === "create" || !Array.isArray(bots)) return html;
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

/** A latest-message line is one ellipsized row on screen; the gateway's preview
 * can be a whole reply, and every roster (cards, snapshots) carries one per bot. */
const preview = (s?: string) => {
  const one = (s ?? "").trim();
  return one.length > 120 ? `${one.slice(0, 119).trimEnd()}…` : one;
};

/** One bot in the card's `data.bots` shape. */
export function toBot(a: Agent) {
  return {
    id: a.id,
    name: a.name,
    label: a.title ?? "",
    color: colorHex(a.avatarColor),
    shape: shapeKind(a.avatarShape),
    status: statusOf(a),
    task: preview(a.lastMessagePreview),
    time: relTime(a.lastActivityAt),
  };
}

/** One group in the card's `data.groups` shape. */
export function toGroup(a: Agent) {
  return {
    id: a.id,
    name: a.name,
    members: a.memberIds ?? [],
    last: preview(a.lastMessagePreview),
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

// ── Confirmation cards ───────────────────────────────────────────────────────

/** A row a send/group confirmation can draw. No live chat runs there, so
 * thread.html's own msgHtml draws `html || esc(text)` and nothing else. */
export type ConfirmRow = { id: string; from: "me" | "bot"; bot?: string; sys?: string; t?: string; text?: string; html?: string };

/** Card items (or a model's copy of these rows) → rows msgHtml can draw. A
 * question, a request or an attachment has no text of its own, so it shows its
 * prompt, title or file names instead of an empty bubble; a deferred preview
 * ends in "…"; a notice keeps no bot (CONFIRM_EXTRAS draws it without an orb).
 * Only listed fields survive, and `from` is one of two words, because msgHtml
 * puts it in a class attribute unescaped. `untrusted` rows come back through
 * the model: their markup is rebuilt from their text, never taken as given,
 * and only as many as prepare ever writes are read (the hook has 2 s). */
export function confirmationRows(items: unknown, untrusted = false): ConfirmRow[] {
  if (!Array.isArray(items)) return [];
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  return (untrusted ? items.slice(-12) : items).flatMap((raw): ConfirmRow[] => {
    if (!raw || typeof raw !== "object") return [];
    const i = raw as Record<string, any>;
    const row: ConfirmRow = { id: str(i.id), from: i.from === "me" ? "me" : "bot" };
    if (str(i.bot)) row.bot = i.bot;
    if (str(i.t)) row.t = i.t;
    if (typeof i.sys === "string") return i.sys || row.bot ? [{ ...row, sys: i.sys }] : [];
    const text = str(i.text).trim().slice(0, untrusted ? 16_000 : undefined);
    if (text && str(i.html) && !i.deferred) return [{ ...row, text, html: untrusted ? renderMarkdown(text) : i.html }];
    const names = Array.isArray(i.media) ? i.media.map((m: any) => str(m?.name)) : [];
    const alt = text ? (i.deferred ? `${text}…` : text)
      : [str(i.choice?.prompt), str(i.request?.title), ...names].map((s) => s.trim()).filter(Boolean).join(" · ");
    return alt ? [{ ...row, text: alt }] : [];
  });
}

/** Budget for a confirmation's context: the model copies prepare's verbatim
 * into the send call, and the preToolUse hook returns it in its result. The
 * rows are already bounded (toThread at 12 000); the roster gives way first. */
export const CONFIRMATION_CONTEXT_CHARS = 48_000;

/** The `confirmationContext` a send/group confirmation renders: roster for
 * names, orbs and member edits, plus each target's rows. The handoff never
 * shows a bot's or group's latest-message line here, so neither ships. Over
 * budget, bots the confirmation does not show (`keep`: recipient, members,
 * row authors) lose their subtitle, then — for a `send`, whose adapter looks
 * up the recipient alone and has no Members view — drop out. */
export function confirmationContext(agents: Agent[], threads: Record<string, ConfirmRow[]>, keep: string[] = [], send = false): string {
  const shown = new Set([...keep, ...Object.values(threads).flat().map((r) => r.bot ?? "")]);
  const groups = agents.filter((a) => a.isGroup).map((a) => ({ ...toGroup(a), last: "" }));
  for (const g of groups) if (threads[g.id]) g.members.forEach((id) => shown.add(id));
  const bots = agents.filter((a) => !a.isGroup).map((a) => ({ ...toBot(a), task: "" }));
  const json = (roster: object[]) => JSON.stringify({ bots: roster, groups, threads });
  let out = json(bots);
  if (out.length <= CONFIRMATION_CONTEXT_CHARS) return out;
  const slim = slimRoster(bots, shown);
  out = json(slim);
  return out.length <= CONFIRMATION_CONTEXT_CHARS || !send ? out : json(slim.filter((b) => shown.has(b.id)));
}

type Glance = ReturnType<typeof glance>;
const fits = (card: Glance) => glanceChars(card) <= MAX_GLANCE_CHARS;

/** Roster entries the card does not draw in full keep only what an orb and a
 * name need (the Members "Add" list loses its subtitles; esc() reads a missing
 * field as ""). */
const slimRoster = (bots: ReturnType<typeof toBot>[], whole: Set<string>) =>
  bots.map((b) => (whole.has(b.id) ? b : { id: b.id, name: b.name, color: b.color, shape: b.shape, status: b.status }));

// ── Card builders per tool ───────────────────────────────────────────────────

/** Where voice opens the roster card: one bot's chat, one group's chat, or the
 * new-group pane (bots picked, name, first send creates the group). */
export type ShowOpen = { bot: string } | { group: string } | { members: string[]; groupName?: string };

/** show.html — roster (+ groups), and the one conversation surface. `threads`
 * is a per-conversation recent-message map (id → CardItems, bots and groups) so
 * a chat pane opens populated; `nextBeforeSeqs` are their "Earlier messages"
 * cursors. `open` starts the card on a chat pane instead of the roster, with
 * `message` as that pane's draft. Histories are a nicety (the pane refreshes as
 * it opens), so they shrink, then drop — the opened conversation keeps the most,
 * and the roster itself always fits. */
export function showCard(
  agents: Agent[],
  me?: string,
  threads: Record<string, CardItem[]> = {},
  nextBeforeSeqs: Record<string, number | undefined> = {},
  open?: { open: ShowOpen; message?: string },
) {
  const bots = agents.filter((a) => !a.isGroup).map(toBot);
  const groups = agents.filter((a) => a.isGroup).map(toGroup);
  const args = open ? { open: open.open, ...(open.message ? { message: open.message } : {}) } : {};
  const focus = open ? ("bot" in open.open ? open.open.bot : "group" in open.open ? open.open.group : undefined) : undefined;
  const card = (ids: string[], perThread: number, focusThread = perThread) => {
    const baked = Object.fromEntries(ids.map((id) => [id, withTime(boundThread(threads[id], id === focus ? focusThread : perThread))]));
    const seqs = Object.fromEntries(ids.filter((id) => typeof nextBeforeSeqs[id] === "number").map((id) => [id, nextBeforeSeqs[id]]));
    return glance("show", { data: { bots, groups, me: me ?? "", threads: baked, nextBeforeSeqs: seqs }, args }, 320, "Grok Bot");
  };
  // The opened conversation first, then roster order: the first rows are the ones on screen.
  const ids = [...(focus && threads[focus]?.length ? [focus] : []),
    ...agents.map((a) => a.id).filter((id) => id !== focus && threads[id]?.length)];
  for (const focusThread of [48_000, 24_000, 12_000, 6_000])
    for (let perThread = 16_000; perThread >= 1_000; perThread /= 2) {
      const c = card(ids, perThread, Math.max(focusThread, perThread));
      if (fits(c)) return c;
    }
  for (let keep = ids.length >> 1; keep > 0; keep >>= 1) {
    const c = card(ids.slice(0, keep), 1_000, 4_000);
    if (fits(c)) return c;
  }
  const bare = card([], 0);
  if (fits(bare)) return bare;
  // The roster is the content here, so every bot stays — as a name and a status.
  const slim = glance("show", { data: { bots: slimRoster(bots, new Set()), groups: groups.map((g) => ({ ...g, last: "" })), me: me ?? "", threads: {}, nextBeforeSeqs: {} }, args }, 320, "Grok Bot");
  if (!fits(slim)) console.error(`show card is ${glanceChars(slim)} glance chars with a bare roster (cap ${MAX_GLANCE_CHARS}); VoiceOS will drop it`);
  return slim;
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

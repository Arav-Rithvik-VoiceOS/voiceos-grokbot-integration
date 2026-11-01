/**
 * UI layer: the notch cards.
 *
 * The widget HTML (widgets/*.html) is the user's design handoff, kept intact.
 * The roster card (show.html) is the ONE conversation surface: its chat pane
 * gets the live conversation (widgets/live-chat.js) and the send / new-group /
 * saved-state glue
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
  WIDGETS, MARK_DATA_URI, KEYCHAIN_POPUP_DATA_URI,
  LIVE_CHAT_JS, LIVE_CHAT_CSS, MARKDOWN_CSS, SHOW_ADAPTER, SHOW_CSS,
  SCREEN_PANE_JS, SCREEN_PANE_CSS,
} from "./assets.generated.ts";
import { toCardThread, boundThread, type CardItem } from "./conversation.ts";
import { renderMarkdown } from "./markdown.ts";
import { GROK_ALL_SHAPE_IDS, type GrokAnyShape, avatarCss } from "./avatarShapes.ts";

type CardName = "connect" | "show" | "create" | "guide" | "reconnect";

/** Swap the widgets' placeholder glyph (`.mark > i`) for the real logo, bare (no
 * tile), per the design handoff. Only the `.mark` glyph is targeted — but the
 * `.mark` element may carry its own attributes (e.g. an inline `style`), so
 * match the open tag with any attributes and replace just the inner
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

const STRIP_COMMENTS = new Set<CardName>(["show"]);

/** The widget HTML with the real mark + real {data, args} injected. `fills`
 * replaces extra `__VOICEOS_<KEY>__` tokens; `__VOICEOS_SHAPES__` (the avatar
 * CSS) fills itself from the card's bots unless a caller passes one.
 * Any token a widget declares but a call doesn't fill becomes the empty string. */
export function renderCard(
  name: CardName,
  payload: { data?: unknown; args?: unknown } = {},
  fills: Record<string, string> = {},
): string {
  const json = JSON.stringify({ data: payload.data ?? {}, args: payload.args ?? {} })
    .replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  // Function replacers so `$` in the data can't be read as a replacement pattern.
  // The show card carries the most bytes, so its
  // source comments are dropped at render time (before any data/viewer/asset
  // fill, so only the template is touched). None of these templates has "/*"
  // inside a string — tests/cards.test.ts guards that.
  const template = STRIP_COMMENTS.has(name) ? WIDGETS[name].replace(/\/\*[\s\S]*?\*\/\n?/g, "") : WIDGETS[name];
  if (template.includes("__VOICEOS_SHAPES__") && fills.SHAPES === undefined)
    fills = { ...fills, SHAPES: avatarCss(cardShapes(name, payload.data)) };
  let html = injectMark(template).replace(/__VOICEOS_([A-Z]+)__/g, (token, key: string) => key === "DEMO" ? token : fills[key] ?? "");
  html = html.replace("__VOICEOS_DEMO__", () => json);
  if (name === "show") {
    // show.html's top-level functions (openChat, invoke, CAN_INVOKE, D, …) are
    // script-global, so the glue in its own IIFE can wrap them without the
    // assets' helpers leaking into (or colliding with) the handoff's scope.
    // Anchor on <script>, not </style>: show.html has several style blocks.
    // After the data fill, so no asset text is ever read as a token.
    html = html.replace("</script>", () => `\n(()=>{\n${LIVE_CHAT_JS}\n${SCREEN_PANE_JS}\n${SHOW_ADAPTER}\n})();\n</script>`)
      .replace("<script>", () => `<style>${MARKDOWN_CSS}\n${LIVE_CHAT_CSS}\n${SHOW_CSS}\n${SCREEN_PANE_CSS}</style>\n<script>`);
  }
  return html;
}

/** Which avatar shapes a card draws (avatarShapes.ts has the art for all 25,
 * ~16KB). A card only carries the shapes its bots use, so every byte saved is
 * left for the show card's conversations; `blob` always comes along, since it
 * is every avatar's fallback. The guide also draws its own crew (guide.html's
 * CREW, SAMPLE and Juno), which uses only the 8 shapes in GROK_DEFAULT_SHAPE_IDS. */
function cardShapes(name: CardName, data: unknown): string[] {
  const bots = (data as { bots?: { shape?: unknown }[] } | undefined)?.bots;
  const used = Array.isArray(bots) ? bots.map((b) => String(b?.shape ?? "")) : [];
  return name === "guide" ? [...GROK_DEFAULT_SHAPE_IDS, ...used] : used;
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

// Shapes: Grok Bot can draw 25 (GROK_ALL_SHAPE_IDS, avatarShapes.ts) and our
// cards draw every one of them with the app's own outline. Three lists matter:
//  - GROK_PICKER_SHAPE_IDS: the 13 its avatar picker offers today (0.71 added
//    square, sparkle, clover, flower, heart, house and star; pebble and
//    squircle left the picker but stay valid). The rest arrive via templates.
//  - GROK_DEFAULT_SHAPE_IDS: the 8 the app still derives a default from, for a
//    bot that never picked a shape. The order is the hash's index space.
//  - GROK_SHAPE_IDS: what our create card offers and the manifest's create
//    schema advertises: the picker's 13. Keep the manifest's create card and
//    shape enum in step with this list.
export { GROK_ALL_SHAPE_IDS, type GrokAnyShape };
export const GROK_PICKER_SHAPE_IDS = [
  "blob", "cloud", "square", "sparkle", "clover", "heart", "flower", "teardrop", "tablet", "wedge", "house", "star", "hex",
] as const satisfies readonly GrokAnyShape[];
const GROK_DEFAULT_SHAPE_IDS = ["blob", "pebble", "squircle", "tablet", "wedge", "hex", "cloud", "teardrop"] as const satisfies readonly GrokAnyShape[];
export const GROK_SHAPE_IDS = GROK_PICKER_SHAPE_IDS;
export type GrokShape = (typeof GROK_SHAPE_IDS)[number];
type GrokDefaultShape = (typeof GROK_DEFAULT_SHAPE_IDS)[number];
const isGrokShape = (s: string): s is GrokAnyShape => (GROK_ALL_SHAPE_IDS as readonly string[]).includes(s);

// Grok stores avatarShape/avatarColor as null until the user picks one; its UI
// derives a stable default from the bot's id on every render (a fixed orb/orange
// here made an untouched or half-edited bot look wrong). These port Grok Bot's
// own derivation verbatim from its bundle (index.eager-platform): a 32-bit FNV-1a
// of the id, then `pv()` for shape and `fv() = B1[A3()]` for color. Keyed by the
// bot id so our default matches the app pixel for pixel.
const fnv1a32 = (s: string): number => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
};
// Grok's B1: the palette minus `black`, in the app's own order. The order IS the
// index space of the color hash, so it must stay exactly as the bundle lists it —
// this is deliberately not GROK_COLOR_IDS (a different order).
const DEFAULT_COLOR_ORDER: GrokColor[] = ["brown", "red", "orange", "yellow", "green", "cyan", "blue", "violet", "magenta", "gray"];
// pv(id): mix the FNV hash, index into the 8 default shapes. Grok Bot 0.71
// still does exactly this for an existing bot (its `BN`, over the old 8); only
// its new-bot dialog seeds a random id over the 13 picker shapes.
const defaultShapeId = (id: string): GrokDefaultShape => {
  let t = fnv1a32(id) | 0;
  t = Math.imul(t ^ (t >>> 16), 73244475);
  t = Math.imul(t ^ (t >>> 13), 3266489909);
  const h = (t ^ (t >>> 16)) >>> 0;
  return GROK_DEFAULT_SHAPE_IDS[h % GROK_DEFAULT_SHAPE_IDS.length];
};
// fv(id) = B1[A3(T3(id))]: reseed a mulberry32 step from the hash, take one draw.
const defaultColorId = (id: string): GrokColor => {
  const k = Math.imul(1, 2654435769); // Grok's S3 = M3 = 1
  const t3 = (fnv1a32(id) ^ k) >>> 0; // T3
  let seed = (t3 ^ k) >>> 0; // E3 reseed
  seed = (seed + 1831565813) | 0; // one P3 step
  let n = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  n = (n + Math.imul(n ^ (n >>> 7), 61 | n)) ^ n;
  const rnd = ((n ^ (n >>> 14)) >>> 0) / 4294967296;
  return DEFAULT_COLOR_ORDER[Math.floor(rnd * DEFAULT_COLOR_ORDER.length)];
};

const colorHex = (c: string | null | undefined, id: string): string => {
  const key = (c ?? "").toLowerCase();
  if (key.startsWith("#")) return c as string; // legacy design hex passthrough
  if (key in GROK_COLOR_HEX) return GROK_COLOR_HEX[key as GrokColor];
  return GROK_COLOR_HEX[defaultColorId(id)]; // null/unknown → Grok's id-derived default
};
const shapeKind = (s: string | null | undefined, id: string): GrokAnyShape => {
  const key = (s ?? "").toLowerCase();
  return isGrokShape(key) ? key : defaultShapeId(id); // null/""/unknown → Grok's id-derived default
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
// `square` is a real Grok shape now; `sq` stays the old design's squircle.
const LEGACY_SHAPE: Record<string, GrokAnyShape> = {
  circ: "blob", circle: "blob", round: "blob", dot: "blob",
  sq: "squircle", rounded: "squircle", rect: "squircle",
  hexagon: "hex", triangle: "wedge", drop: "teardrop", tear: "teardrop", pill: "tablet",
  home: "house", sparkles: "sparkle", twinkle: "sparkle", shamrock: "clover", diamond: "gem",
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
export function normalizeShapeId(input?: string): GrokAnyShape | undefined {
  const s = (input ?? "").trim().toLowerCase();
  if (!s) return undefined;
  return isGrokShape(s) ? s : LEGACY_SHAPE[s];
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
    color: colorHex(a.avatarColor, a.id),
    shape: shapeKind(a.avatarShape, a.id),
    status: statusOf(a),
    task: preview(a.lastMessagePreview),
    time: relTime(a.lastActivityAt),
  };
}

/** Bot pictures for a card, id → small data: URI (client.ts listAgents loads
 * and shrinks them into `avatarImage`). They ride in their own `data.avatars`
 * map, never in the bot entries: rosters are also copied into snapshots, saved
 * card state and confirmation contexts, which must stay small. Past the cap,
 * later bots keep their shape; `first` (the opened bot) is placed first. */
export const AVATARS_MAX_CHARS = 96_000;
const SAFE_PICTURE = /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+=*$/;
export function avatarMap(agents: Agent[], first?: string): Record<string, string> {
  const out: Record<string, string> = {};
  let used = 0;
  const ordered = first ? [...agents.filter((a) => a.id === first), ...agents.filter((a) => a.id !== first)] : agents;
  for (const a of ordered) {
    const img = a.avatarImage;
    if (a.isGroup || !img || !SAFE_PICTURE.test(img) || used + img.length > AVATARS_MAX_CHARS) continue;
    out[a.id] = img;
    used += img.length;
  }
  return out;
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

/** Where voice opens the roster card: one bot's chat (with `screen`, its live
 * screen pane on top), one group's chat, or the new-group pane (bots picked,
 * name, first send creates the group). */
// An existing group may carry pending edits (members, name) the card starts with;
// they save on the card's next send. `newSince` (epoch ms, from a reply
// notification's Open) draws a "New messages" line above the first bot message
// newer than it.
export type ShowOpen = { bot: string; screen?: boolean; newSince?: number } | { group: string; members?: string[]; groupName?: string; newSince?: number } | { members: string[]; groupName?: string };

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
  open?: { open: ShowOpen; message?: string; sent?: boolean },
) {
  const bots = agents.filter((a) => !a.isGroup).map(toBot);
  const groups = agents.filter((a) => a.isGroup).map(toGroup);
  const args = open ? { open: open.open, ...(open.message ? { message: open.message, ...(open.sent ? { sent: true } : {}) } : {}) } : {};
  const focus = open ? ("bot" in open.open ? open.open.bot : "group" in open.open ? open.open.group : undefined) : undefined;
  const avatars = avatarMap(agents, focus);
  const card = (ids: string[], perThread: number, focusThread = perThread) => {
    const baked = Object.fromEntries(ids.map((id) => [id, withTime(boundThread(threads[id], id === focus ? focusThread : perThread))]));
    const seqs = Object.fromEntries(ids.filter((id) => typeof nextBeforeSeqs[id] === "number").map((id) => [id, nextBeforeSeqs[id]]));
    return glance("show", { data: { bots, groups, me: me ?? "", threads: baked, nextBeforeSeqs: seqs, avatars }, args }, 320, "Grok Bot");
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
  // The roster is the content here, so every bot stays — as a name, a status and its shape (no pictures).
  const slim = glance("show", { data: { bots: slimRoster(bots, new Set()), groups: groups.map((g) => ({ ...g, last: "" })), me: me ?? "", threads: {}, nextBeforeSeqs: {} }, args }, 320, "Grok Bot");
  if (!fits(slim)) console.error(`show card is ${glanceChars(slim)} glance chars with a bare roster (cap ${MAX_GLANCE_CHARS}); VoiceOS will drop it`);
  return slim;
}

/** What the guide can check on this Mac. `undefined` = could not tell (the
 * card then shows the step as not done rather than guessing). */
export type SetupState = { app?: boolean; signedIn?: boolean; bots?: number; notifications?: boolean };

/** guide.html — the three-page "how do I use this" card: setup steps checked
 * against this Mac, the one Keychain popup this integration causes (a
 * mock-up, since we can't detect the real one), then things to say. `bots`
 * (up to 3) voice the examples with the user's own bot names; `page` opens
 * straight on the Keychain page (1) or the ideas page (2). */
export function guideCard(setup: SetupState, bots: Agent[] = [], page: 0 | 1 | 2 = 0) {
  const cast = bots.filter((a) => !a.isGroup).slice(0, 3).map((a) => {
    const b = toBot(a);
    const img = avatarMap([a])[a.id];
    return { name: b.name, color: b.color, shape: b.shape, ...(img ? { img } : {}) };
  });
  // Windows has no Keychain popup (DPAPI, see client.ts): the guide says so instead.
  const windows = process.platform === "win32";
  return glance("guide", { data: { setup, bots: cast, kcImg: windows ? "" : KEYCHAIN_POPUP_DATA_URI, windows }, args: { page } }, 410, "Grok Bot");
}

/** connect.html — first-run / needs-sign-in status. */
export function connectCard(account?: { name?: string; email?: string }) {
  return glance("connect", { data: { account: account ?? { name: "You" } }, args: {} }, 340, "Grok Bot");
}

/** reconnect.html — the cloud computer is asleep and no saved route can wake
 * it (VOS-1608). Two steps and one button; the button runs grokbot_reconnect. */
export function reconnectCard() {
  return glance("reconnect", { data: {}, args: {} }, 262, "Grok Bot");
}


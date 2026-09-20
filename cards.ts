/**
 * UI layer: the notch cards.
 *
 * Messaging HTML/CSS/JS in widgets/thread.html, sent.html, and sent-group.html
 * is copied byte-for-byte from the user's handoff. The separate messaging
 * adapter supplies live data, host tool calls, and frame bounds at render time.
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
// network; the 64px PNG keeps two marks under the 96k glance cap.
import { WIDGETS, MESSAGING_ADAPTER, CONFIRMATION_ADAPTER, MESSAGING_CSS, MARK_DATA_URI, RFB_B64 } from "./assets.generated.ts";

type CardName = "connect" | "show" | "sent-group" | "sent" | "create" | "thread" | "screen";

/** Swap the widgets' placeholder glyph (`.mark > i`) for the real logo, bare (no
 * tile), per the design handoff. Only the `.mark` glyph is targeted — but the
 * `.mark` element may carry its own attributes (e.g. screen.html's inline
 * `style`), so match the open tag with any attributes and replace just the inner
 * `<i></i>` placeholder, keeping the element (and its attributes) intact. A plain
 * `class="mark"><i></i>` string match missed those and left the empty glyph. */
export function injectMark(html: string): string {
  const img = `<img class="voiceos-mk" style="width:16px;height:16px;border-radius:5px;object-fit:contain;display:inline-block;vertical-align:middle" src="${MARK_DATA_URI}" alt="Grok Bot">`;
  return html.replace(/(class="mark"[^>]*>)<i><\/i>/g, (_, open: string) => open + img);
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
  // The live screen card sits near the 96k glance cap, so its source comments are
  // dropped at render time (before any data/viewer fill, so only our own template
  // is touched). screen.html has no "/*" inside a string — check-screen guards that.
  const template = name === "screen" ? WIDGETS[name].replace(/\/\*[\s\S]*?\*\/\n?/g, "") : WIDGETS[name];
  let html = injectMark(template).replace(/__VOICEOS_([A-Z]+)__/g, (token, key: string) => key === "DEMO" ? token : fills[key] ?? "");
  if (["thread", "sent", "sent-group"].includes(name)) {
    html = html.replace(/^const DEMO=.*;$/m, () => `const DEMO=${json};`);
    // One lexical scope per document, including after the in-place sent transition.
    // Original source files stay intact; the adapter overrides only live wiring.
    html = html.replace("<script>", "<script>\n(()=>{\n")
      .replace("</script>", () => `\n${(payload.data as { confirmation?: boolean })?.confirmation ? CONFIRMATION_ADAPTER : MESSAGING_ADAPTER}\n})();\n</script>`);
    html = html.replace("<script>", () => `<style>${MESSAGING_CSS}</style>\n<script>`);
  } else html = html.replace("__VOICEOS_DEMO__", () => json);
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
  if (a.isRunningTurn || a.isRunning) return "working";
  return "idle";
}

function relTime(ms?: number): string {
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

/** Minimal, safe markdown → the card's inline HTML (bold + line breaks). */
function mdToHtml(s: string): string {
  const esc = s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return esc.replace(/\*\*([^*]+?)\*\*/g, "<b>$1</b>").replace(/\n/g, "<br>");
}

/**
 * transcript entries → the card's `thread` shape.
 * "me" is the human: a `kind:"message"` turn with role "user" and NO fromAgent.
 * The bot's own outgoing turns are `kind:"send-message"` ({type,content}); a
 * `role:"assistant"` or an agent-authored `role:"user"` (fromAgent set) is bot /
 * inter-agent chatter — all shown on the bot side.
 */
export function toThread(entries: TranscriptEntry[]) {
  const out: Array<Record<string, unknown>> = [];
  for (const e of entries) {
    let text = "";
    let from: "me" | "bot" = "bot";
    if (e.kind === "send-message") {
      const m = e.message;
      text = typeof m === "string" ? m : String((m as Record<string, unknown> | null)?.content ?? "");
    } else if (e.kind === "message") {
      text = String(e.content ?? "");
      from = String(e.role ?? "").toLowerCase() === "user" && !e.fromAgent ? "me" : "bot";
    } else {
      continue;
    }
    text = text.trim();
    if (!text) continue;
    // Which bot sent it: group + inter-agent messages carry `author` (on a
    // send-message) or `fromAgent` (on a message). Drives the sender orb + name.
    const sender = from === "bot" ? (e.author?.id ?? e.fromAgent?.id) : undefined;
    out.push({ from, ...(sender ? { bot: sender } : {}), html: mdToHtml(text), t: e.timestampMs ? relTime(e.timestampMs) : undefined });
  }
  return out;
}

// ── Card builders per tool ───────────────────────────────────────────────────

/** show.html — roster (+ groups). `threads` is an optional per-bot recent-message
 * map (botId → toThread output) so the in-card chat pane opens populated instead
 * of empty; omit it and the pane opens with just the composer. */
export function showCard(
  agents: Agent[],
  me?: string,
  threads?: Record<string, ReturnType<typeof toThread>>,
) {
  const bots = agents.filter((a) => !a.isGroup).map(toBot);
  const groups = agents.filter((a) => a.isGroup).map(toGroup);
  return glance("show", { data: { bots, groups, me: me ?? "", threads: threads ?? {} }, args: {} }, 320, "Grok Bot");
}

/** thread.html 1:1 mode — one bot + its recent messages (`args.bot`). Pass
 * `agents` (the roster) so a message from ANOTHER bot resolves that bot's orb +
 * name for the "Message from …" line; without it, only the thread bot is known. */
export function threadCard(bot: Agent, entries: TranscriptEntry[], message = "", agents?: Agent[]) {
  const bots = agents ? agents.filter((a) => !a.isGroup).map(toBot) : [toBot(bot)];
  if (!bots.some((b) => b.id === bot.id)) bots.unshift(toBot(bot));
  return glance(
    "thread",
    { data: { bots, thread: toThread(entries), me: "" }, args: { bot: bot.id, message } },
    360,
    "Grok Bot",
  );
}

/**
 * thread.html new-group mode — build a group (pick members from the live roster
 * in the Members view, name it), then send. `data.bots` is the full roster the
 * Members view adds from; `args.members` are the preselected bot ids; nothing is
 * created until the card's composer invokes grokbot_group with a message.
 */
export function groupComposeCard(agents: Agent[], memberIds: string[], name?: string, message = "") {
  const roster = agents.filter((a) => !a.isGroup).map(toBot);
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
) {
  const roster = agents.filter((a) => !a.isGroup).map(toBot);
  return glance(
    "thread",
    {
      data: {
        bots: roster,
        groups: [{ id: group.id, name: group.name, members: group.members, time: relTime(Date.now()), thread: toThread(entries) }],
        me: "",
      },
      args: { group: group.id, groupName: group.name, members: group.members, message },
    },
    380,
    "Grok Bot",
  );
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
 * A click on the screen invokes `grokbot_open_screen`, which opens the bot's
 * Computer tab in the Grok Bot app. Each bot has its own cloud computer, so every
 * bot's "screen" is its own persistent desktop. With no stream the card shows
 * its idle state and ships without the viewer bundle.
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

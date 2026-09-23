/**
 * Live-chat preview harness. No VoiceOS, no network, no Grok Bot.
 *
 *   node scripts/inline-assets.mjs && bun scripts/preview-live.ts [outDir]
 *
 * Renders the REAL cards (cards.ts builders → the same glance HTML VoiceOS gets)
 * into one static host page per scenario, plus index.html (default outDir: the
 * folder next to this checkout, `../preview`). Each page is a mock VoiceOS host:
 * it sends voiceos:init, sizes the frame from voiceos:resize (clamped 60–420 like
 * the notch), and answers voiceos:invokeTool from in-page mock handlers for every
 * card tool — with the host's own gates (uiCallable, 64 requests per card, args
 * and result caps) so a card that would break in VoiceOS breaks here too. Every
 * call is logged on the page.
 *
 * The card HTML gets two preview-only additions: the card CSP meta, and a tiny
 * shim that forwards card errors to the log, can speed up the card's timers (to
 * reach the 30-refresh cap in seconds), can force document.visibilityState (to
 * test pause/resume), and lets the host page click/inspect inside the sandbox
 * (`card.click(sel)`, `card.inspect(sel)` in the console).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { join, resolve } from "node:path";
import type { Agent, TranscriptEntry } from "../client.ts";

const ROOT = resolve(import.meta.dir, "..");
const OUT = resolve(process.argv[2] ?? join(ROOT, "..", "preview"));

// cards.ts imports assets.generated.ts; if inline-assets has not been rerun since
// the live-chat assets landed, the import fails on a missing export. Say so.
let cards: typeof import("../cards.ts");
let conv: typeof import("../conversation.ts");
let md: typeof import("../markdown.ts");
try {
  [cards, conv, md] = await Promise.all([import("../cards.ts"), import("../conversation.ts"), import("../markdown.ts")]);
} catch (error) {
  console.error(`preview-live: cards.ts did not load — ${error instanceof Error ? error.message : String(error)}
Run \`node scripts/inline-assets.mjs\` first (assets.generated.ts must export LIVE_CHAT_JS, LIVE_CHAT_CSS,
MARKDOWN_CSS, COMPOSER_KIT_JS, COMPOSER_KIT_CSS and SHOW_ADAPTER).`);
  process.exit(1);
}

// ── Fixtures ────────────────────────────────────────────────────────────────
const NOW = Date.now(), MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const agents: Agent[] = [
  { id: "pepper", name: "Pepper", title: "EA", avatarColor: "orange", isRunning: true, lastMessagePreview: "Drafting the Q3 board deck", lastActivityAt: NOW - 2 * MIN },
  { id: "friday", name: "Friday", title: "School", avatarColor: "green", avatarShape: "hex", isComposingMessage: true, lastMessagePreview: "Checking what submitted last night", lastActivityAt: NOW - 9 * MIN },
  { id: "jerome", name: "Jerome", title: "BISV Hacks", avatarColor: "red", avatarShape: "wedge", lastActivityAt: NOW - 3 * DAY },
  { id: "titus", name: "Titus", title: "Research", avatarColor: "blue", avatarShape: "tablet", awaitingUserResponse: true, lastMessagePreview: "Needs an API key", lastActivityAt: NOW - 40 * MIN },
  { id: "g1", name: "Homework crew", isGroup: true, memberIds: ["pepper", "friday", "titus"], lastMessagePreview: "CSA 1.7 is next.", lastActivityAt: NOW - 20 * MIN },
];
const byId = (id: string) => agents.find((a) => a.id === id)!;
const pepper = byId("pepper"), group = { id: "g1", name: "Homework crew", members: ["pepper", "friday", "titus"] };

const me = (id: string, content: string, ago: number): TranscriptEntry =>
  ({ id, kind: "message", role: "user", content, timestampMs: NOW - ago });
const says = (id: string, message: Record<string, unknown>, ago: number, author?: string): TranscriptEntry =>
  ({ id, kind: "send-message", message, timestampMs: NOW - ago, ...(author ? { author: { id: author, name: byId(author).name } } : {}) });
const text = (content: string) => ({ type: "text", content });
const FILES = "file:///home/box/agent-data/agents";

const RICH = [
  "## Q3 summary",
  "",
  "Revenue grew **12%** over Q2. The main drivers:",
  "",
  "- Enterprise renewals closed *early*",
  "- The self-serve plan",
  "  - launched in July",
  "  - 1,240 new teams",
  "",
  "1. Pull the numbers",
  "2. Explain the variance",
  "",
  "| Region | Q2 (USD) | Q3 (USD) | Change |",
  "|:--|--:|--:|--:|",
  "| North America | 1.20M | 1.40M | +16.7% |",
  "| Europe | 0.80M | 0.85M | +6.3% |",
  "| Asia Pacific | 0.30M | 0.33M | +10.0% |",
  "",
  "Variance is $\\Delta = \\frac{Q_3 - Q_2}{Q_2}$, and the compound rate over $n$ quarters is:",
  "",
  "$$",
  "r = \\left(\\frac{V_f}{V_i}\\right)^{1/n} - 1",
  "$$",
  "",
  "> APAC numbers are preliminary until the audit closes.",
  "",
  "```python",
  "def variance(q2: float, q3: float) -> float:",
  '    """Quarter-over-quarter change."""',
  "    return (q3 - q2) / q2  # 0.12 means 12%",
  "```",
  "",
  "Inline `code`, a [link to the report](https://example.com/q3), and ~~the old estimate~~.",
  "",
  "---",
  "",
  "- [x] Numbers pulled",
  "- [ ] Board deck",
].join("\n");

// ~40k chars of markdown: its CardItem serialization (text + html) needs several
// 24 000-char chunks, and it is always deferred by boundThread.
const HUGE = "## Appendix: full research notes\n\n" +
  Array.from({ length: 230 }, (_, i) =>
    `**Note ${i + 1}.** Interview ${i + 1} confirms the renewal pattern: teams that onboard in week one renew at a higher rate, and support tickets fall after the second month.`,
  ).join("\n\n") + "\n\n```ts\nexport const complete = true;\n```\n\nEND OF COMPLETE MESSAGE";

const pepperEntries: TranscriptEntry[] = [
  me("p-ask", "Can you pull together the Q3 numbers and explain the variance?", 3 * DAY),
  says("p-rich", text(RICH), 3 * DAY - 5 * MIN),
  me("p-more", "Great. Send me the chart and the full report too.", 2 * DAY),
  says("p-image", { ...text("Here is the revenue chart."), images: [{ url: `${FILES}/pepper/attachments/revenue-chart.png`, alt: "Revenue chart" }] }, 2 * DAY - 3 * MIN),
  says("p-file", { type: "attachment", url: "/home/box/agent-data/agents/pepper/attachments/Q3-report.pdf", file_name: "Q3 report.pdf" }, 2 * DAY - 2 * MIN),
  { id: "p-upload", kind: "user-attachment", file_path: "/Users/me/Desktop/board-notes.txt", file_name: "board-notes.txt", timestampMs: NOW - 26 * HOUR },
  { id: "p-messaged", kind: "message", content: "Can you double-check the APAC numbers?", toAgent: { id: "titus", name: "Titus" }, timestampMs: NOW - 25 * HOUR },
  { id: "p-notice", kind: "notice", text: "Pepper restarted its computer.", timestampMs: NOW - 24 * HOUR },
  { id: "p-huge", kind: "message", role: "assistant", content: HUGE, timestampMs: NOW - 20 * HOUR },
  says("p-approved", { type: "auto-review-approval", approval: { status: "approved", summary: "Email the Q3 report to finance@example.com", command: "gmail send --to finance@example.com --attach Q3-report.pdf" } }, 19 * HOUR),
  says("p-expired", { type: "auto-review-approval", approval: { status: "expired", summary: "Approve PR 182 on voiceos-dictation", reason: "Review requested", command: "gh pr review 182 --approve" } }, 18 * HOUR),
  says("p-mockups", { ...text("Two deck mockups. The second file is gone from the server, so it must fall back to Open in Grok Bot."), images: [{ url: `${FILES}/pepper/attachments/mockup-a.png`, alt: "Mockup A" }, { url: `${FILES}/pepper/attachments/mockup-b.png`, alt: "Mockup B (broken)" }] }, 3 * HOUR),
  says("p-connector", { type: "connector", connector: "Google Drive" }, 2 * HOUR),
  says("p-credential", { type: "credential-request", credentialRequest: { label: "Sign in to Gmail", description: "Pepper needs to sign in to send the board deck." } }, 50 * MIN),
  says("p-choice", { type: "widget", widget: { prompt: "Ship this deck, or tweak it further?", options: [{ label: "Ship it", value: "Ship deck v3", description: "Send it to the board today" }, { label: "Tweak more", value: "Tweak the deck further" }] } }, 12 * MIN),
  says("p-multi", { type: "widget", widget: { prompt: "Which sections go in the board deck?", multiSelect: true, allowCustom: true, options: [{ label: "Revenue", value: "revenue" }, { label: "Churn", value: "churn" }, { label: "Hiring", value: "hiring" }, { label: "Roadmap", value: "roadmap", description: "Next two quarters" }] } }, 4 * MIN),
];

const groupEntries: TranscriptEntry[] = [
  me("g-ask", "All of you: CSA first, then Zinn. Titus, find sources.", 5 * HOUR),
  says("g-pepper", text("On it. **CSA 1.7** is next, then Zinn chapter 4."), 5 * HOUR - 2 * MIN, "pepper"),
  says("g-friday", text("Plan:\n\n| Task | Due |\n|---|---|\n| CSA 1.7 | Tonight |\n| Zinn Ch 4 | Friday |\n\n```js\nconst left = tasks.filter(t => !t.done);\n```"), 5 * HOUR - 4 * MIN, "friday"),
  { id: "g-messaged", kind: "message", content: "Send me your Zinn notes.", author: { id: "friday", name: "Friday" }, toAgent: { id: "titus", name: "Titus" }, timestampMs: NOW - 4 * HOUR },
  { id: "g-notice", kind: "notice", text: "Titus joined the group.", timestampMs: NOW - 4 * HOUR + MIN },
  says("g-image", { ...text("Source map for chapter 4."), images: [{ url: `${FILES}/titus/attachments/source-chart.png`, alt: "Source chart" }] }, 3 * HOUR, "titus"),
  says("g-choice", { type: "widget", widget: { prompt: "Which edition should I cite?", options: [{ label: "2003 edition", value: "2003" }, { label: "2015 edition", value: "2015", description: "Newer page numbers" }] } }, 20 * MIN, "titus"),
];

const fridayEntries: TranscriptEntry[] = [
  me("f-ask", "Did last night's homework submit?", 40 * MIN),
  says("f-reply", text("Checking now. So far:\n\n- CSA 1.5: **submitted**\n- CSA 1.6: *not found*"), 38 * MIN),
];
const titusEntries: TranscriptEntry[] = [
  me("t-ask", "Make the figures for the grant report.", 2 * HOUR),
  says("t-secret", { type: "secret-request", secretRequest: { label: "OpenAI API key", description: "Needed to generate the figures." } }, 40 * MIN),
];

const OLDER = [
  ["Book the dentist for next Tuesday.", "Booked **Tuesday 4:30 PM** with Dr. Lee.", "Also remind me about SAT registration.", "Reminder set for *Friday 9 AM*."],
  ["What is on my calendar Thursday?", "Robotics at 3, then the `CSA` study group at 6.", "Move the study group to 7.", "Done. Everyone got the new time."],
  ["Start tracking my reading list.", "Started a list with 3 books:\n\n1. *Dune*\n2. *Zinn*\n3. *Gödel, Escher, Bach*", "Add The Martian.", "Added. That is 4 books."],
];
const olderPages = (target: string, members?: string[]) =>
  OLDER.map((page, p) => page.map((line, i) => {
    const id = `${target}-old${p + 1}-${i + 1}`, ago = (7 + p * 7) * DAY + (4 - i) * HOUR;
    return i % 2 === 0 ? me(id, line, ago) : says(id, text(line), ago, members?.[(p + i) % members.length]);
  }));

// Server-side shapes, exactly as conversationSnapshot/conversationEntry build them.
function target(id: string, entries: TranscriptEntry[], older: TranscriptEntry[][] = []) {
  const a = byId(id), items = conv.toCardThread(entries);
  const pages = older.map((page) => conv.boundThread(conv.toCardThread(page)));
  const full: Record<string, [string, string, string, string]> = {};
  for (const item of [...items, ...pages.flat()]) {
    const s = conv.serializeThreadItem(item);
    // "Edited while loading" variant: a different version, so the chunk reader restarts.
    const e = conv.serializeThreadItem({ ...item, text: `${item.text ?? ""}\n\n(edited while loading)`, html: `${item.html ?? ""}<p><em>(edited while loading)</em></p>` });
    full[item.id] = [s, conv.threadItemVersion(s), e, conv.threadItemVersion(e)];
  }
  return { id, name: a.name, group: !!a.isGroup, members: a.memberIds ?? [], base: conv.boundThread(items), live: [], older: pages, full };
}
const targets = {
  pepper: target("pepper", pepperEntries, olderPages("pepper")),
  g1: target("g1", groupEntries, olderPages("g1", group.members)),
  friday: target("friday", fridayEntries),
  jerome: target("jerome", []),
  titus: target("titus", titusEntries),
};
const liveTemplates = [
  "Live update **#LIVEN**: still working through the deck.",
  "Update LIVEN: checked `inbox`, found *2* new emails.",
  "Status LIVEN:\n\n| Step | State |\n|---|---|\n| Draft | Done |\n| Review | Waiting |",
  "Check-in LIVEN:\n\n- slides 1 to 6 done\n- charts next",
].map((t) => ({ text: t, html: md.renderMarkdown(t) }));

// ── Tiny valid PNGs (the card only accepts data:image/(png|jpeg|webp|gif);base64) ──
const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf: Buffer) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function png(w: number, h: number, px: (x: number, y: number) => [number, number, number]): string {
  const stride = w * 3 + 1, raw = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set(px(x, y), y * stride + 1 + x * 3);
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]), len = Buffer.alloc(4), crc = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 2, 0, 0, 0], 8); // 8-bit RGB, no interlace
  const bytes = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
  return `data:image/png;base64,${bytes.toString("base64")}`;
}
const BARS = [52, 74, 92, 118];
const images = {
  chart: png(240, 150, (x, y) => {
    const bar = Math.floor((x - 24) / 52), inBar = x >= 24 && (x - 24) % 52 < 34 && bar < 4;
    if (y === 136 && x >= 16 && x < 228) return [120, 120, 128];
    if (inBar && y < 136 && y >= 136 - BARS[bar]) return [255, 103, 0];
    return y % 34 === 0 ? [40, 40, 46] : [28, 28, 32];
  }),
  mockup: png(240, 150, (x, y) => {
    if (y < 28) return [16, 132, 254];
    if (y > 44 && y < 58 && x > 16 && x < 150) return [200, 200, 208];
    if (y > 70 && y < 130 && x > 16 && x < 110) return [255, 103, 0];
    if (y > 70 && y < 130 && x > 124 && x < 224) return [0, 201, 114];
    return [244, 244, 246];
  }),
  swatch: png(32, 32, () => [145, 89, 254]),
};

// ── Cards (real builders) ───────────────────────────────────────────────────
type Card = { _voiceos_glance: { blocks: { html: string }[] } };
const CSP = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:;">`;
// Preview-only: error bridge, opt-in timer speed-up, click/inspect for the host page.
const SHIM = `<script>(()=>{let k=1;const T=setTimeout.bind(window),I=setInterval.bind(window);
window.setTimeout=(f,ms,...a)=>T(f,(+ms||0)>=1000?ms/k:ms,...a);window.setInterval=(f,ms,...a)=>I(f,(+ms||0)>=1000?ms/k:ms,...a);
const post=m=>parent.postMessage(m,'*');
let seen=null;const V=Object.getOwnPropertyDescriptor(Document.prototype,'visibilityState').get,vis=()=>seen||V.call(document);
Object.defineProperty(document,'visibilityState',{configurable:true,get:vis});Object.defineProperty(document,'hidden',{configurable:true,get:()=>vis()!=='visible'});
addEventListener('error',e=>post({type:'preview:error',message:String(e.message||e),where:e.lineno?'line '+e.lineno+':'+e.colno:''}));
addEventListener('unhandledrejection',e=>post({type:'preview:error',message:'Unhandled rejection: '+String(e.reason&&e.reason.message||e.reason)}));
addEventListener('message',e=>{const m=e.data;if(e.source!==parent||!m)return;
if(m.type==='preview:speed')k=Math.max(1,+m.factor||1);
else if(m.type==='preview:visibility'){const was=vis();seen=m.state==='real'?null:m.state;if(vis()!==was)document.dispatchEvent(new Event('visibilitychange'))}
else if(m.type==='preview:click'){const el=document.querySelector(m.selector);if(el)el.click();post({type:'preview:clicked',selector:m.selector,found:!!el})}
else if(m.type==='preview:inspect'){const els=[...document.querySelectorAll(m.selector)];post({type:'preview:inspect',selector:m.selector,count:els.length,values:els.map(el=>'value' in el?String(el.value):null),text:els.map(el=>el.innerText).join('\\n---\\n').slice(0,m.max||20000),html:els.map(el=>el.outerHTML).join('\\n').slice(0,m.max||20000)})}});})();</script>`;
function instrument(html: string): string {
  const anchor = '<meta charset="utf-8" />', i = html.indexOf(anchor);
  return i < 0 ? CSP + SHIM + html : html.slice(0, i + anchor.length) + CSP + SHIM + html.slice(i + anchor.length);
}
const demoArgs = (html: string) => {
  const m = html.match(/^const DEMO=(.*);$/m);
  try { return m ? JSON.parse(m[1]).args ?? {} : {}; } catch { return {}; }
};
const htmlOf = (card: Card) => card._voiceos_glance.blocks[0].html;

// Cursors: 300 → the first older page. The show card bakes 6-entry tails (like
// grokbot_show), so its cursor 350 points at the rest of the newest page.
const OLDER_CURSOR = 300, SHOW_CURSOR = 350, SHOW_TAIL = 6;
const thread1to1 = cards.threadCard(pepper, pepperEntries, "", agents, OLDER_CURSOR) as Card;
const thread1to1Draft = cards.threadCard(pepper, pepperEntries, "Keep this draft while the chat refreshes", agents, OLDER_CURSOR) as Card;
const threadGroup = cards.groupThreadCard(agents, group, groupEntries, "", OLDER_CURSOR) as Card;
const showEntries: Record<string, TranscriptEntry[]> = { pepper: pepperEntries, friday: fridayEntries, jerome: [], titus: titusEntries, g1: groupEntries };
const show = cards.showCard(
  agents, "",
  Object.fromEntries(Object.entries(showEntries).map(([id, e]) => [id, conv.toCardThread(e.slice(-SHOW_TAIL))])),
  Object.fromEntries(Object.entries(showEntries).filter(([, e]) => e.length > SHOW_TAIL).map(([id]) => [id, SHOW_CURSOR])),
) as Card;
// Confirmation: the thread grokbot_prepare_message hands a grokbot_send confirmation.
const confirmThread = cards.confirmationRows(cards.toThread(pepperEntries.filter((e) => ["p-ask", "p-rich", "p-more", "p-image", "p-file", "p-messaged"].includes(e.id!)), 12_000));
const confirmHtml = cards.renderCard("thread", {
  data: { confirmation: true, tool: "grokbot_send", bots: agents.filter((a) => !a.isGroup).map(cards.toBot), groups: agents.filter((a) => a.isGroup).map(cards.toGroup), threads: { pepper: confirmThread }, me: "" },
});

type Scenario = {
  slug: string; title: string; blurb: string; hint: string; html: string; glance?: number;
  theme: "dark" | "light"; invoke: boolean; initArgs: Record<string, unknown>; confirmation?: boolean;
};
const scenarios: Scenario[] = [
  { slug: "thread-1to1-dark", title: "1:1 thread · dark", theme: "dark", invoke: true, html: htmlOf(thread1to1), glance: cards.glanceChars(thread1to1), initArgs: demoArgs(htmlOf(thread1to1)),
    blurb: "Pepper's conversation with every message type: formatted text, images, files, requests, choices, a Messaged row, a notice and a deferred huge message.",
    hint: "Scroll up to load the huge note and the images. Try Earlier messages at the top, answer the choices, open the + menu (Attach files, Teach a task) and the Open computer button. A new message arrives every 15 s; use Timer speed to hit the 30-refresh cap fast." },
  { slug: "thread-1to1-light", title: "1:1 thread · light", theme: "light", invoke: true, html: htmlOf(thread1to1Draft), glance: cards.glanceChars(thread1to1Draft), initArgs: demoArgs(htmlOf(thread1to1Draft)),
    blurb: "The same conversation in the light theme, with a draft already in the composer.",
    hint: "Watch the draft while the chat refreshes: it must stay exactly as typed. Check tables, code colors and math in the light theme." },
  { slug: "thread-group", title: "Existing group thread", theme: "dark", invoke: true, html: htmlOf(threadGroup), glance: cards.glanceChars(threadGroup), initArgs: demoArgs(htmlOf(threadGroup)),
    blurb: "The Homework crew group: sender names on bot messages, a table, code, an image, a Messaged row and a pending choice.",
    hint: "Groups get live refresh and older messages, but NO + menu and NO Open computer button." },
  { slug: "show-roster", title: "Roster → chat pane", theme: "dark", invoke: true, html: htmlOf(show), glance: cards.glanceChars(show), initArgs: demoArgs(htmlOf(show)),
    blurb: "The show card. Pepper has a baked thread; Friday, Jerome and Titus load theirs from the first refresh when you open them.",
    hint: "Click a bot inside the card to open its chat pane (it refreshes once at once). Type a draft, go Back, open another bot, come back: the draft must return. Back must stop the timers. show.html reads init data as-is: a CARD ERROR on the {} init means the roster would be blank in VoiceOS (set Init data to omitted to keep testing)." },
  { slug: "confirmation-send", title: "Send confirmation", theme: "dark", invoke: true, confirmation: true, html: confirmHtml, initArgs: { bot: "Pepper", message: "Reply pong." },
    blurb: "The grokbot_send confirmation card (host-approved draft). It only gains markdown styling: no live refresh, no + menu, no tool calls.",
    hint: "Edits show as updateInput lines. Approve only logs what VoiceOS would run. Any invokeTool here is a bug." },
  { slug: "no-invoke", title: "Host without invokeTool", theme: "dark", invoke: false, html: htmlOf(thread1to1), glance: cards.glanceChars(thread1to1), initArgs: demoArgs(htmlOf(thread1to1)),
    blurb: "The 1:1 thread on a host whose capabilities.invokeTool is false.",
    hint: "The card must not call any tool: no refresh, no image loads. Sending shows its unavailable message. Every invokeTool line here is a bug." },
];

// ── Host page ───────────────────────────────────────────────────────────────
const manifest = JSON.parse(readFileSync(join(ROOT, "voiceos.integration.json"), "utf8"));
const uiCallable: string[] = manifest.tools.filter((t: { uiCallable?: boolean }) => t.uiCallable).map((t: { name: string }) => t.name);
const escHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const jsonForScript = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c");

function warningsFor(s: Scenario): string[] {
  const w: string[] = [];
  if (!s.confirmation && !s.html.includes("LiveChat")) w.push("live-chat.js is not in this card yet (rerun inline-assets, or cards.ts does not inject it): refresh, older messages, media, requests and deferred loading will not run.");
  if (!s.confirmation && s.slug !== "thread-group" && !s.html.includes("ComposerKit")) w.push("composer-kit.js is not in this card yet: no Attach files / Teach a task menu.");
  if (s.confirmation && /LiveChat|ComposerKit/.test(s.html)) w.push("The confirmation card carries live-chat/composer code. SPEC: confirmation cards get only MARKDOWN_CSS.");
  if (s.glance !== undefined && s.glance > cards.MAX_GLANCE_CHARS) w.push(`Glance is ${s.glance.toLocaleString("en-US")} chars, over the ${cards.MAX_GLANCE_CHARS.toLocaleString("en-US")} cap: VoiceOS would drop this card.`);
  return w;
}

// The iframe keeps color-scheme:normal: the card declares none, and a scheme
// mismatch with this dark page makes the browser paint an opaque white canvas
// behind the card's transparent body.
const HOST_CSS = `
:root{color-scheme:dark;--bg:#1b1b1e;--panel:#232327;--line:#34343a;--ink:#ececf0;--ink2:#a9a9b2;--ink3:#76767e;--ok:#7bd88f;--warn:#f0c674;--bad:#ff6b6b;--call:#8fb8ff}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:13px/1.45 -apple-system,BlinkMacSystemFont,system-ui,sans-serif}
header{padding:20px 24px 4px}
header a{color:var(--call);text-decoration:none}
h1{font-size:18px;margin:6px 0 4px;font-weight:600}
header p{margin:0;color:var(--ink2);max-width:72ch}
.warn-box{margin:10px 24px 0;padding:10px 12px;border:1px solid #6b5520;background:#2d2616;color:var(--warn);border-radius:8px;max-width:900px}
main{display:grid;grid-template-columns:400px minmax(0,1fr);gap:28px;padding:16px 24px 32px;align-items:start}
@media (max-width:920px){main{grid-template-columns:minmax(0,1fr)}}
.notch{width:400px;max-width:100%;border-radius:26px;overflow:hidden;background:#0c0c0d;box-shadow:0 0 0 1px #2c2c30}
body[data-theme=light] .notch{background:#f4f4f6}
iframe{display:block;width:100%;height:360px;border:0;background:transparent;color-scheme:normal}
.meta{margin-top:8px;color:var(--ink3);font-variant-numeric:tabular-nums}
.hint{color:var(--ink2);margin:10px 0 0}
.controls{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:8px 18px;padding:12px 14px;border:1px solid var(--line);border-radius:10px;background:var(--panel)}
.controls h2{grid-column:1/-1;margin:6px 0 0;font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--ink3)}
.controls h2:first-child{margin-top:0}
.controls label{display:flex;align-items:center;gap:6px;color:var(--ink2)}
.controls select{background:#18181b;color:var(--ink);border:1px solid var(--line);border-radius:6px;padding:3px 6px;font:inherit}
.controls .btns{grid-column:1/-1;display:flex;gap:8px;flex-wrap:wrap}
button.h{background:#2f2f35;color:var(--ink);border:1px solid var(--line);border-radius:7px;padding:5px 12px;font:inherit;cursor:pointer}
button.h:hover{background:#393940}
button.h.primary{background:#24406e;border-color:#35598f}
.counts{margin:12px 0 6px;color:var(--ink2);font-variant-numeric:tabular-nums}
pre#log{margin:0;height:min(60vh,620px);overflow:auto;padding:10px 12px;background:#131315;border:1px solid var(--line);border-radius:10px;font:11.5px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;word-break:break-word}
.l.call{color:var(--call)}.l.ok{color:var(--ok)}.l.warn{color:var(--warn)}.l.bad{color:var(--bad);font-weight:600}.l.dim{color:var(--ink3)}
`;

// The mock VoiceOS host. Plain browser JS (no template literals inside).
const HOST_JS = String.raw`(() => {
'use strict';
const FX = JSON.parse(document.getElementById('fx').textContent);
const $ = s => document.querySelector(s);
const frame = $('#card'), logEl = $('#log'), countsEl = $('#counts'), metaEl = $('#meta');
const UI_CALLABLE = new Set(FX.uiCallable);
const CARD_REQUEST = new Set(['grokbot_card_snapshot', 'grokbot_card_entry', 'grokbot_card_image', 'grokbot_card_action', 'grokbot_card_files', 'grokbot_card_teach']);
const DELAY = { 'grokbot_card_teach:prepare': 1800 };
const clone = v => JSON.parse(JSON.stringify(v));
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
let t0 = performance.now(), gen = 0, loadedGen = 0, lastHeight = 0, S, edits = {};
const waiters = [];

const idle = () => ({ state: 'idle', agentId: null, startedAtMs: null, maxDurationMs: 600000 });
const fresh = () => ({ targets: clone(FX.targets), live: 0, mine: 0, requests: 0, refreshes: 0, byTool: {}, inFlight: new Set(), jobs: {}, files: {}, sends: {}, entryCalls: {}, picks: 0, teach: $('#otherRec').checked ? otherRecording() : idle() });
const otherRecording = () => ({ state: 'recording', agentId: 'jerome', startedAtMs: Date.now() - 60000, maxDurationMs: 600000 });

function log(kind, text, cls) {
  const line = document.createElement('span');
  line.className = 'l ' + (cls || '');
  line.textContent = ((performance.now() - t0) / 1000).toFixed(1).padStart(6) + 's  ' + kind + (text ? '  ' + text : '') + '\n';
  const pinned = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 24;
  logEl.appendChild(line);
  if (pinned) logEl.scrollTop = logEl.scrollHeight;
}
const short = v => JSON.stringify(v, (k, x) => typeof x === 'string' && x.length > 140 ? x.slice(0, 70) + '… <' + x.length + ' chars>' : x);
function summary(body) {
  if (!body || typeof body !== 'object') return short(body);
  const b = Object.assign({}, body);
  if (Array.isArray(b.thread)) { const ids = b.thread.map(i => i.id + (i.deferred ? '(deferred)' : '')); b.thread = ids.length + ' items: ' + (ids.length > 7 ? ids.slice(0, 3).join(', ') + ' … ' + ids.slice(-3).join(', ') : ids.join(', ')); }
  if (Array.isArray(b.bots)) b.bots = b.bots.map(x => x.id + ':' + x.status).join(' ');
  if (Array.isArray(b.groups)) b.groups = b.groups.map(x => x.id).join(' ');
  return short(b);
}
const cardVisibility = () => $('#visibility').value === 'real' ? document.visibilityState : $('#visibility').value;
function settings() {
  return { theme: $('#theme').value, invoke: $('#invoke').checked, twostep: $('#twostep').checked, initData: $('#initData').value, speed: +$('#speed').value, cap: +$('#cap').value };
}
function renderCounts() {
  const cap = settings().cap;
  countsEl.textContent = 'requests ' + S.requests + (cap ? ' / ' + cap : '') + '  ·  live refreshes ' + S.refreshes + ' / 30' +
    Object.keys(S.byTool).map(k => '  ·  ' + k.replace('grokbot_', '') + ' ' + S.byTool[k]).join('');
}
function renderMeta() {
  metaEl.textContent = 'frame ' + frame.offsetHeight + 'px' + (lastHeight ? ' (card asked ' + lastHeight + ')' : '') + (FX.glance ? '  ·  glance ' + FX.glance.toLocaleString('en-US') + ' / ${cards.MAX_GLANCE_CHARS.toLocaleString("en-US")} chars' : '') + '  ·  card html ' + FX.card.length.toLocaleString('en-US') + ' chars';
}

// ── Card lifecycle ──
function load() {
  gen++; S = fresh(); edits = {}; t0 = performance.now(); lastHeight = 0;
  const st = settings();
  document.body.dataset.theme = st.theme;
  frame.style.height = '360px';
  frame.srcdoc = FX.card;
  log('card', 'loading  theme ' + st.theme + ', invokeTool ' + st.invoke + (st.speed > 1 ? ', timers ×' + st.speed : ''), 'dim');
  renderCounts(); renderMeta();
}
frame.addEventListener('load', () => {
  if (loadedGen === gen) { log('load', 'the card replaced its own document (receipt swap). VoiceOS sends no new init.', 'dim'); return; }
  loadedGen = gen;
  const g = gen, st = settings(), w = frame.contentWindow;
  w.postMessage({ type: 'preview:speed', factor: st.speed }, '*');
  w.postMessage({ type: 'preview:visibility', state: $('#visibility').value }, '*');
  const init = caps => {
    if (g !== gen) return;
    const m = { type: 'voiceos:init', args: clone(FX.initArgs), theme: { mode: st.theme }, capabilities: { invokeTool: caps } };
    if (st.initData === 'empty') m.data = {};
    w.postMessage(m, '*');
    log('→ init', 'invokeTool ' + caps + ', data ' + (st.initData === 'empty' ? '{}' : 'omitted') + ', args ' + short(m.args), 'call');
  };
  // VoiceOS flips invokeTool to true on a SECOND init once its bridge is ready.
  if (st.twostep && st.invoke) { init(false); setTimeout(() => init(true), 400); } else init(st.invoke);
});

addEventListener('message', e => {
  if (e.source !== frame.contentWindow) return;
  const m = e.data || {};
  if (m.type === 'voiceos:resize') { lastHeight = Math.ceil(+m.height || 0); frame.style.height = Math.min(420, Math.max(60, lastHeight)) + 'px'; renderMeta(); return; }
  if (m.type === 'voiceos:updateInput') { edits[m.key] = m.value; log('updateInput', m.key + ' = ' + short(m.value), 'dim'); return; }
  if (m.type === 'voiceos:invokeTool') { invoke(m); return; }
  if (m.type === 'preview:error') { log('CARD ERROR', m.message + (m.where ? '  (' + m.where + ')' : ''), 'bad'); return; }
  if (m.type === 'preview:clicked' || m.type === 'preview:inspect') { const r = waiters.shift(); if (r) r(m); return; }
  log('card →', short(m), 'dim');
});

// ── Mock host bridge (VoiceOS WidgetToolBridge rules) ──
async function invoke(m) {
  const g = gen, w = frame.contentWindow, st = settings(), name = m.name, args = m.args;
  const reply = rest => { S.inFlight.delete(m.requestId); if (g === gen) w.postMessage(Object.assign({ type: 'voiceos:toolResult', requestId: m.requestId }, rest), '*'); };
  S.requests++; S.byTool[name] = (S.byTool[name] || 0) + 1;
  const refresh = name === 'grokbot_card_snapshot' && args && args.beforeSeq == null;
  if (refresh) S.refreshes++;
  renderCounts();
  log('→ ' + name, short(args), 'call');
  // SPEC checks: one call in flight per card, ≤30 live refreshes, none while hidden.
  if (S.inFlight.size) log('SPEC', (S.inFlight.size + 1) + ' calls in flight at once (the card bridge should send one at a time)', 'warn');
  S.inFlight.add(m.requestId);
  if (refresh && S.refreshes > 30) log('SPEC', 'live refresh ' + S.refreshes + ' is over the 30-per-card cap', 'bad');
  if (refresh && cardVisibility() !== 'visible') log('SPEC', 'live refresh while the card is hidden', 'bad');
  if (!/^[a-zA-Z0-9_-]+$/.test(String(m.requestId || ''))) log('HOST', 'invalid requestId ' + short(m.requestId) + ': VoiceOS rejects it', 'bad');
  if (!st.invoke) { log('HOST', 'invokeTool while capabilities.invokeTool is false: the card must not call tools', 'bad'); return reply({ status: 'failed', error: 'Tool actions are unavailable in this card.' }); }
  if (!UI_CALLABLE.has(name)) { log('HOST', name + ' is not uiCallable in voiceos.integration.json', 'bad'); return reply({ status: 'failed', error: 'Tool actions are unavailable in this card.' }); }
  if (!args || typeof args !== 'object' || Array.isArray(args)) { log('HOST', 'args must be an object', 'bad'); return reply({ status: 'failed', error: 'Tool arguments do not match this tool\u2019s input schema.' }); }
  if (JSON.stringify(args).length > 32768) { log('HOST', 'args over 32768 chars', 'bad'); return reply({ status: 'failed', error: 'Tool arguments are too large.' }); }
  if (st.cap && S.requests > st.cap) { log('HOST', 'request ' + S.requests + ' is over the ' + st.cap + '-per-card limit', 'bad'); return reply({ status: 'failed', error: 'This card has reached its request limit.' }); }
  const mode = $('#next').value;
  if (mode !== 'normal') { $('#next').value = 'normal'; log('mock', 'this call is forced to: ' + mode, 'warn'); }
  if (mode === 'silent') { log('← ' + name, 'no reply: the card must time out by itself (60 s)', 'warn'); setTimeout(() => S.inFlight.delete(m.requestId), 60000); return; }
  await sleep($('#slow').checked ? 3000 : (DELAY[name + ':' + (args.action || '')] || 300));
  if (mode === 'failed' || mode === 'unknown' || mode === 'cancelled') { log('← ' + name, 'status ' + mode, 'warn'); return reply({ status: mode, error: mode === 'unknown' ? 'The outcome is unknown.' : mode === 'cancelled' ? 'Cancelled.' : 'Simulated host failure.' }); }
  let body, isError = false;
  try {
    if (mode === 'okfalse') throw new Error('Simulated server error.');
    const h = HANDLERS[name];
    if (!h) throw new Error('The preview has no mock for ' + name + '.');
    body = h(args);
  } catch (err) {
    // cardRequest() turns a throw into an ok:false body; the other tools become MCP errors.
    if (CARD_REQUEST.has(name)) body = { ok: false, message: err.message }; else { isError = true; body = err.message; }
  }
  const result = { content: [{ type: 'text', text: typeof body === 'string' ? body : JSON.stringify(body) }] };
  if (isError) result.isError = true;
  const size = JSON.stringify(result).length;
  if (size > 131072) { log('HOST', name + ' result is ' + size + ' chars, over 131072: VoiceOS omits it', 'bad'); return reply({ status: 'completed', resultOmitted: true }); }
  log('← ' + name, isError ? 'isError: ' + body : summary(body), isError || body.ok === false || body.opened === false ? 'warn' : 'ok');
  reply({ status: 'completed', result });
}

// ── Mock integration server ──
const CYCLE = ['working', 'thinking', 'idle', 'waiting'];
function olderPage(t, before) {
  if (before === FX.showCursor && t.base.length > FX.showTail) return { thread: t.base.slice(0, -FX.showTail), next: t.older.length ? FX.olderCursor : undefined };
  const p = [300, 200, 100].indexOf(before);
  if (p < 0 || !t.older[p]) return { thread: [], next: undefined };
  return { thread: t.older[p], next: t.older[p + 1] ? [300, 200, 100][p + 1] : undefined };
}
const tgt = id => { const t = S.targets[id]; if (!t) throw new Error('This bot is no longer available.'); return t; };
const botNamed = ref => { const r = String(ref || '').trim().toLowerCase(); return FX.bots.find(b => b.id === ref) || FX.bots.find(b => b.name.toLowerCase() === r); };
function botsNow(focus) {
  return FX.bots.map(b => b.id === focus ? Object.assign({}, b, { status: CYCLE[S.live % CYCLE.length], task: 'Live update #' + S.live, time: 'now' }) : b);
}
function findItem(t, id) {
  for (const list of [t.base, t.live].concat(t.older)) { const it = list.find(i => i.id === id); if (it) return it; }
  return null;
}
function addLive(t) {
  const n = ++S.live, tpl = FX.liveTemplates[(n - 1) % FX.liveTemplates.length], item = { id: 'live-' + t.id + '-' + n, from: 'bot' };
  if (t.group) { item.bot = t.members[(n - 1) % t.members.length]; item.sender = botNamed(item.bot).name; }
  item.text = tpl.text.split('LIVEN').join(String(n));
  item.html = tpl.html.split('LIVEN').join(String(n));
  item.timestampMs = Date.now();
  t.live.push(item);
}
function mine(t, text, media) {
  const item = { id: 'me-' + t.id + '-' + (++S.mine), from: 'me' };
  if (text) { item.text = text; item.html = '<p>' + esc(text) + '</p>'; }
  item.timestampMs = Date.now();
  if (media && media.length) item.media = media;
  t.live.push(item);
}
function answerOf(w, values, custom) {
  const selected = Array.from(new Set(values)), extra = custom.trim();
  if (selected.some(v => !w.options.some(o => o.value === v))) throw new Error('That option is no longer available.');
  if (extra && !w.allowCustom) throw new Error('This question does not accept a custom answer.');
  if (!w.multiSelect && selected.length + Number(!!extra) > 1) throw new Error('Choose one answer.');
  const answer = w.options.filter(o => selected.includes(o.value)).map(o => o.value).concat(extra)
    .map(v => w.multiSelect ? v.replace(/\s*\n\s*/g, ' ').trim() : v).filter(Boolean).join('\n');
  if (!answer) throw new Error('Choose an answer first.');
  return answer;
}
const kindOf = n => /\.(png|jpe?g|gif|webp|heic)$/i.test(n) ? 'image' : /\.(mp4|mov|webm)$/i.test(n) ? 'video' : /\.(mp3|wav|m4a)$/i.test(n) ? 'audio' : 'file';
const PICKS = [[['board-deck-v3.key', 4812345], ['revenue.csv', 18204]], [['whiteboard.heic', 2345678], ['notes.md', 912]]];
function job(bot, kind, ms) { const j = { id: uid(), bot, kind, state: 'working', readyAt: Date.now() + ms }; S.jobs[j.id] = j; return j; }
function advance(j) {
  if (j.state !== 'working' || Date.now() < j.readyAt) return;
  if (j.kind === 'pick') {
    if ($('#pickCancel').checked) { j.state = 'cancelled'; return; }
    const pick = PICKS[S.picks++ % PICKS.length];
    if (Object.values(S.files).filter(f => f.bot === j.bot).length + pick.length > 20) { j.state = 'failed'; j.message = 'Attach up to 20 files at a time.'; return; }
    pick.forEach(p => { const id = uid(); S.files[id] = { id, bot: j.bot, name: p[0], size: p[1], locked: false }; });
    j.state = 'complete';
    return;
  }
  const files = j.files.map(id => S.files[id]).filter(Boolean), outcome = $('#filesOutcome').value;
  files.forEach(f => { f.locked = false; });
  if (outcome === 'failed') { j.state = 'failed'; j.message = 'The files could not be sent. Your draft and attachments are preserved.'; return; }
  if (outcome === 'unknown') { j.state = 'unknown'; j.message = 'Delivery is unconfirmed. Check the conversation before sending again.'; return; }
  files.forEach(f => { delete S.files[f.id]; });
  if (S.targets[j.bot]) mine(S.targets[j.bot], j.text, files.map((f, i) => ({ kind: kindOf(f.name), name: f.name, index: i })));
  j.state = 'complete';
}
function snap(bot, j) {
  const out = { ok: true, attachments: Object.values(S.files).filter(f => f.bot === bot).map(f => ({ id: f.id, name: f.name, size: f.size, sending: !!f.locked })) };
  if (j) out.job = { id: j.id, kind: j.kind, state: j.state, message: j.message };
  return out;
}

const HANDLERS = {
  grokbot_card_snapshot(a) {
    if (!a.bot) return { ok: true, bots: botsNow(), groups: FX.groups, thread: [] };
    const t = tgt(a.bot);
    if (a.beforeSeq != null) {
      const p = olderPage(t, a.beforeSeq), out = { ok: true, bots: botsNow(), groups: FX.groups, thread: clone(p.thread) };
      if (p.next != null) out.nextBeforeSeq = p.next;
      return out;
    }
    addLive(t);
    const out = { ok: true, bots: botsNow(t.group ? null : t.id), groups: FX.groups, thread: clone(t.base.concat(t.live)) };
    if (t.older.length) out.nextBeforeSeq = FX.olderCursor;
    return out;
  },
  grokbot_card_entry(a) {
    const t = tgt(a.bot), f = t.full[a.entryId];
    if (!f) throw new Error('This message is no longer available. Refresh the conversation.');
    const offset = a.offset == null ? 0 : a.offset;
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid message offset.');
    const k = S.entryCalls[a.entryId] = (S.entryCalls[a.entryId] || 0) + 1, mode = $('#entryMode').value;
    const edited = mode === 'always' ? k % 2 === 0 : mode === 'once' ? k > 1 : false;
    const s = edited ? f[2] : f[0], version = edited ? f[3] : f[1];
    // A message edited between chunks restarts at zero instead of mixing versions.
    const start = a.version === version ? offset : 0;
    if (start > s.length) throw new Error('Invalid message offset.');
    if (start !== offset) log('mock', a.entryId + ' changed while loading: restart at offset 0', 'warn');
    const chunk = s.slice(start, start + 24000), next = start + chunk.length;
    return { ok: true, entryId: a.entryId, version, offset: start, chunk, nextOffset: next < s.length ? next : null };
  },
  grokbot_card_image(a) {
    const t = tgt(a.bot), f = t.full[a.entryId], item = f ? JSON.parse(f[0]) : findItem(t, a.entryId);
    if (!item) throw new Error('This message is no longer available. Refresh the conversation.');
    const m = item.media && item.media[a.index];
    if (!m || m.kind !== 'image') throw new Error('That image is no longer available.');
    if (/broken/i.test(m.name)) throw new Error('This image could not be loaded.');
    return { dataUrl: FX.images[/chart/i.test(m.name) ? 'chart' : /mockup/i.test(m.name) ? 'mockup' : 'swatch'] };
  },
  grokbot_card_action(a) {
    if (a.action === 'open') { log('mock', 'Grok Bot opens its own sign-in / approval screen. Secrets never pass through VoiceOS.', 'dim'); return { ok: true, opened: true }; }
    const t = tgt(a.bot), item = findItem(t, a.entryId || '');
    if (!item) throw new Error('This message is no longer available. Refresh the conversation.');
    if (!item.choice || item.state !== 'pending') throw new Error('This question has already been answered or dismissed. Refresh the conversation.');
    if (a.action === 'dismiss') { item.state = 'dismissed'; return { ok: true, state: 'dismissed' }; }
    if (a.action !== 'answer') throw new Error('Unknown action.');
    item.answer = answerOf(item.choice, a.values || [], a.custom || '');
    item.state = 'resolved';
    return { ok: true, state: 'resolved' };
  },
  grokbot_card_files(a) {
    if (!FX.bots.concat(FX.groups).some(b => b.id === a.bot)) throw new Error('This bot is no longer available.');
    Object.values(S.jobs).forEach(advance);
    if (a.action === 'status') {
      const j = a.jobId ? S.jobs[a.jobId] : Object.values(S.jobs).reverse().find(x => x.bot === a.bot && x.state === 'working');
      if (a.jobId && (!j || j.bot !== a.bot)) throw new Error('This attachment session has expired.');
      return snap(a.bot, j);
    }
    if (a.action === 'remove') {
      const f = S.files[a.attachmentId || ''];
      if (!f || f.bot !== a.bot) throw new Error('This attachment is no longer available.');
      if (f.locked) throw new Error('Wait for the current send to finish.');
      delete S.files[f.id];
      return snap(a.bot);
    }
    if (a.action === 'pick') {
      const active = Object.values(S.jobs).find(x => x.kind === 'pick' && x.state === 'working');
      if (active) { if (active.bot !== a.bot) throw new Error('Finish the open file picker first.'); return snap(a.bot, active); }
      log('mock', 'the native macOS file picker opens here (the preview picks 2 files in 1.5 s)', 'dim');
      return snap(a.bot, job(a.bot, 'pick', 1500));
    }
    if (a.action !== 'send') throw new Error('Unknown action.');
    const ids = Array.from(new Set(a.attachments || [])), message = (a.message || '').trim(), nonce = a.clientNonce;
    if (!nonce || !/^[a-zA-Z0-9_-]{8,128}$/.test(nonce)) throw new Error('Reopen the composer before sending.');
    if (!ids.length || ids.length > 20) throw new Error('Choose files to attach first.');
    const fp = JSON.stringify([a.bot, ids, message]), existing = S.jobs[S.sends[nonce] || ''];
    if (existing) {
      if (existing.fp !== fp) throw new Error('This send belongs to a different draft.');
      log('mock', 'same clientNonce and draft: the existing job, no second send', 'dim');
      return snap(a.bot, existing);
    }
    const files = ids.map(id => S.files[id]);
    if (files.some(f => !f || f.bot !== a.bot || f.locked)) throw new Error('An attachment is unavailable or already sending.');
    files.forEach(f => { f.locked = true; });
    const j = job(a.bot, 'send', 2500);
    j.fp = fp; j.files = ids; j.text = message;
    S.sends[nonce] = j.id;
    return snap(a.bot, j);
  },
  grokbot_card_teach(a) {
    const b = FX.bots.find(x => x.id === a.bot);
    if (!b) throw new Error('Teach a task is available for an individual bot.');
    const st = S.teach;
    if (a.action === 'status') return { ok: true, recording: clone(st) };
    if (st.state !== 'idle' && st.agentId !== a.bot) throw new Error('Another bot is recording. Finish that recording first.');
    if (a.action === 'prepare') {
      if ($('#computerOff').checked) throw new Error('The bot\u2019s computer is starting. Try Teach a task again in a moment.');
      // The real result also carries the 57 KB noVNC viewer; keep its size honest.
      return { ok: true, recording: clone(st), wsUrl: 'wss://preview.invalid/websockify', viewer: 'x'.repeat(57716) };
    }
    if (a.action === 'start') {
      if (st.state !== 'recording') S.teach = { state: 'recording', agentId: a.bot, startedAtMs: Date.now(), maxDurationMs: 600000 };
      return { ok: true, recording: clone(S.teach) };
    }
    if (a.action === 'save' || a.action === 'discard') { S.teach = idle(); return { ok: true, recording: clone(S.teach), saved: a.action === 'save' && st.state !== 'idle' }; }
    throw new Error('Unknown action.');
  },
  grokbot_open_computer_window(a) {
    const b = botNamed(a.bot);
    if (!b) throw new Error('No bot named ' + a.bot + '.');
    if ($('#computerOff').checked) return { opened: false, bot: b.name, live: false, message: b.name + "'s computer is not running right now." };
    log('mock', 'the native interactive computer window opens for ' + b.name, 'dim');
    return { opened: true, bot: b.name, live: true, viewOnly: false, message: 'Opened ' + b.name + "'s computer in a interactive window." };
  },
  grokbot_card_send(a) {
    const message = String(a.message || '').trim();
    if (!message) throw new Error('Type a message first.');
    if (a.bot === undefined && a.group === undefined) { log('mock', 'new-group send (no mock thread)', 'dim'); return { sent: true }; }
    const ref = a.bot !== undefined ? a.bot : a.group, r = String(ref).trim().toLowerCase();
    const b = botNamed(ref) || FX.groups.find(x => x.id === ref || x.name.toLowerCase() === r);
    if (!b) throw new Error('No bot named ' + ref + '.');
    if (S.targets[b.id]) mine(S.targets[b.id], message);
    return { sent: true };
  },
};

// ── Controls ──
$('#theme').value = FX.scenario.theme;
$('#invoke').checked = FX.scenario.invoke;
['#theme', '#invoke', '#twostep', '#initData', '#speed', '#cap'].forEach(s => $(s).addEventListener('change', () => { log('host', 'card settings changed: reloading the card', 'dim'); load(); }));
$('#reload').addEventListener('click', load);
$('#visibility').addEventListener('change', () => { frame.contentWindow.postMessage({ type: 'preview:visibility', state: $('#visibility').value }, '*'); log('host', 'card visibility: ' + cardVisibility(), 'dim'); });
document.addEventListener('visibilitychange', () => { if ($('#visibility').value === 'real') log('host', 'tab ' + document.visibilityState, 'dim'); });
$('#clear').addEventListener('click', () => { logEl.textContent = ''; });
$('#otherRec').addEventListener('change', () => { S.teach = $('#otherRec').checked ? otherRecording() : idle(); log('mock', $('#otherRec').checked ? 'Jerome is now recording a task' : 'no recording', 'dim'); });
const approve = $('#approve');
if (approve) approve.addEventListener('click', () => log('HOST', 'approved: VoiceOS would now run grokbot_send ' + short(Object.assign({}, FX.initArgs, edits)) + ' (not run in the preview)', 'ok'));
window.card = {
  click: selector => new Promise(r => { waiters.push(r); frame.contentWindow.postMessage({ type: 'preview:click', selector }, '*'); }),
  inspect: (selector, max) => new Promise(r => { waiters.push(r); frame.contentWindow.postMessage({ type: 'preview:inspect', selector, max }, '*'); }),
  state: () => S,
  reload: load,
};
load();
})();`;

const opt = (pairs: [string, string][], selected = pairs[0][0]) =>
  pairs.map(([v, l]) => `<option value="${v}"${v === selected ? " selected" : ""}>${l}</option>`).join("");

function hostPage(s: Scenario): string {
  const fx = {
    scenario: { slug: s.slug, theme: s.theme, invoke: s.invoke },
    card: instrument(s.html), glance: s.glance ?? 0, initArgs: s.initArgs, uiCallable,
    bots: agents.filter((a) => !a.isGroup).map(cards.toBot), groups: agents.filter((a) => a.isGroup).map(cards.toGroup),
    targets, liveTemplates, images, olderCursor: OLDER_CURSOR, showCursor: SHOW_CURSOR, showTail: SHOW_TAIL,
  };
  const warnings = warningsFor(s);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escHtml(s.title)} · Grok Bot preview</title>
<style>${HOST_CSS}</style></head>
<body data-theme="${s.theme}">
<header><a href="index.html">← All scenarios</a><h1>${escHtml(s.title)}</h1><p>${escHtml(s.blurb)}</p></header>
${warnings.map((w) => `<div class="warn-box">${escHtml(w)}</div>`).join("\n")}
<main>
<section>
  <div class="notch"><iframe id="card" title="Grok Bot card" sandbox="allow-scripts"></iframe></div>
  <div class="meta" id="meta"></div>
  <p class="hint">${escHtml(s.hint)}</p>
  ${s.confirmation || !s.invoke ? "" : `<p class="hint">Live refresh pauses while the card is hidden: switch tabs, or use Card visibility.</p>`}
</section>
<section>
  <div class="controls">
    <h2>Card</h2>
    <label>Theme <select id="theme">${opt([["dark", "Dark"], ["light", "Light"]], s.theme)}</select></label>
    <label><input type="checkbox" id="invoke"> capabilities.invokeTool</label>
    <label><input type="checkbox" id="twostep"> Real-host double init (false, then true)</label>
    <label>Init data <select id="initData">${opt([["empty", "{} (like VoiceOS)"], ["omit", "omitted"]])}</select></label>
    <label>Timer speed <select id="speed">${opt([["1", "1× (real)"], ["10", "10×"], ["40", "40× (30 refreshes ≈ 11 s)"]])}</select></label>
    <label>Host request cap <select id="cap">${opt([["64", "64 per card (VoiceOS)"], ["0", "off"]])}</select></label>
    <label>Card visibility <select id="visibility">${opt([["real", "this tab's"], ["visible", "force visible"], ["hidden", "force hidden"]])}</select></label>
    <h2>Next reply</h2>
    <label>Next tool call <select id="next">${opt([["normal", "normal"], ["okfalse", "server error (ok:false)"], ["failed", "status failed"], ["unknown", "status unknown"], ["cancelled", "status cancelled"], ["silent", "no reply (timeout)"]])}</select></label>
    <label><input type="checkbox" id="slow"> Slow replies (3 s)</label>
    <h2>Mock server</h2>
    <label>Huge message <select id="entryMode">${opt([["normal", "loads normally"], ["once", "edited once while loading"], ["always", "keeps changing"]])}</select></label>
    <label>File send <select id="filesOutcome">${opt([["complete", "completes"], ["failed", "fails"], ["unknown", "unconfirmed"]])}</select></label>
    <label><input type="checkbox" id="pickCancel"> File picker cancelled</label>
    <label><input type="checkbox" id="computerOff"> Bot computer is off</label>
    <label><input type="checkbox" id="otherRec"> Another bot is recording</label>
    <div class="btns"><button class="h" id="reload" type="button">Reload card (resets mocks)</button><button class="h" id="clear" type="button">Clear log</button>${s.confirmation ? `<button class="h primary" id="approve" type="button">Approve (host button)</button>` : ""}</div>
  </div>
  <div class="counts" id="counts"></div>
  <pre id="log"></pre>
</section>
</main>
<script type="application/json" id="fx">${jsonForScript(fx)}</script>
<script>${HOST_JS}</script>
</body></html>
`;
}

function indexPage(): string {
  const tiles = scenarios.map((s) => {
    const w = warningsFor(s);
    return `<a class="tile" href="${s.slug}.html"><b>${escHtml(s.title)}</b><span>${escHtml(s.blurb)}</span>${w.length ? `<em>${w.length} warning${w.length > 1 ? "s" : ""}</em>` : ""}</a>`;
  }).join("\n");
  const checks: [string, string][] = [
    ["Live refresh", "A new message every 15 s while visible; the header status changes. After 30 refreshes: “Live updates paused…”."],
    ["Older messages", "“Earlier messages” at the top loads 3 older pages, keeps the scroll position, then hides."],
    ["Drafts", "Typed text survives every refresh; in the roster card it survives Back and reopen."],
    ["Formatted text", "Table scrolls sideways, code has colors, math renders, one-line text looks like before."],
    ["Lazy images", "Images load when scrolled into view; the broken mockup shows “Open in Grok Bot”."],
    ["Requests", "Sign in to Gmail has “Open in Grok Bot”; the connector and resolved/expired approvals do not. Choices answer, multi-select sends, Dismiss works."],
    ["Deferred message", "The appendix preview loads in full when visible (ends with END OF COMPLETE MESSAGE)."],
    ["Open computer", "Header button on 1:1 only; with “Bot computer is off” the card shows the message."],
    ["Composer menu", "+ opens Attach files / Teach a task (1:1 only). Chips, ×, send with files, teach start → save."],
  ];
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Grok Bot live preview</title>
<style>${HOST_CSS}
.wrap{padding:8px 24px 40px;max-width:1080px}
.tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px;margin:16px 0 28px}
.tile{display:flex;flex-direction:column;gap:6px;padding:14px 16px;border:1px solid var(--line);border-radius:12px;background:var(--panel);color:var(--ink);text-decoration:none}
.tile:hover{border-color:#4a4a52}
.tile span{color:var(--ink2)}
.tile em{color:var(--warn);font-style:normal}
table{border-collapse:collapse;width:100%}
td{padding:7px 10px;border-top:1px solid var(--line);vertical-align:top;color:var(--ink2)}
td:first-child{color:var(--ink);white-space:nowrap;font-weight:500}
code{font:12px ui-monospace,Menlo,monospace;color:var(--ink)}
</style></head>
<body>
<header><h1>Grok Bot live preview</h1><p>Real cards from cards.ts in a mock VoiceOS host. Nothing leaves this page: every tool call is answered by a local mock and logged. Built ${new Date(NOW).toLocaleString("en-US")}.</p></header>
<div class="wrap">
<div class="tiles">
${tiles}
</div>
<h2 style="font-size:13px;margin:0 0 6px">What to check</h2>
<table>${checks.map(([k, v]) => `<tr><td>${escHtml(k)}</td><td>${escHtml(v)}</td></tr>`).join("")}</table>
<p style="color:var(--ink3);margin-top:18px">Rebuild: <code>node scripts/inline-assets.mjs &amp;&amp; bun scripts/preview-live.ts</code>. In a page's console, <code>card.click(selector)</code> and <code>card.inspect(selector)</code> reach inside the card.</p>
</div>
</body></html>
`;
}

mkdirSync(OUT, { recursive: true });
const written: string[] = [];
for (const s of scenarios) {
  const path = join(OUT, `${s.slug}.html`);
  writeFileSync(path, hostPage(s));
  written.push(path);
  for (const w of warningsFor(s)) console.error(`⚠ ${s.slug}: ${w}`);
}
const index = join(OUT, "index.html");
writeFileSync(index, indexPage());
console.log(`preview-live: wrote ${written.length + 1} pages\n  ${[index, ...written].join("\n  ")}`);

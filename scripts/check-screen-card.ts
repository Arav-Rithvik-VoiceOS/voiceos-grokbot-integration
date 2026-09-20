/**
 * Screen-card gate: proves the live screen card (with the bundled noVNC viewer)
 * fits the host's byte cap, fills every placeholder, and that the idle card
 * ships WITHOUT the viewer.
 *
 *   bun run check-screen
 *
 * Also writes an out-of-VoiceOS repro page to the scratchpad when the Grok Bot
 * session is available: the exact card HTML the tool would return, pointed at
 * the real websockify socket. Open it in a browser to watch the viewer connect.
 */
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { screenCard, glanceChars } from "../cards.ts";
import type { Agent } from "../client.ts";

/** VoiceOS drops any widget glance whose JSON.stringify({blocks}) exceeds this (validateGlancePayload). */
const CAP = 96_000;
/** The gate must measure a WORST-CASE real card, not a toy one: a real fork-box socket url is ~185
 * chars and a real bot carries a UUID + long name/label. A short fixture once passed at 95.5k while
 * the real card was 96.5k — over the cap, so every live screen silently degraded to the idle card. */
const HEADROOM = 2_000;
const WS_URL = `wss://example.cursorvm.com/websockify?token=5&network_token=${"x".repeat(260)}`;
const bot = {
  id: "00000000-0000-4000-8000-000000000000",
  name: "A Rather Long Bot Name For The Gate",
  title: "Executive Assistant",
  isRunning: true,
  isRunningTurn: true,
} as unknown as Agent;

const html = (card: ReturnType<typeof screenCard>) => card._voiceos_glance.blocks[0].html;
const fail = (msg: string) => {
  console.error("FAIL:", msg);
  process.exit(1);
};

// 1. Live card: viewer present, placeholders gone, under cap.
const liveCard = screenCard(bot, { wsUrl: WS_URL, viewerUrl: "https://example.cursorvm.com/vnc.html" });
const live = html(liveCard);
const liveChars = glanceChars(liveCard);
if (liveChars > CAP - HEADROOM) fail(`live screen card glance is ${liveChars} chars; it must stay under ${CAP - HEADROOM} (${CAP} cap minus ${HEADROOM} headroom for real bot data)`);
if (/\/\*/.test(live.replace(/const RFB_B64='[^']*'/, ""))) fail("live card still carries a /* comment */ — renderCard's comment strip missed one (a \"/*\" inside a string would also break it)");
if (/__VOICEOS_[A-Z]+__/.test(live)) fail("live card still has an unfilled __VOICEOS_*__ placeholder");
if (!/body\{display:flow-root;/.test(live)) fail("screen card body must establish a flow root so its top margin is included in the reported height");
if (!/const RFB_B64='H4sI/.test(live)) fail("live card is missing the gzip+base64 RFB bundle");
if (!live.includes(`"stream":"${WS_URL}"`)) fail("live card args.stream is not the WebSocket url");
if (!live.includes("goLive(a)")) fail("live card lost the goLive path");
if (!live.includes("DecompressionStream")) fail("live card has no inflate path");
console.log(`live screen card: ${liveChars} glance chars (${Math.round((liveChars / CAP) * 100)}% of the 96k cap), html ${Buffer.byteLength(live)} B ✓`);

// 2. Idle card: no viewer, no placeholders, small.
const idleCard = screenCard(bot);
const idle = html(idleCard);
if (/__VOICEOS_[A-Z]+__/.test(idle)) fail("idle card still has an unfilled placeholder");
if (!/const RFB_B64='';/.test(idle)) fail("idle card should ship an empty RFB_B64");
if (!idle.includes('"stream":""')) fail("idle card must have no stream");
console.log(`idle screen card: ${glanceChars(idleCard)} glance chars ✓`);

// 3. Repro page against the real pod, when a Grok Bot session exists on this Mac.
try {
  const { listAgents, agentScreen } = await import("../client.ts");
  const agents = await listAgents();
  let probe: Awaited<ReturnType<typeof agentScreen>> = { live: false };
  let who = "";
  for (const a of agents) {
    probe = await agentScreen(a.id, 4000);
    if (probe.live) { who = a.name; break; }
  }
  if (probe.live && probe.wsUrl && probe.viewerUrl) {
    console.log(`repro streams ${who}'s own desktop`);
    const page = html(screenCard(bot, { wsUrl: probe.wsUrl, viewerUrl: probe.viewerUrl }));
    const dir = process.env.SCREEN_REPRO_DIR ?? mkdtempSync(join(tmpdir(), "grokbot-screen-"));
    const out = join(dir, "screen-live.html");
    writeFileSync(out, page);
    writeFileSync(join(dir, "screen-idle.html"), idle);
    console.log(`repro page (real socket, token inside — do not share): ${out}`);
  } else {
    console.log("repro page skipped: cloud computer is not streaming right now");
  }
} catch (error) {
  console.log("repro page skipped:", (error as Error).message);
}
console.log("check-screen: PASS");

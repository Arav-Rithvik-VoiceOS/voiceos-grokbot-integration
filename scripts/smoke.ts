/**
 * Transport smoke test (BUILD.md Stage 3 gate): proves client.ts and the tool
 * surface are sound WITHOUT MCP or VoiceOS in the way. A transport bug shows up
 * here once instead of once per handler.
 *
 *   bun scripts/smoke.ts            (run from the integration folder)
 *
 * Needs COMPOSIO_API_KEY in env or ../.env.
 *
 * Two phases:
 *   OFFLINE (always run, always gate): key present, slug audit (every USED_SLUG
 *     exists at the pinned version), connect-card render. A failure here fails
 *     the build.
 *   LIVE (only when an account is already connected): the cheapest read + error-
 *     path classification. When NO account is connected at build time, these are
 *     DEFERRED — not failed. The harness NEVER connects an account at build time;
 *     the runtime per-user connect (BUILD.md R3-005) exercises the live path on
 *     the user's first call. So a clean offline pass with no account is a DONE
 *     build, not a blocked one. (hands-off install, 2026-09-04)
 *
 * ── TO ADAPT ──
 * Fill LIVE_READ with the cheapest read slug of this toolkit (e.g. the
 * "get me / my account" tool). Add one resolver block in the CONNECTED branch
 * per resolver you wrote (resolvers call the live account, so they're live).
 */
import {
  IntegrationError,
  SERVICE_NAME,
  TOOLKIT,
  USED_SLUGS,
  composio,
  execute,
  isConnected,
} from "../client.ts";
import { connectResponse } from "../cards.ts";

/** The cheapest read call this toolkit has. Filled in Stage 3. */
const LIVE_READ: { slug: string; args?: Record<string, unknown> } = {
  slug: "{{SMOKE_READ_SLUG}}",
  args: {},
};

const say = (error: unknown) =>
  error instanceof IntegrationError ? `${error.kind}: ${error.message}` : String(error);

let failures = 0;

// ── OFFLINE checks — always run, always gate ────────────────────────────────
console.log("1. Composio key configured:", Boolean(process.env.COMPOSIO_API_KEY));
if (!process.env.COMPOSIO_API_KEY) process.exit(1);

console.log("2. Slug audit — every used slug exists at the pinned toolkit version");
try {
  const catalog = await composio().tools.getRawComposioTools({ toolkits: [TOOLKIT], limit: 1000 });
  const known = new Set(catalog.map((t: { slug: string }) => t.slug));
  for (const slug of USED_SLUGS) {
    if (known.has(slug)) console.log(`   ${slug} ✓`);
    else if (!slug.startsWith(TOOLKIT.toUpperCase())) console.log(`   ${slug} — other toolkit, not audited here`);
    else {
      failures++;
      console.log(`   ${slug} MISSING — invented, misspelled, or absent at the pinned version`);
    }
  }
} catch (error) {
  failures++;
  console.log("   FAIL —", say(error));
}

console.log("3. Connect state renders — the URL is handed out ONLY when the browser did not open (R3-005)");
// Two openers = two tabs: the server already opened the auth page, and an
// agent that also sees the URL opens it a second time via its native open
// tool. So when the browser opened, the URL must be NOWHERE the model reads —
// not the JSON, not the card. It appears only on the fallback (open failed).
// (granola + todoist, 2026-09-05)
const SAMPLE_URL = "https://backend.composio.dev/api/v3/s/EXAMPLE-CONNECT-LINK";
const exactUrlRegex = (() => {
  const escaped = SAMPLE_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9_./:-])${escaped}([^A-Za-z0-9_./:-]|$)`);
})();
{
  const opened = connectResponse(SAMPLE_URL, true);
  const fallback = connectResponse(SAMPLE_URL, false);
  const leaked = exactUrlRegex.test(JSON.stringify(opened.payload)) || exactUrlRegex.test(opened.card.html);
  const fallbackHasUrl = fallback.payload.connect_url === SAMPLE_URL && exactUrlRegex.test(fallback.card.html);
  if (leaked) failures++;
  if (!fallbackHasUrl) failures++;
  console.log(`   browser opened → ${opened.card.height}px card, URL absent: ${leaked ? "NO — leaks the URL, the agent will open a second tab" : "✓"}`);
  console.log(`   open failed   → ${fallback.card.height}px card, URL present: ${fallbackHasUrl ? "✓" : "NO — the user has no way to connect"}`);
}

// ── LIVE checks — only when an account is already connected ──────────────────
// A missing connection is NOT a failure: the harness never connects at build
// time, and the runtime per-user connect (R3-005) runs these on first use.
console.log(`4. ${SERVICE_NAME} connected:`);
let connected = false;
try {
  connected = await isConnected();
  console.log("   ", connected);
} catch (error) {
  console.log("   (could not check —", say(error), "→ treating as not connected)");
}

if (!connected) {
  console.log("\n5. Live read — DEFERRED (no account connected at build time)");
  console.log("   The runtime per-user connect (BUILD.md R3-005) exercises this on the user's first call.");
  console.log("6. Not-connected path — the one live check that needs NO account (R3-010)");
  // With no account linked, the cheapest read MUST classify as kind
  // "not_connected": that kind is what makes server.ts open the OAuth page and
  // render the connect card (R3-005). Any OTHER kind means the user's first
  // call says "failed unexpectedly", the agent retries the confirm card, then
  // falls back to some other installed app. A NO_AUTH toolkit (Yelp) has no
  // account to miss, so a plain success here is also fine. (todoist, 2026-09-05)
  try {
    await execute(LIVE_READ.slug, LIVE_READ.args ?? {});
    console.log("   read with no account → ok (toolkit needs no user account) ✓");
  } catch (error) {
    const ok = error instanceof IntegrationError && error.kind === "not_connected";
    if (!ok) failures++;
    console.log(
      "   read with no account →",
      say(error),
      ok ? "✓" : "(expected kind 'not_connected' — fix classifyThrown/classifyExecutionError in client.ts)",
    );
  }
} else {
  console.log(`5. Live read — ${LIVE_READ.slug}`);
  try {
    const data = await execute(LIVE_READ.slug, LIVE_READ.args ?? {});
    const keys = Array.isArray(data)
      ? `array(${data.length})`
      : data && typeof data === "object"
        ? Object.keys(data).slice(0, 12).join(", ")
        : typeof data;
    console.log("   envelope →", keys);
  } catch (error) {
    failures++;
    console.log("   FAIL —", say(error));
  }

  console.log("6. Error paths");
  try {
    await execute(LIVE_READ.slug, LIVE_READ.args ?? {}, { timeoutMs: 1 });
    failures++;
    console.log("   timeout → NO ERROR RAISED (unexpected)");
  } catch (error) {
    const ok = error instanceof IntegrationError && error.kind === "timeout";
    if (!ok) failures++;
    console.log(`   timeout →`, say(error), ok ? "✓" : "(expected kind 'timeout')");
  }

  // ── Resolver checks (live): add one block per "spoken name → id" resolver, e.g.
  //   console.log('7. resolveThing("vibe dj") →', (await resolveThing("vibe dj")).id);
  //   and one ambiguous/unknown case asserting it THROWS. ──
}

if (failures) {
  console.log(`\nsmoke: ${failures} check(s) failed.`);
  process.exit(1);
}
console.log(
  connected
    ? "\nsmoke: transport ok ✓"
    : "\nsmoke: offline checks + not-connected path ok ✓ — live read deferred to the runtime per-user connect (R3-005)",
);

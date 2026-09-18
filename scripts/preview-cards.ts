/**
 * Card visual pass (BUILD.md Stage 4 gate): render every card with realistic
 * AND worst-case data into one HTML page for human eyeballing — no VoiceOS,
 * no network.
 *
 *   bun scripts/preview-cards.ts [output.html]     (from the integration folder)
 *
 * ── TO ADAPT ──
 * One entry per card function, three flavours where they exist:
 *   realistic · worst-case (long strings, emoji, RTL, max rows) · empty state.
 * The LONG constant below is your worst-case title — keep using it.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { setIntegrationMark } from "../widgetKit.ts";
import { connectCard, exampleConfirmCard, exampleListCard, exampleReceiptCard, glanceStats } from "../cards.ts";

try {
  const markBytes = readFileSync(new URL("../mark.png", import.meta.url));
  setIntegrationMark(`data:image/png;base64,${markBytes.toString("base64")}`);
} catch {
  console.error("(no mark.png yet — previewing with the default mark)");
}

const LONG =
  "Refactor the authentication middleware to support rotating refresh tokens without breaking existing sessions 🚀🚀";

const cards = [
  ["connect (first run — browser opened, no link)", connectCard("https://backend.composio.dev/api/v3/s/EXAMPLE123")],
  ["connect (open failed — link fallback)", connectCard("https://backend.composio.dev/api/v3/s/EXAMPLE123", false)],
  [
    "list (busy + worst-case)",
    exampleListCard(
      [
        { title: LONG, subtitle: "somewhere/long-subtitle-也很长", status: "needs you", tone: "accent" },
        { title: "A failing thing", subtitle: "elsewhere", status: "failing", tone: "bad" },
        { title: "A ready thing", subtitle: "here", status: "ready", tone: "good" },
        { title: "Neutral row", subtitle: "there", status: "waiting", tone: "neutral" },
        { title: "Fifth row (the cap)", subtitle: "cap", status: "ok", tone: "good" },
      ],
      9,
    ),
  ],
  ["list (empty)", exampleListCard([], 0)],
  ["receipt", exampleReceiptCard({ eyebrow: "Created", title: LONG, url: "https://example.com/thing/4" })],
  // Confirmation widgets too — the date picker and the coloured priority
  // select must be looked at in BOTH themes before they are frozen (R2-006).
  ["confirm (create item)", exampleConfirmCard()],
] as const;

const sections = cards
  .map(
    ([name, card]) =>
      `<section><h2>${name} · ${card.height}px</h2><div class="notch" style="height:${card.height}px">${card.html}</div></section>`,
  )
  .join("\n");

const page = `<!doctype html><meta charset="utf-8"><title>card preview</title>
<style>
  body { background: #0d0d0f; color: #9a9aa0; font: 13px -apple-system, sans-serif; margin: 32px; }
  h2 { font-size: 11px; font-weight: 500; letter-spacing: .08em; text-transform: uppercase; margin: 28px 0 8px; }
  .notch { width: 400px; border-radius: 14px; overflow: hidden; outline: 1px solid #2a2a2e; }
</style>
${sections}`;

const out = process.argv[2] ?? "preview.html";
writeFileSync(out, page);
console.log(`wrote ${out} — ${cards.length} cards. OPEN IT AND LOOK.`);

// Glance-cap gate: the host DROPS a card whose serialised payload exceeds
// 96,000 chars (widget block) / 32,000 (other) — a silent blank, tighter than
// the 131072 html byte cap. Fail the build here so it never ships. (R4-003)
let capFail = false;
for (const [name, card] of cards) {
  const { rawChars, fittedChars, cap, degraded } = glanceStats(card);
  if (fittedChars > cap) {
    console.error(`✗ ${name}: glance ${fittedChars} chars > ${cap} cap — the host would DROP this card (blank). Shrink it.`);
    capFail = true;
  } else if (degraded) {
    console.error(`⚠ ${name}: glance was ${rawChars} chars (> ${cap} cap); fitGlance dropped embedded data to reach ${fittedChars}. Content was lost — shrink the card.`);
  }
}
if (capFail) process.exit(1);

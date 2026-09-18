/**
 * Design-pack fidelity gate (BUILD.md Stage 4, R4-007; Stage 5 step 8).
 *
 *   bun scripts/check-design-pack.ts        (from the integration folder)
 *
 * When a build has a design pack (design/cards/*.html + design/cards.css,
 * written by the garage design pass between Phase 1 and Phase 2), the cards
 * in cards.ts must REPRODUCE it, not reinterpret it. This checks that
 * mechanically, for every `design/cards/<name>.html`:
 *   1. `designCards[<name>]` exists in cards.ts and renders;
 *   2. the rendered html contains every CSS class the snippet uses (the
 *      builder kept the markup, not just the colours);
 *   3. `design/cards.css` is present verbatim in the rendered document;
 *   4. for confirm cards, the set of `data-voiceos-key`s matches exactly;
 *   5. `{{MARK}}` was replaced (no literal placeholder survives).
 * No pack → exit 0 with a note (the old research-brand path is in force).
 *
 * Why a script: google tasks + todoist v1/v2 (2026-09-05/06) shipped generic
 * forms although a "mini app" mandate existed — a mandate is not a gate.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { setIntegrationMark } from "../widgetKit.ts";
import { designCards } from "../cards.ts";

const here = new URL("../", import.meta.url);
const packDir = new URL("design/", here);
const cardsDir = new URL("cards/", packDir);

if (!existsSync(cardsDir)) {
  console.log("check-design-pack: no design/ pack — skipped (research-brand path).");
  process.exit(0);
}
if (existsSync(new URL("INCOMPLETE", packDir))) {
  console.log("check-design-pack: design/INCOMPLETE present — the garage pass did not finish; skipped.");
  process.exit(0);
}

try {
  const markBytes = readFileSync(new URL("mark.png", here));
  setIntegrationMark(`data:image/png;base64,${markBytes.toString("base64")}`);
} catch {
  /* the mark check below is about the placeholder, not the bytes */
}

const cssPath = new URL("cards.css", packDir);
const css = existsSync(cssPath) ? readFileSync(cssPath, "utf8").trim() : "";
// Heights measured by the garage (scripts/measure-card-heights.ts) — the
// builder must declare these so no card is cut off (card-height-cutoff,
// 2026-09-07). Absent (no Chrome in the garage) → the height check is skipped.
const heightsPath = new URL("heights.json", packDir);
const heights: Record<string, number> = existsSync(heightsPath)
  ? (() => { try { return JSON.parse(readFileSync(heightsPath, "utf8")); } catch { return {}; } })()
  : {};
// `_icons.html` is the shared SVG sprite, not a card: the builder prepends it
// to every body, and the check below is that each card's <use href="#id">
// still resolves in the rendered document.
const snippets = readdirSync(cardsDir).filter((f) => f.endsWith(".html") && !f.startsWith("_")).sort();
const spritePath = new URL("_icons.html", cardsDir);
const sprite = existsSync(spritePath) ? readFileSync(spritePath, "utf8") : "";

const classesOf = (html: string): Set<string> => {
  const out = new Set<string>();
  for (const m of html.matchAll(/class="([^"]+)"/g)) for (const c of m[1].split(/\s+/)) if (c) out.add(c);
  return out;
};
const keysOf = (html: string): Set<string> =>
  new Set([...html.matchAll(/data-voiceos-key="([^"]+)"/g)].map((m) => m[1]));

let failures = 0;
const fail = (m: string) => { failures++; console.error(`✗ ${m}`); };

if (!css) fail("design/cards.css is missing or empty.");

for (const file of snippets) {
  const name = file.replace(/\.html$/, "");
  const snippet = readFileSync(new URL(file, cardsDir), "utf8");
  const entry = (designCards as Record<string, (() => { html: string }) | undefined>)[name];
  if (!entry) { fail(`${name}: no designCards["${name}"] in cards.ts — every pack card needs a card function.`); continue; }
  let html = "";
  let declaredHeight = 0;
  try { const card = entry(); html = card.html; declaredHeight = (card as { height?: number }).height ?? 0; }
  catch (e) { fail(`${name}: designCards["${name}"]() threw: ${(e as Error).message}`); continue; }

  // Height: the card must declare the measured height (±2 for the clamp/round),
  // or the notch cuts its bottom row off (card-height-cutoff, 2026-09-07).
  const measured = heights[name];
  if (typeof measured === "number" && Math.abs(declaredHeight - measured) > 2) {
    fail(`${name}: declares height ${declaredHeight} but the garage measured ${measured} — pass renderCustom({ height: HEIGHTS["${name}"] }) so the card is not cut off. If the measurement is stale, re-run scripts/measure-card-heights.ts.`);
  }

  // Identifier dropdowns ship ONE honest default, never invented extras: the
  // card can't know the user's real lists/projects (todoist + google-tasks,
  // 2026-09-07). More than one static <option> under a data-k-options select
  // is a fabricated fallback.
  let hasOptionsSelect = false;
  for (const m of snippet.matchAll(/<select\b[^>]*\bdata-k-options=[^>]*>([\s\S]*?)<\/select>/g)) {
    hasOptionsSelect = true;
    const opts = [...m[1].matchAll(/<option\b/g)].length;
    if (opts > 1) fail(`${name}: a data-k-options <select> has ${opts} static options — ship ONE (the account's real default); the kit fills the rest from live data. Invented options ("Work", "Home") read as broken.`);
  }
  // An identifier picker must carry the agent-hydration script (R2-009), which
  // rebuilds the dropdown from m.args["<key>_choices"]. Its marker is the
  // "_choices" token the script reads. Without it the dropdown is stuck on the
  // single static default (todoist, 2026-09-07).
  if (hasOptionsSelect && !html.includes("_choices")) {
    fail(`${name}: has a data-k-options picker but no agent-hydration script — prepend the shared _choices script (skills/cards.md "Agent-hydrated pickers") so the dropdown shows the user's real ones.`);
  }

  // A date arg is a native calendar picker, never a free-text box (todoist
  // 2026-09-07): a text input whose key is a date arg fails.
  for (const m of snippet.matchAll(/<(input|textarea)\b([^>]*)\bdata-voiceos-key="([^"]+)"([^>]*)>/g)) {
    const [, tag, pre, key, post] = m;
    const attrs = pre + post;
    const isDateKey = /^(due|date|when|start|end|deadline|due_date|start_date|end_date)$/i.test(key) || /(^|_)date$/i.test(key);
    const isDateInput = tag === "input" && /type="date"/.test(attrs);
    if (isDateKey && !isDateInput) fail(`${name}: arg "${key}" is a date but renders as free text — use <input type="date" data-voiceos-key="${key}"> so the user gets the calendar and the tool gets ISO.`);
  }

  // The host floats the Confirm pill; a card never draws its own submit control.
  // (An in-card <button type="button"> for a segment/toggle/checkbox is fine —
  // only type="submit" is banned, so the brand's own controls stay free.)
  if (/type="submit"/i.test(snippet)) {
    fail(`${name}: contains type="submit" — never draw your own confirm/submit control; the host floats its own pill. In-card <button type="button"> is fine.`);
  }

  // Delete / complete / reopen / archive / remove show the target READ-ONLY:
  // its id/title lives on a STATIC node's data-voiceos-key, never an editable
  // <input>/<textarea> (a delete once shipped the title as an editable box —
  // wrong: a delete shows the target, it does not let you retype it). The only
  // editable control allowed on these cards is a genuine scope <select>.
  if (/(^|-)(delete|complete|reopen|archive|remove|clear)(-|$)/.test(name)) {
    const editable = [...snippet.matchAll(/<(input|textarea)\b([^>]*)\bdata-voiceos-key="([^"]+)"([^>]*)>/g)]
      .filter((m) => !/type="hidden"/.test(m[2] + m[4]));
    if (editable.length) {
      const kind = /(delete|remove|archive|clear)/.test(name) ? "destructive" : "state-change";
      fail(`${name}: a ${kind} card renders its target as an editable <${editable[0][1]}> (key "${editable[0][3]}") — the target is a READ-ONLY node carrying data-voiceos-key, never an <input>/<textarea>. The only editable control allowed here is a scope <select>.`);
    }
  }

  const want = classesOf(snippet);
  const have = classesOf(html);
  const missing = [...want].filter((c) => !have.has(c));
  if (missing.length) fail(`${name}: rendered card lacks pack classes ${missing.join(", ")} — copy the snippet's markup, do not redraw it.`);

  if (css && !html.includes(css)) fail(`${name}: design/cards.css is not in the rendered document verbatim — pass it as renderCustom({ css }).`);

  if (/\{\{MARK\}\}/.test(html)) fail(`${name}: literal {{MARK}} survived — replace it with markHtml().`);

  const uses = [...snippet.matchAll(/<use[^>]*href="#([^"]+)"/g)].map((m) => m[1]);
  const unresolved = [...new Set(uses)].filter((id) => !new RegExp(`\\bid="${id}"`).test(html));
  if (unresolved.length) fail(`${name}: icon(s) ${unresolved.join(", ")} have no <symbol> in the rendered card — prepend design/cards/_icons.html to every body.`);
  if (sprite && uses.length && !html.includes("<symbol")) fail(`${name}: the icon sprite (design/cards/_icons.html) is missing from the rendered card.`);

  const wantKeys = keysOf(snippet);
  if (wantKeys.size) {
    const haveKeys = keysOf(html);
    const a = [...wantKeys].filter((k) => !haveKeys.has(k));
    const b = [...haveKeys].filter((k) => !wantKeys.has(k));
    if (a.length || b.length) fail(`${name}: confirmation fields differ from the pack (missing ${a.join(", ") || "—"}; extra ${b.join(", ") || "—"}).`);
    // The kit's base CSS mentions ".k-confirm" in every document; only the
    // wrapper class proves the card was composed in confirm mode.
    if (!/class="k-(?:c)?wrap k-confirm"/.test(html)) fail(`${name}: pack card has fields but was not rendered with mode: "confirm".`);
  }
  if (!failures) console.log(`✓ ${name}`);
}

if (failures) {
  console.error(`\ncheck-design-pack: ${failures} problem(s) — the cards do not reproduce the design pack.`);
  process.exit(1);
}
console.log(`check-design-pack: ${snippets.length} card(s) match the pack ✓`);

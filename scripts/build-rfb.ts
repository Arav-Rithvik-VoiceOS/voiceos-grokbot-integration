/**
 * Build the VNC viewer client: bundle noVNC's RFB client into ONE file, gzip it,
 * base64 it. We ship TWO bundles:
 *
 *   widgets/rfb.b64       view-only, keyboard/gesture stripped — the notch card
 *   widgets/rfb-full.b64  full input (keyboard + mouse) — the standalone window
 *
 *   bun run build-rfb      (re-run whenever @novnc/novnc is upgraded)
 *
 * Why this exists: the bot's cloud computer serves stock noVNC (vnc.html) behind
 * a router that wants `port_token` on EVERY request. The page's own relative
 * <script src="app/ui.js"> loads carry no token, so they 404 and the viewer
 * never boots — inside the card that is the "black screen". The pod also sends
 * no CORS headers, so a card cannot fetch or import the viewer from the pod.
 * The only thing that works from inside the card is the WebSocket itself. So
 * we ship our own copy of the viewer, inside the card HTML.
 *
 * Why two bundles — the size budget (the real one): VoiceOS validates a glance by
 * JSON.stringify({blocks}).length <= 96 000 chars when a widget block is
 * present (main.js validateGlancePayload, verified on 0.2.27) — NOT the
 * 131072-byte WIDGET_CAPS.htmlChars. The idle screen card is ~32k of that, so
 * the in-notch viewer gets ≈ 60k chars. Full noVNC core is 190 KB minified /
 * 57 KB gzip / 76 KB base64 — too big for the card, so the card's copy stubs the
 * keyboard, gesture and keysym tables (input/*), saving ~18 KB of base64. The
 * STANDALONE WINDOW is a native WKWebView with no glance cap, so it ships the
 * FULL client — that is the only bundle whose keyboard actually works, which is
 * why the window can be typed into and the notch card cannot.
 */
import { gzipSync } from "node:zlib";
import { writeFileSync } from "node:fs";

const ENTRY = new URL("../node_modules/@novnc/novnc/core/rfb.js", import.meta.url).pathname;
const OUT_VIEW = new URL("../widgets/rfb.b64", import.meta.url).pathname;
const OUT_FULL = new URL("../widgets/rfb-full.b64", import.meta.url).pathname;
/** Idle screen card ≈ 32k glance chars; keep the view-only viewer under this so live stays < 96k. */
const MAX_VIEW_B64_CHARS = 60_000;

/** View-only card: replace input handling with inert stand-ins RFB can still construct. */
const VIEW_ONLY_STUBS: Array<[RegExp, string]> = [
  [/core\/input\/keyboard\.js$/, "export default class Keyboard{constructor(){this.onkeyevent=null}grab(){}ungrab(){}}"],
  [/core\/input\/gesturehandler\.js$/, "export default class GestureHandler{attach(){}detach(){}}"],
  // Constant tables only read on the key-send paths, which a view-only card never takes.
  [/core\/input\/keysym\.js$/, "export default {}"],
  [/core\/input\/xtscancodes\.js$/, "export default {}"],
];

async function bundle(stubs: Array<[RegExp, string]>): Promise<string> {
  const build = await Bun.build({
    entrypoints: [ENTRY],
    target: "browser",
    format: "esm",
    minify: true,
    plugins: stubs.length
      ? [{
          name: "view-only-stubs",
          setup(b) {
            for (const [filter, contents] of stubs) b.onLoad({ filter }, () => ({ contents, loader: "js" }));
          },
        }]
      : [],
  });
  if (!build.success) {
    for (const m of build.logs) console.error(m);
    throw new Error("Bun.build failed");
  }
  const js = await build.outputs[0].text();
  return gzipSync(Buffer.from(js), { level: 9 }).toString("base64");
}

// View-only bundle for the notch card (size-capped).
const viewB64 = await bundle(VIEW_ONLY_STUBS);
writeFileSync(OUT_VIEW, viewB64);
console.log(`rfb.b64 (view-only) written: ${viewB64.length} chars base64`);
if (viewB64.length > MAX_VIEW_B64_CHARS) {
  throw new Error(`rfb.b64 is ${viewB64.length} chars, over the ${MAX_VIEW_B64_CHARS} budget — the live screen card would blow VoiceOS's 96k glance cap.`);
}

// Full bundle (real keyboard + mouse) for the standalone WKWebView window — no cap.
const fullB64 = await bundle([]);
writeFileSync(OUT_FULL, fullB64);
console.log(`rfb-full.b64 (interactive) written: ${fullB64.length} chars base64`);

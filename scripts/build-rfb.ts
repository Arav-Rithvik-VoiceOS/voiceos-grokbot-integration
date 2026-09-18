/**
 * Build the in-card VNC viewer: bundle noVNC's RFB client into ONE file, gzip
 * it, base64 it, and write widgets/rfb.b64.
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
 * Size budget (the real one): VoiceOS validates a glance by
 * JSON.stringify({blocks}).length <= 96 000 chars when a widget block is
 * present (main.js validateGlancePayload, verified on 0.2.27) — NOT the
 * 131072-byte WIDGET_CAPS.htmlChars. The idle screen card is ~32k of that, so
 * the viewer gets ≈ 60k chars. Full noVNC core is 190 KB minified / 57 KB gzip
 * / 76 KB base64 — too big. The card is view-only, so the keyboard, gesture and
 * keysym tables (input/*) are dead weight: stubbing them saves ~18 KB of base64
 * and lands the bundle at ~58 KB. gzip is inflated at runtime with the
 * browser's DecompressionStream and imported from a blob: URL, which the
 * networked-card CSP allows (`script-src 'unsafe-inline' https://<domain> blob:`).
 */
import { gzipSync } from "node:zlib";
import { writeFileSync } from "node:fs";

const ENTRY = new URL("../node_modules/@novnc/novnc/core/rfb.js", import.meta.url).pathname;
const OUT = new URL("../widgets/rfb.b64", import.meta.url).pathname;
/** Idle screen card ≈ 32k glance chars; keep the viewer under this so live stays < 96k. */
const MAX_B64_CHARS = 60_000;

/** View-only card: replace input handling with inert stand-ins RFB can still construct. */
const STUBS: Array<[RegExp, string]> = [
  [/core\/input\/keyboard\.js$/, "export default class Keyboard{constructor(){this.onkeyevent=null}grab(){}ungrab(){}}"],
  [/core\/input\/gesturehandler\.js$/, "export default class GestureHandler{attach(){}detach(){}}"],
  // Constant tables only read on the key-send paths, which a view-only card never takes.
  [/core\/input\/keysym\.js$/, "export default {}"],
  [/core\/input\/xtscancodes\.js$/, "export default {}"],
];

const build = await Bun.build({
  entrypoints: [ENTRY],
  target: "browser",
  format: "esm",
  minify: true,
  plugins: [
    {
      name: "view-only-stubs",
      setup(b) {
        for (const [filter, contents] of STUBS) b.onLoad({ filter }, () => ({ contents, loader: "js" }));
      },
    },
  ],
});
if (!build.success) {
  for (const m of build.logs) console.error(m);
  throw new Error("Bun.build failed");
}
const js = await build.outputs[0].text();
const gz = gzipSync(Buffer.from(js), { level: 9 });
const b64 = gz.toString("base64");
writeFileSync(OUT, b64);
console.log(`rfb.b64 written: js ${js.length} B → gzip ${gz.length} B → base64 ${b64.length} chars`);
if (b64.length > MAX_B64_CHARS) {
  throw new Error(`rfb.b64 is ${b64.length} chars, over the ${MAX_B64_CHARS} budget — the live screen card would blow VoiceOS's 96k glance cap.`);
}

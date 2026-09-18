#!/usr/bin/env bun
/**
 * build-publish.mjs — compile this integration into a SHAREABLE server.ts.
 *
 * VoiceOS's Share button ships only five files (server.ts, widgetKit.ts,
 * package.json, the manifest, the icon) and does NOT trace imports — so a
 * server.ts that imports "./client.ts", "./cards.ts", … arrives broken, and one
 * that imports npm packages needs the network on first run. This inlines every
 * local module AND every npm dependency into a single self-contained server.ts
 * (only node: builtins stay external, and those are always present). `node
 * server.ts` type-strips it and bun runs it directly — the exact two runtimes
 * the recipient's regenerated run.sh resolves.
 *
 * The hand-written source is kept as server.src.ts. The FIRST run snapshots the
 * current server.ts into server.src.ts, then every run builds server.src.ts →
 * server.ts. After this, edit server.src.ts (never the bundled server.ts) and
 * re-run.
 *
 *     bun run build-publish        # from the integration folder
 */
import { existsSync, copyFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = join(dirname(fileURLToPath(import.meta.url)), ".."); // integration root
const src = join(dir, "server.src.ts");
const out = join(dir, "server.ts");

// First run: preserve the hand-written server.ts as server.src.ts. Idempotent —
// once server.src.ts exists it is the source of truth and is never overwritten
// by the (now-bundled) server.ts.
if (!existsSync(src)) {
  if (!existsSync(out)) {
    console.error("build-publish: no server.ts to compile."); process.exit(1);
  }
  copyFileSync(out, src);
  console.error("build-publish: snapshotted server.ts → server.src.ts (edit server.src.ts from now on)");
}

// Freeze every runtime-read card asset (widget HTML, adapters, CSS, mark, rfb)
// into assets.generated.ts FIRST, so the bundle below inlines them. Without this
// a shared build boots straight into `ENOENT widgets/connect.html` — the
// widgets/ folder never ships with the five files VoiceOS's Share button sends.
const gen = spawnSync("node", ["scripts/inline-assets.mjs"], { cwd: dir, stdio: "inherit" });
if (gen.status !== 0) { console.error("build-publish: inline-assets failed."); process.exit(gen.status ?? 1); }

const r = spawnSync(
  "bun",
  ["build", "--target=node", "server.src.ts", "--outfile", "server.ts"],
  { cwd: dir, stdio: "inherit" },
);
if (r.status !== 0) { console.error("build-publish: bun build failed."); process.exit(r.status ?? 1); }

const bytes = statSync(out).size;
console.error(`build-publish: wrote self-contained server.ts (${(bytes / 1024 / 1024).toFixed(2)} MB). Run \`node ../../scripts/recipient-sim.mjs <app>\` to verify.`);

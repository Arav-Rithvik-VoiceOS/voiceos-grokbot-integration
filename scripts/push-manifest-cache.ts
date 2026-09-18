/** Push voiceos.integration.json into VoiceOS's manifest cache.
 *
 * VoiceOS caches the whole manifest (tools + confirm HTML) under
 * config.json → installedIntegrations[].manifest and does NOT refresh it on a
 * plain restart, even on a version bump. The host validates card invokeTool
 * args against this cache, so a tool the cache lacks (e.g. grokbot_card_send)
 * fails with "unknown tool" / schema errors until the cache is replaced.
 *
 *   1. Quit VoiceOS (it rewrites config.json on quit — run this AFTER).
 *   2. bun run push-cache
 *   3. Relaunch VoiceOS, then `bun run check:installed` should pass.
 *
 * Refuses to run while VoiceOS is open, and keeps a timestamped backup.
 */
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const configPath = join(homedir(), "Library/Application Support/VoiceOS/config.json");
const manifest = JSON.parse(readFileSync(new URL("../voiceos.integration.json", import.meta.url), "utf8"));

let running = "";
try { running = execFileSync("/usr/bin/pgrep", ["-x", "VoiceOS"], { encoding: "utf8" }).trim(); } catch { /* not running */ }
if (running) {
  console.error("VoiceOS is running (pid " + running.split("\n")[0] + "). Quit it first — it rewrites config.json on quit and would clobber this push.");
  process.exit(1);
}

const config = JSON.parse(readFileSync(configPath, "utf8"));
const entry = config.installedIntegrations?.find((e: any) => e.manifest?.id === manifest.id);
if (!entry) { console.error(`No installed integration with id ${manifest.id}. Install it via the app first.`); process.exit(1); }

const before = entry.manifest?.version;
const backup = `${configPath}.bak-${Date.now()}`;
copyFileSync(configPath, backup);
entry.manifest = manifest;
writeFileSync(configPath, JSON.stringify(config, null, 2));
console.log(`Pushed manifest ${before} → ${manifest.version} (${manifest.tools.length} tools). Backup: ${backup}`);
console.log("Relaunch VoiceOS, then run: bun run check:installed");

/** Check BOTH VoiceOS caches: card definitions and execution confirmation policy.
 * Read-only; never invokes an integration tool or prints account credentials.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

const manifest = JSON.parse(readFileSync(new URL("../voiceos.integration.json", import.meta.url), "utf8"));
const config = JSON.parse(readFileSync(join(homedir(), "Library/Application Support/VoiceOS/config.json"), "utf8"));
const installed = config.installedIntegrations?.find((entry: any) => entry.manifest?.id === manifest.id);
const server = config.customMcpServers?.find((entry: any) => entry.id === installed?.serverId);
const failures: string[] = [];
if (!installed || !server) throw new Error("Grok Bot is not installed with a matching MCP server.");
if (!isDeepStrictEqual(installed.manifest, manifest)) failures.push("Installed manifest differs from voiceos.integration.json.");
if (server.integrationId !== manifest.id) failures.push("Runtime server points to a different integration.");

const expected = manifest.tools.filter((tool: any) => tool.confirmation).map((tool: any) => tool.name).sort();
const actual = [...(server.confirmTools ?? [])].sort();
if (!isDeepStrictEqual(actual, expected)) {
  failures.push(`Runtime confirmTools is [${actual.join(", ")}]; expected [${expected.join(", ")}]. Refresh the server descriptor as well as the manifest.`);
}

// VoiceOS 0.2.41 toolRequiresConfirmation: server mode, then the user's
// per-tool switch, then server.confirmTools, then annotations. Voice send/group
// only open a draft, and the card's send arrow is the one path that sends, so
// NONE of them may ask: a confirmation card is frozen and would break the live
// chat. Mode "all" forces every tool to ask — a user setting, so report it.
const mode = config.integrationConfirmModes?.[`custom_mcp:${server.id}`] || "sensitive";
for (const name of ["grokbot_send", "grokbot_group", "grokbot_card_send"]) {
  const override = config.integrationToolConfirmOverrides?.[`${manifest.id}:${name}`];
  const requiresConfirmation = mode === "all" ? true : mode === "off" ? false
    : typeof override === "boolean" ? override : actual.includes(name);
  console.log(`${name}: effective confirmation = ${requiresConfirmation}${mode === "all" ? " (confirm mode is 'all' — user setting)" : ""}`);
  if (requiresConfirmation && mode !== "all") failures.push(`${name} would ask before running and break the live card.`);
}
// Create must always ask; its hook forces that, and its manifest card draws it.
if (!actual.includes("grokbot_create")) failures.push("grokbot_create is missing its confirmation card.");

if (failures.length) {
  for (const failure of failures) console.error(failure);
  process.exitCode = 1;
} else console.log(`Installed manifest ${manifest.version}, runtime confirmTools, and approval policy agree.`);

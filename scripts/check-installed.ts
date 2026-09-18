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

// VoiceOS 0.2.29 toolRequiresConfirmation checks mode, then explicit tool
// override, then server.confirmTools. Having HTML in the manifest alone does
// not require approval at execution time. These send tools have no annotations.
const mode = config.integrationConfirmModes?.[`custom_mcp:${server.id}`] || "sensitive";
for (const name of ["grokbot_send", "grokbot_group"]) {
  const override = config.integrationToolConfirmOverrides?.[`${manifest.id}:${name}`];
  const requiresConfirmation = mode === "all" ? true : mode === "off" ? false
    : typeof override === "boolean" ? override : actual.includes(name);
  console.log(`${name}: effective confirmation = ${requiresConfirmation}`);
  if (!requiresConfirmation) failures.push(`${name} can execute without confirmation.`);
}

// The card composer's tool must be the opposite: it may NEVER require a host
// confirmation, or the "Confirm action" JSON dialog comes back over the card.
// mode "all" forces confirmation on every tool — that is a user setting, so
// report it rather than fail.
{
  const name = "grokbot_card_send";
  const override = config.integrationToolConfirmOverrides?.[`${manifest.id}:${name}`];
  const requiresConfirmation = mode === "all" ? true : mode === "off" ? false
    : typeof override === "boolean" ? override : actual.includes(name);
  console.log(`${name}: effective confirmation = ${requiresConfirmation}${mode === "all" ? " (confirm mode is 'all' — user setting)" : ""}`);
  if (requiresConfirmation && mode !== "all") failures.push(`${name} would show the host confirmation dialog over the card.`);
}

if (failures.length) {
  for (const failure of failures) console.error(failure);
  process.exitCode = 1;
} else console.log(`Installed manifest ${manifest.version}, runtime confirmTools, and send approval policy agree.`);

import { intents } from "../intents.ts";
import { PREPARE_DESCRIPTION, SEND_DESCRIPTION } from "../messaging.ts";
import { intentErrors } from "../sdk/intents.ts";
const path = new URL("../voiceos.integration.json", import.meta.url);
const manifest = await Bun.file(path).json();
manifest.intents = intents;
manifest.hooks = { ...manifest.hooks, preToolUse: { scope: "own" } };
if (!manifest.permissions.some((p: { kind: string }) => p.kind === "transcript"))
  manifest.permissions.push({ kind: "transcript", scope: "agent" });
for (const tool of manifest.tools) {
  if (tool.name === "grokbot_prepare_message") tool.description = PREPARE_DESCRIPTION;
  if (tool.name !== "grokbot_send") continue;
  tool.description = SEND_DESCRIPTION;
  tool.inputSchema.properties.bot.description = "One Grok Bot's name as spoken, or its exact ID from grokbot_prepare_message. The SDK hook verifies the recipient.";
  tool.inputSchema.properties.recipientId = { type: "string", description: "Internal: recipient ID pinned by the preparation hook. Never compose or change this value." };
}
const errors = intentErrors(manifest.intents, manifest.tools);
if (errors.length) throw new Error(errors.join("\n"));
await Bun.write(path, JSON.stringify(manifest, null, 2) + "\n");

import { renderCard } from "../cards.ts";

// Rebuild the manifest HTML too: VoiceOS reads confirmation cards from the
// manifest, independently of the server's live result-card renderer.
const path = new URL("../voiceos.integration.json", import.meta.url);
const manifest = await Bun.file(path).json();
for (const tool of manifest.tools) {
  if (!["grokbot_send", "grokbot_group"].includes(tool.name)) continue;
  const widget = tool.confirmation.root;
  const frozen = widget.html.match(/^const DEMO=(.*);$/m);
  if (!frozen) throw new Error(`Missing confirmation payload: ${tool.name}`);
  // Preserve the existing fallback data and the tool-specific approval mode.
  const payload = JSON.parse(frozen[1]);
  if (!payload.data.confirmation || payload.data.tool !== tool.name)
    throw new Error(`Unexpected confirmation payload: ${tool.name}`);
  payload.data = { confirmation: true, tool: tool.name, bots: [], groups: [], threads: {}, me: "" };
  payload.args = {};
  widget.html = renderCard("thread", payload);
  if (widget.html.length > 131072)
    throw new Error(`Confirmation exceeds the HTML limit: ${tool.name}`);
}
await Bun.write(path, JSON.stringify(manifest, null, 2) + "\n");

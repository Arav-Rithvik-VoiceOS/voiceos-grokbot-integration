/**
 * Handler smoke test (BUILD.md Stage 5 gate): calls every READ tool through
 * the real MCP protocol — the exact way VoiceOS calls it — against the live
 * connected account, and asserts each returns parseable JSON plus a rendered
 * glance card.
 *
 *   bun scripts/read-handlers-smoke.ts     (run from the integration folder)
 *
 * Read tools are DISCOVERED from voiceos.integration.json: every tool with no
 * `confirmation` block. Write tools are never called — a smoke test must not
 * post, merge, or delete anything real.
 *
 * ── TO ADAPT ──
 * A read tool with REQUIRED args needs a safe example in ARGS below, or this
 * script fails telling you so.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import manifest from "../voiceos.integration.json" with { type: "json" };

/** Safe example arguments for read tools that require them. */
const ARGS: Record<string, Record<string, unknown>> = {
  // e.g. pull_request_status: { repo: "vercel/next.js" },
};

type ManifestTool = {
  name: string;
  confirmation?: unknown;
  inputSchema?: { required?: string[] };
};
const readTools = (manifest.tools as ManifestTool[]).filter((t) => !t.confirmation);
if (readTools.length === 0) {
  console.log("no read tools in the manifest — nothing to smoke-test");
  process.exit(0);
}

// StdioClientTransport only forwards a safe env allowlist to the spawned
// server unless `env` is given explicitly — COMPOSIO_API_KEY would otherwise
// silently never reach it.
const childEnv = Object.fromEntries(
  Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined),
);

const client = new Client({ name: "read-handlers-smoke", version: "1.0.0" });
await client.connect(
  new StdioClientTransport({
    command: "/bin/zsh",
    args: ["run.sh"],
    cwd: new URL("../", import.meta.url).pathname,
    env: childEnv,
  }),
);

let failures = 0;

for (const tool of readTools) {
  process.stdout.write(`${tool.name} ... `);
  const required = tool.inputSchema?.required ?? [];
  const args = ARGS[tool.name];
  if (required.length && !args) {
    failures++;
    console.log(`FAIL — requires [${required.join(", ")}]: add a safe example to ARGS`);
    continue;
  }
  try {
    const res = await client.callTool({ name: tool.name, arguments: args ?? {} });
    if (res.isError) {
      failures++;
      console.log(`TOOL ERROR — ${JSON.stringify(res.content).slice(0, 200)}`);
      continue;
    }
    const text = (res.content as Array<{ text?: string }>)?.[0]?.text;
    if (typeof text !== "string") {
      failures++;
      console.log("FAIL — no text content in response");
      continue;
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(text);
    } catch {
      failures++;
      console.log("FAIL — content is not valid JSON");
      continue;
    }
    // glance() (cards.ts) wraps the card as { blocks: [{ type, html, height }] }.
    const glance = parsed._voiceos_glance as { blocks?: Array<{ html?: string; height?: number }> } | undefined;
    const block = glance?.blocks?.[0];
    if (!block || typeof block.html !== "string" || !block.html.length || typeof block.height !== "number") {
      failures++;
      console.log(`FAIL — missing or malformed _voiceos_glance card`);
      continue;
    }
    console.log(`ok — JSON keys: ${Object.keys(parsed).join(", ")} · card ${block.height}px, ${block.html.length}b`);
  } catch (error) {
    failures++;
    console.log(`THREW — ${error instanceof Error ? error.message : error}`);
  }
}

await client.close();

if (failures) {
  console.log(`\n${failures}/${readTools.length} read handler(s) failed.`);
  process.exit(1);
}
console.log(`\nall ${readTools.length} read handlers returned valid JSON + card ✓`);

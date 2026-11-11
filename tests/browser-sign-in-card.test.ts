import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import manifest from "../voiceos.integration.json";
import { z } from "zod";

test("signed-out sign-in and roster shortcuts return a renderable sign-in card", async () => {
  const home = mkdtempSync(join(tmpdir(), "grokbot-sign-in-"));
  const client = new Client({ name: "notch-test", version: "1" });
  try {
    await client.connect(new StdioClientTransport({
      command: process.execPath,
      args: [join(import.meta.dir, "../server.ts")],
      env: { HOME: home, LOCALAPPDATA: home, VOICEOS_GROKBOT_SESSION_SCOPE: "a".repeat(64) },
      stderr: "ignore",
    }));
    expect(manifest).not.toHaveProperty("setupGuide");
    const accountState = z.object({ state: z.enum(["signed_out", "pending", "connected"]) });
    for (const action of ["status", "disconnect"]) {
      const reply = await client.request({ method: "voiceos/grokbot/account", params: { action } }, accountState);
      expect(reply).toEqual({ state: "signed_out" });
    }
    for (const phrase of ["Sign in to Grok Bot", "Can you sign in to Grok Bot", "Show my bots", "Show all my bots"]) {
      const intent = manifest.intents.find(i => i.utterances.en.includes(phrase));
      expect(intent).toBeDefined();
      const reply = await client.callTool({ name: intent!.tool, arguments: {} });
      expect(reply.isError).not.toBe(true);
      const item = (reply.content as Array<{ type: string; text: string }>)[0];
      const body = JSON.parse(item.text);
      expect(body.ok).not.toBe(false);
      expect(body.needsSetup).toBe(true);
      const card = body._voiceos_glance.blocks[0];
      expect(card.type).toBe("widget");
      expect(card.html).toContain('"browserLogin":true');
      expect(card.html).toContain("Sign in to Grok Bot</button>");
      expect(card.html).toContain('class="voiceos-mk"');
      expect(card.html).not.toContain('class="hero"');
      expect(card.html).not.toContain('class="acct"');
    }
  } finally {
    await client.close();
    rmSync(home, { recursive: true, force: true });
  }
});

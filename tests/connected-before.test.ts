import { expect, mock, test } from "bun:test";
import * as childProcess from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { createCipheriv, pbkdf2Sync } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

// VOS-1616. A user who connected once kept getting the first-run Connect card
// whenever the session broke, and "Grok Bot help" opened on the setup steps.
// Once a connection has worked on this Mac, neither may happen. This file loads
// server.src.ts with a fake MCP server and must run in its own process
// (bun run test), like tests/reconnect-gate.test.ts.

const home = mkdtempSync(join(tmpdir(), "grokbot-home-"));
const appDir = join(home, "Library/Application Support/Grok Bot");
mkdirSync(appDir, { recursive: true });
mkdirSync(join(home, "Library/Application Support/VoiceOS Grok Bot"), { recursive: true });
const port = 40000 + Math.floor(Math.random() * 20000);
const aesKey = pbkdf2Sync("k", "saltysalt", 1003, 16, "sha1");
const cipher = createCipheriv("aes-128-cbc", aesKey, Buffer.alloc(16, 0x20));
const plain = JSON.stringify({ baseUrl: `http://127.0.0.1:${port}`, token: "secret-token" });
const encrypted = Buffer.concat([Buffer.from("v10"), cipher.update(plain, "utf8"), cipher.final()]).toString("base64");
writeFileSync(join(appDir, "gateway-descriptor.json"), JSON.stringify({ version: 3, entries: { acct: { savedAtMs: Date.now(), encrypted } } }));
writeFileSync(join(appDir, "desktop-status.json"), JSON.stringify({ version: 1, pid: process.pid, signedIn: true }));
writeFileSync(join(home, "Library/Application Support/VoiceOS Grok Bot/connected.json"), JSON.stringify({ version: 1, atMs: 1 }));
process.env.HOME = home;

// The gateway: first it refuses every token, then it answers with one bot.
let refuse = true;
Bun.serve({ port, fetch: () => refuse ? new Response("", { status: 401 }) : Response.json([{ id: "p", name: "Piper" }]) });

const handlers = new Map<string, (args: unknown) => Promise<{ content: Array<{ type: string; text: string }> }>>();
mock.module("@modelcontextprotocol/sdk/server/mcp.js", () => ({ McpServer: class {
  server = { request: async () => ({}), setNotificationHandler() {}, setRequestHandler() {} };
  registerTool(name: string, _config: unknown, handler: (args: unknown) => Promise<never>) { handlers.set(name, handler as never); return { update() {} }; }
  tool() {}
  sendToolListChanged() {}
  async connect() {}
} }));
// The Keychain answers with the test key; nothing else may launch or quit an app.
mock.module("node:child_process", () => ({
  ...childProcess,
  execFile: (file: string, _args: unknown, options: unknown, callback?: (error: Error | null, out: string, err: string) => void) => {
    const done = callback ?? (options as typeof callback);
    if (file.endsWith("security")) done?.(null, "k\n", "");
    else done?.(Object.assign(new Error("fixture"), { code: 1 }), "", "");
    return {};
  },
}));
await import("../server.src.ts");

const call = async (tool: string, args: unknown = {}) => JSON.parse((await handlers.get(tool)!(args)).content[0].text);

test("a rejected session after a past connection shows the Reconnect card, not setup", async () => {
  const body = await call("grokbot_list");
  expect(body.needsSetup).toBeUndefined();
  expect(body.needsReconnect).toBe(true);
});

test("help after a past connection never opens on the setup steps, even when the roster fails", async () => {
  const body = await call("grokbot_help");
  expect(body.message).not.toContain("Next step");
  expect(body._voiceos_glance.blocks[0].html).toContain('"page":2');
});

test("help shows the bot list once the user has bots", async () => {
  refuse = false;
  const body = await call("grokbot_help");
  expect(body.message).toContain("user's bots");
  expect(body.thingsToSay.length).toBeGreaterThan(0);
  expect(body._voiceos_glance.blocks[0].html).toContain("Piper");
});

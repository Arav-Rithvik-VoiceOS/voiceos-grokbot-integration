import { test, expect } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { createCipheriv, pbkdf2Sync } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

// VOS-1672 review: a send whose bot was guessed (role match, recent chat, or
// just the main bot) never goes out. The roster opens, and the bot the user
// taps gets the message in its box. A named bot still sends at once.
function fakeGateway(sent: string[]) {
  return Bun.serve({
    port: 0,
    async fetch(req) {
      const command = new URL(req.url).pathname.split("/").pop();
      const body = (await req.json().catch(() => ({}))) as { id?: string };
      if (command === "listAgents") return Response.json([{ id: "scout", name: "Scout" }, { id: "jerome", name: "Jerome" }]);
      if (command === "getAgentTranscriptTail") return Response.json({ entries: [] });
      if (command === "sendPrompt") { sent.push(String(body.id ?? "")); return Response.json({ accepted: true }); }
      return Response.json({});
    },
  });
}

function homeFor(port: number) {
  const home = mkdtempSync(join(tmpdir(), "grokbot-home-"));
  const appDir = join(home, "Library/Application Support/Grok Bot");
  mkdirSync(appDir, { recursive: true });
  const aesKey = pbkdf2Sync("k", "saltysalt", 1003, 16, "sha1");
  const cipher = createCipheriv("aes-128-cbc", aesKey, Buffer.alloc(16, 0x20));
  const plain = JSON.stringify({ baseUrl: `http://127.0.0.1:${port}`, token: "t" });
  const blob = Buffer.concat([Buffer.from("v10"), cipher.update(plain, "utf8"), cipher.final()]);
  writeFileSync(join(appDir, "gateway-descriptor.json"),
    JSON.stringify({ entries: { a: { savedAtMs: 1, encrypted: blob.toString("base64") } } }));
  const fakeSecurity = join(home, "security");
  writeFileSync(fakeSecurity, "#!/bin/sh\necho k\n");
  chmodSync(fakeSecurity, 0o755);
  return { home, fakeSecurity };
}

async function callSend(args: Record<string, unknown>) {
  const sent: string[] = [];
  const gw = fakeGateway(sent);
  const { home, fakeSecurity } = homeFor(gw.port);
  const child = spawn(process.execPath, [join(import.meta.dir, "../server.src.ts")], {
    env: { ...process.env, HOME: home, GROKBOT_SECURITY_BIN: fakeSecurity },
    stdio: ["pipe", "pipe", "ignore"],
  });
  try {
    let buf = "";
    child.stdout.on("data", (chunk) => { buf += chunk; });
    const waitFor = (id: number) => new Promise<void>((resolve, reject) => {
      const start = Date.now();
      const tick = () => (buf.includes(`"id":${id},`) || buf.includes(`"id":${id}}`)) ? resolve()
        : Date.now() - start > 20000 ? reject(new Error("timeout")) : setTimeout(tick, 20);
      tick();
    });
    const send = (msg: object) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
    send({ id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
    await waitFor(1);
    send({ method: "notifications/initialized" });
    send({ id: 2, method: "tools/call", params: { name: "grokbot_send", arguments: args } });
    await waitFor(2);
    const line = buf.split("\n").find((l) => l.includes('"id":2'))!;
    return { text: JSON.stringify(JSON.parse(line).result), sent };
  } finally {
    child.kill("SIGKILL");
    gw.stop(true);
  }
}

for (const routedBy of ["role", "primary"])
  test(`a send VoiceOS routed by ${routedBy} opens the roster to pick a bot and sends nothing`, async () => {
    const { text, sent } = await callSend({ recipientId: "scout", bot: "Scout", routedBy, message: "Draft the sponsor email" });
    expect(sent).toEqual([]);
    expect(text).toContain("needsBot");
    expect(text).toContain("Which bot should get this?");
    // The message rides to the roster card, ready for the bot the user taps.
    expect(text).toContain("Draft the sponsor email");
  }, 30000);

test("a named bot still sends at once", async () => {
  const { text, sent } = await callSend({ recipientId: "jerome", bot: "Jerome", routedBy: "explicit", message: "Hi" });
  expect(sent.length).toBe(1);
  expect(text).not.toContain("needsBot");
}, 30000);

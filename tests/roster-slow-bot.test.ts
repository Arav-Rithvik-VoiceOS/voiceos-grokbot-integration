import { test, expect } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { createCipheriv, pbkdf2Sync } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

// One bot whose transcript read hangs must not hold the whole card back. The
// roster card and a voice send's card preload every bot's recent messages; they
// waited for the slowest read (8 s timeout + 8 s curl retry), so a send's card
// took up to half a minute to appear. A pane with no preloaded messages fills
// itself from the live chat when opened.
function fakeGateway() {
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const command = new URL(req.url).pathname.split("/").pop();
      const body = (await req.json().catch(() => ({}))) as { id?: string };
      if (command === "listAgents") return Response.json([{ id: "fast", name: "Fast" }, { id: "slow", name: "Slow" }]);
      if (command === "getAgentTranscriptTail") {
        if (body.id === "slow") return new Promise<Response>(() => {});
        return Response.json({ entries: [] });
      }
      if (command === "sendPrompt") return Response.json({ accepted: true });
      return Response.json({});
    },
  });
  return server;
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

async function timeToolCall(name: string, args: Record<string, unknown>) {
  const gw = fakeGateway();
  const { home, fakeSecurity } = homeFor(gw.port);
  const child = spawn(process.execPath, [join(import.meta.dir, "../server.src.ts")], {
    env: { ...process.env, HOME: home, GROKBOT_SECURITY_BIN: fakeSecurity },
    stdio: ["pipe", "pipe", "ignore"],
  });
  try {
    let buf = "";
    const waitFor = (id: number) => new Promise<void>((resolve) => {
      const check = () => { if (buf.includes(`"id":${id},`) || buf.includes(`"id":${id}}`)) resolve(); };
      child.stdout.on("data", (chunk) => { buf += chunk; check(); });
      check();
    });
    const send = (msg: object) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
    send({ id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
    await waitFor(1);
    send({ method: "notifications/initialized" });
    const started = performance.now();
    send({ id: 2, method: "tools/call", params: { name, arguments: args } });
    const ms = await Promise.race([waitFor(2).then(() => performance.now() - started), new Promise<number>((r) => setTimeout(() => r(Infinity), 20000))]);
    return { ms, isError: /"id":2[,}][\s\S]*"isError":true/.test(buf) };
  } finally {
    child.kill("SIGKILL");
    gw.stop(true);
  }
}

test("the roster card does not wait for a bot whose transcript read hangs", async () => {
  const { ms, isError } = await timeToolCall("grokbot_show", {});
  expect(isError).toBe(false);
  expect(ms).toBeLessThan(4000);
}, 30000);

test("a voice send's card does not wait for another bot's hanging transcript", async () => {
  const { ms, isError } = await timeToolCall("grokbot_send", { bot: "Fast", message: "Check the build." });
  expect(isError).toBe(false);
  expect(ms).toBeLessThan(4000);
}, 30000);

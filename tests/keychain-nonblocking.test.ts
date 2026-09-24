import { test, expect } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A first-time user has not clicked "Always Allow" yet, so `security` waits on
// the macOS prompt. The boot-time intent refresh reads the Keychain; if that
// read blocks the event loop, the server cannot answer `initialize` and the
// host drops it before the user can answer the prompt.
test("a waiting Keychain prompt does not block the MCP handshake", async () => {
  const home = mkdtempSync(join(tmpdir(), "grokbot-home-"));
  const appDir = join(home, "Library/Application Support/Grok Bot");
  mkdirSync(appDir, { recursive: true });
  writeFileSync(
    join(appDir, "gateway-descriptor.json"),
    JSON.stringify({ entries: { a: { savedAtMs: 1, encrypted: "djEwAAAA" } } }),
  );
  // Stand-in for `security` stuck on the "Allow / Always Allow" prompt.
  const fakeSecurity = join(home, "security");
  writeFileSync(fakeSecurity, "#!/bin/sh\nsleep 6\nexit 1\n");
  chmodSync(fakeSecurity, 0o755);

  const child = spawn(process.execPath, [join(import.meta.dir, "../server.src.ts")], {
    env: { ...process.env, HOME: home, GROKBOT_SECURITY_BIN: fakeSecurity },
    stdio: ["pipe", "pipe", "ignore"],
  });
  try {
    const started = performance.now();
    const answered = new Promise<number>((resolve) => {
      let buf = "";
      child.stdout.on("data", (chunk) => {
        buf += chunk;
        if (buf.includes('"id":1')) resolve(performance.now() - started);
      });
    });
    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } },
      }) + "\n",
    );
    const ms = await Promise.race([answered, new Promise<number>((r) => setTimeout(() => r(Infinity), 5000))]);
    expect(ms).toBeLessThan(3000);
  } finally {
    child.kill("SIGKILL");
  }
}, 15000);

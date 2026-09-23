/** Simulate a recipient with only the share files: no sources or node_modules. */
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const root = new URL("..", import.meta.url).pathname;
const files = ["server.ts", "widgetKit.ts", "package.json", "voiceos.integration.json", "icon.png"];
const total = files.reduce((size, file) => size + statSync(join(root, file)).size, 0);
assert.ok(total <= 2 * 1024 * 1024, `Share payload too large: ${total}`);
const manifest = JSON.parse(readFileSync(join(root, "voiceos.integration.json"), "utf8"));
const recipient = mkdtempSync(join(tmpdir(), "grokbot-recipient-"));
try {
  for (const file of files) copyFileSync(join(root, file), join(recipient, file));
  for (const runtime of [process.execPath, "node"]) {
    const child = spawn(runtime, [join(recipient, "server.ts")], { cwd: recipient, stdio: ["pipe", "pipe", "pipe"] });
    let buffer = "", errors = "";
    child.stderr.on("data", chunk => { errors = (errors + chunk).slice(-2000); });
    try {
      const tools = await new Promise<any[]>((resolve, reject) => {
        const timer = setTimeout(() => reject(Error(`Bundle timed out under ${runtime}`)), 15000);
        const fail = (error: Error) => { clearTimeout(timer); reject(error); };
        child.once("error", fail);
        child.once("exit", code => fail(Error(`Bundle exited ${code}: ${errors.slice(0,1000)}`)));
        child.stdout.on("data", chunk => {
          buffer += chunk;
          let newline;
          while ((newline = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
            if (!line.trim()) continue;
            try {
              const message = JSON.parse(line);
              assert.equal(message.jsonrpc, "2.0");
              if (message.id === 1) {
                assert.ok(message.result, "Initialize failed");
                child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
                child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n");
              }
              if (message.id === 2) { clearTimeout(timer); resolve(message.result.tools); }
            } catch (error) { fail(error as Error); }
          }
        });
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
          protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "recipient-check", version: "1" },
        } }) + "\n");
      });
      assert.deepEqual(tools.map(tool => tool.name).filter(name => !name.startsWith("voiceos_hook_")).sort(), manifest.tools.map((tool: any) => tool.name).sort());
      assert.ok(tools.some(tool => tool.name === "voiceos_hook_pre_tool_use"));
      console.log(`${runtime}: standalone MCP handshake and ${tools.length} tools passed`);
    } finally { child.kill("SIGTERM"); }
  }
  console.log(`Share payload: ${total} bytes / 2097152 bytes`);
} finally { rmSync(recipient, { recursive: true, force: true }); }

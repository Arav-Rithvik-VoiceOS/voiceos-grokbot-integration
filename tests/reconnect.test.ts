import { test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, existsSync, readFileSync } from "node:fs";
import { createCipheriv, pbkdf2Sync } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reconnectCard } from "../cards.ts";

// VOS-1608: when no saved route can wake the parked cloud computer, the user
// sees one Reconnect card. Its button runs grokbot_reconnect, which restarts
// the Grok Bot app and waits for the route file the app writes on connect.

test("the Reconnect card tells the user the two steps and carries the button that runs grokbot_reconnect", () => {
  const html = (reconnectCard() as any)._voiceos_glance.blocks[0].html as string;
  expect(html).toContain("Send any message to a bot in Grok Bot");
  expect(html).toContain("Tap Reconnect");
  expect(html).toContain("invoke('grokbot_reconnect'");
  // One payload script; a stray "</script" would end it early.
  expect(html.match(/<\/script/gi)).toHaveLength(1);
  expect(html).not.toContain("__VOICEOS_DEMO__");
});

test("grokbot_reconnect quits the app, reopens it, waits for the route file, then reads the roster", () => {
  const home = mkdtempSync(join(tmpdir(), "grokbot-home-"));
  const appDir = join(home, "Library/Application Support/Grok Bot");
  mkdirSync(appDir, { recursive: true });
  const routeFile = join(appDir, "gateway-descriptor.json");
  writeFileSync(join(appDir, "desktop-status.json"), JSON.stringify({ version: 1, pid: 1, signedIn: true }));

  const port = 40000 + Math.floor(Math.random() * 20000);
  const aesKey = pbkdf2Sync("k", "saltysalt", 1003, 16, "sha1");
  const cipher = createCipheriv("aes-128-cbc", aesKey, Buffer.alloc(16, 0x20));
  const plain = JSON.stringify({ baseUrl: `http://127.0.0.1:${port}`, token: "t" });
  const blob = Buffer.concat([Buffer.from("v10"), cipher.update(plain, "utf8"), cipher.final()]);
  const pendingRoute = join(home, "route-after-relaunch.json");
  writeFileSync(pendingRoute, JSON.stringify({ version: 3, entries: { a: { savedAtMs: Date.now(), encrypted: blob.toString("base64") } } }));

  const log = join(home, "calls.log");
  const bin = (name: string, body: string) => {
    const path = join(home, name);
    writeFileSync(path, `#!/bin/sh\necho ${name} "$@" >> ${JSON.stringify(log)}\n${body}\n`);
    chmodSync(path, 0o755);
    return path;
  };
  const env = {
    ...process.env,
    HOME: home,
    GROKBOT_SECURITY_BIN: bin("security", "echo k"),
    GROKBOT_OSASCRIPT_BIN: bin("osascript", "exit 0"),
    GROKBOT_PGREP_BIN: bin("pgrep", "exit 1"), // no Grok Bot process is running
    // "Relaunching" the app: it connects to its awake box and writes the route file a moment later.
    GROKBOT_OPEN_BIN: bin("open", `(sleep 1; cp ${JSON.stringify(pendingRoute)} ${JSON.stringify(routeFile)}) &`),
  };

  const script = join(home, "probe.ts");
  writeFileSync(script, `
    import { reconnectGrokBot } from ${JSON.stringify(join(import.meta.dir, "../client.ts"))};
    Bun.serve({ port: ${port}, fetch: () => Response.json([{ id: "p", name: "Piper" }]) });
    const started = performance.now();
    const outcome = await reconnectGrokBot().catch(e => ({ kind: e.kind, message: e.message }));
    console.log(JSON.stringify({ outcome, ms: Math.round(performance.now() - started) }));
    process.exit(0);
  `);
  expect(existsSync(routeFile)).toBe(false);
  const child = spawnSync(process.execPath, [script], { env, encoding: "utf8", timeout: 30000 });
  const { outcome, ms } = JSON.parse(child.stdout.trim().split("\n").pop()!);
  expect(outcome).toEqual({ bots: 1 });
  expect(ms).toBeLessThan(10000);
  const calls = readFileSync(log, "utf8");
  expect(calls).toMatch(/^osascript -e quit app "Grok Bot"$/m);
  expect(calls.indexOf("osascript")).toBeLessThan(calls.indexOf("open -a Grok Bot"));
  expect(existsSync(routeFile)).toBe(true);
}, 40000);

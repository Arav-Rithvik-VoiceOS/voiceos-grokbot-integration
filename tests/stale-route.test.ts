import { test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { createCipheriv, pbkdf2Sync } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Seen 2026-11-01 on Grok Bot 0.78.1: the app moved its cloud computer and kept
// the new route in memory only, so the route file on disk pointed at a box the
// proxy no longer knew. Every command answered a bare 404 and the user saw
// "Grok Bot returned an error" with nothing to do. That state is the Reconnect
// card's job: wake the box in Grok Bot, then reconnect.
test("a bare 404 from the proxy is a stale route: the Reconnect card, not a dead end", () => {
  const home = mkdtempSync(join(tmpdir(), "grokbot-home-"));
  const appDir = join(home, "Library/Application Support/Grok Bot");
  mkdirSync(appDir, { recursive: true });

  const port = 40000 + Math.floor(Math.random() * 20000);
  const aesKey = pbkdf2Sync("k", "saltysalt", 1003, 16, "sha1");
  const cipher = createCipheriv("aes-128-cbc", aesKey, Buffer.alloc(16, 0x20));
  const plain = JSON.stringify({ baseUrl: `http://127.0.0.1:${port}`, token: "t" });
  const blob = Buffer.concat([Buffer.from("v10"), cipher.update(plain, "utf8"), cipher.final()]);
  writeFileSync(join(appDir, "gateway-descriptor.json"),
    JSON.stringify({ entries: { a: { savedAtMs: 1, encrypted: blob.toString("base64") } } }));
  const fakeSecurity = join(home, "security");
  writeFileSync(fakeSecurity, "#!/bin/sh\necho k\n");
  chmodSync(fakeSecurity, 0o755);

  const script = join(home, "probe.ts");
  writeFileSync(script, `
    import { gateway } from ${JSON.stringify(join(import.meta.dir, "../client.ts"))};
    // The proxy knows no box at this route: every command is an empty 404. A
    // 404 that names what is missing stays "not found" (a bot that was deleted).
    Bun.serve({ port: ${port}, fetch: req => new URL(req.url).pathname.endsWith("/getAgentAvatar")
      ? Response.json({ error: "agent does not exist" }, { status: 404 })
      : new Response("", { status: 404 }) });
    const stale = await gateway("listAgents", {}).catch(e => ({ kind: e.kind, message: e.message }));
    const missing = await gateway("getAgentAvatar", { id: "x" }).catch(e => ({ kind: e.kind, message: e.message }));
    console.log(JSON.stringify({ stale, missing }));
    process.exit(0);
  `);
  const run = spawnSync(process.execPath, [script], {
    env: { ...process.env, HOME: home, GROKBOT_SECURITY_BIN: fakeSecurity },
    encoding: "utf8",
    timeout: 20000,
  });
  const { stale, missing } = JSON.parse(run.stdout.trim().split("\n").pop()!);
  expect(stale.kind).toBe("reconnect");
  expect(stale.message).toContain("Reconnect");
  expect(missing.kind).toBe("not_found");
}, 25000);

import { test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { createCipheriv, pbkdf2Sync } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Seen 2026-09-29: the notch screen said "computer is not running right now"
// while a bot worked, until the Grok Bot app itself opened the screen. A bot's
// box sits "absent" until someone asks the gateway to boot it, and the app does
// that with ensureForeverBox when its screen opens. Opening the screen here
// must do the same; a background probe must not, or it boots boxes nobody asked for.
test("opening a screen boots an absent box; a background probe does not", () => {
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
    import { agentScreen, withoutWaking } from ${JSON.stringify(join(import.meta.dir, "../client.ts"))};
    const calls: string[] = [];
    Bun.serve({ port: ${port}, fetch: req => {
      calls.push(new URL(req.url).pathname.split("/").pop()!);
      return Response.json({ agentId: "p", state: "absent", vncUrl: null });
    } });
    await agentScreen("p", 300);
    const user = calls.splice(0);
    await withoutWaking(() => agentScreen("p", 300));
    const background = calls.splice(0);
    console.log(JSON.stringify({ user, background }));
    process.exit(0);
  `);
  const run = spawnSync(process.execPath, [script], {
    env: { ...process.env, HOME: home, GROKBOT_SECURITY_BIN: fakeSecurity },
    encoding: "utf8",
    timeout: 20000,
  });
  const { user, background } = JSON.parse(run.stdout.trim().split("\n").pop()!);
  expect(user).toEqual(["getForeverBoxStatus", "ensureForeverBox"]);
  expect(background).toEqual(["getForeverBoxStatus"]);
}, 25000);

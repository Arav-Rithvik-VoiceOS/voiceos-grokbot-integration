import { test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { createCipheriv, pbkdf2Sync } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

// On a slow network a gateway read times out and gateway() retries it with
// curl. A sync curl froze the whole server: every other tool call and card
// poll waited, and a roster read of N bots ran its N curls one after another
// (a 28 s "Show my bots", a send card that took half a minute to appear).
test("a gateway curl fallback does not block the event loop", () => {
  const home = mkdtempSync(join(tmpdir(), "grokbot-home-"));
  const appDir = join(home, "Library/Application Support/Grok Bot");
  mkdirSync(appDir, { recursive: true });

  // A descriptor the client can decrypt, pointing at a gateway that never answers.
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

  // Three parallel reads, as the roster does. Each fetch times out after 1 s,
  // then falls back to curl (--max-time 1). Measure the longest event-loop gap.
  const script = join(home, "probe.ts");
  writeFileSync(script, `
    import { gateway } from ${JSON.stringify(join(import.meta.dir, "../client.ts"))};
    Bun.serve({ port: ${port}, fetch: () => new Promise(() => {}) });
    let last = performance.now(), gap = 0;
    const tick = setInterval(() => { const n = performance.now(); gap = Math.max(gap, n - last); last = n; }, 20);
    const started = performance.now();
    await Promise.all([1, 2, 3].map(() => gateway("getTranscript", {}, { timeoutMs: 1000 }).catch(() => {})));
    clearInterval(tick);
    console.log(JSON.stringify({ gap: Math.round(gap), total: Math.round(performance.now() - started) }));
    process.exit(0);
  `);
  const run = spawnSync(process.execPath, [script], {
    env: { ...process.env, HOME: home, GROKBOT_SECURITY_BIN: fakeSecurity },
    encoding: "utf8",
    timeout: 20000,
  });
  const { gap, total } = JSON.parse(run.stdout.trim().split("\n").pop()!);
  // Sync curl: a ~1 s freeze per call, and the three curls run in series (~4 s).
  expect(gap).toBeLessThan(500);
  expect(total).toBeLessThan(3000);
}, 25000);

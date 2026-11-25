import { test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, existsSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { createCipheriv, pbkdf2Sync } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

// VOS-1608. The Grok Bot app deletes its route file (gateway-descriptor.json)
// the moment its cloud box parks, and does not write it again until the app
// is relaunched while the box is awake. VoiceOS's own copy of the route lived
// only in the integration server's memory, so a VoiceOS restart after a park
// left no route at all: "Grok Bot's local connection is off". Verified live on
// 2026-10-28: a saved copy plus the wake headers woke a parked box in 7 s.
//
// This test runs the real client in real processes against a real HOME dir.
test("a VoiceOS restart after the app parked its box still wakes it from the saved route copy", () => {
  const home = mkdtempSync(join(tmpdir(), "grokbot-home-"));
  const appDir = join(home, "Library/Application Support/Grok Bot");
  mkdirSync(appDir, { recursive: true });
  const routeFile = join(appDir, "gateway-descriptor.json");
  const copyFile = join(home, "Library/Application Support/VoiceOS Grok Bot/route.json");

  const port = 40000 + Math.floor(Math.random() * 20000);
  // The app stamps its entry with the time it saved it; the copy expires 7 days after that.
  const savedAtMs = Date.now() - 60_000;
  const aesKey = pbkdf2Sync("k", "saltysalt", 1003, 16, "sha1");
  const cipher = createCipheriv("aes-128-cbc", aesKey, Buffer.alloc(16, 0x20));
  const plain = JSON.stringify({ baseUrl: `http://127.0.0.1:${port}`, token: "secret-token" });
  const blob = Buffer.concat([Buffer.from("v10"), cipher.update(plain, "utf8"), cipher.final()]);
  const encrypted = blob.toString("base64");
  writeFileSync(routeFile, JSON.stringify({ version: 3, entries: { acct: { savedAtMs, encrypted } } }));
  writeFileSync(join(appDir, "desktop-status.json"), JSON.stringify({ version: 1, pid: 1, signedIn: true }));
  const fakeSecurity = join(home, "security");
  writeFileSync(fakeSecurity, "#!/bin/sh\necho k\n");
  chmodSync(fakeSecurity, 0o755);
  // Opening the real Grok Bot app from a test is never acceptable: count instead.
  const fakeOpen = join(home, "open");
  const opensLog = join(home, "opens.log");
  writeFileSync(fakeOpen, `#!/bin/sh\necho opened >> ${JSON.stringify(opensLog)}\n`);
  chmodSync(fakeOpen, 0o755);

  const script = join(home, "probe.ts");
  writeFileSync(script, `
    import { gateway } from ${JSON.stringify(join(import.meta.dir, "../client.ts"))};
    // A parked box: 417 unless the request carries the proxy's resume window.
    let wakes = 0;
    Bun.serve({ port: ${port}, fetch: req =>
      req.headers.get("x-anyrun-hibernation-lower-bound-s") === "900"
        ? (wakes++, Response.json([{ id: "p", name: "Piper" }]))
        : new Response("", { status: 417 }) });
    const started = performance.now();
    const outcome = await gateway("listAgents", {}).catch(e => ({ kind: e.kind, message: e.message }));
    console.log(JSON.stringify({ outcome, wakes, ms: Math.round(performance.now() - started) }));
    process.exit(0);
  `);
  const env = { ...process.env, HOME: home, GROKBOT_SECURITY_BIN: fakeSecurity, GROKBOT_OPEN_BIN: fakeOpen };
  const run = () => {
    const child = spawnSync(process.execPath, [script], { env, encoding: "utf8", timeout: 30000 });
    return { ...JSON.parse(child.stdout.trim().split("\n").pop()!), stderr: child.stderr };
  };

  // 1. Normal day: the app's file is there. The request works and a copy is saved.
  const first = run();
  expect(first.outcome).toEqual([{ id: "p", name: "Piper" }]);
  expect(existsSync(copyFile)).toBe(true);
  expect(statSync(copyFile).mode & 0o777).toBe(0o600);
  const copy = JSON.parse(readFileSync(copyFile, "utf8"));
  expect(copy).toMatchObject({ version: 1, account: "acct", savedAtMs, encrypted });
  expect(readFileSync(copyFile, "utf8")).not.toContain("secret-token");

  // 2. The box parks; the app deletes its file; VoiceOS restarts (a new process).
  unlinkSync(routeFile);
  const second = run();
  expect(second.outcome).toEqual([{ id: "p", name: "Piper" }]);
  expect(second.wakes).toBe(1);
  expect(existsSync(opensLog)).toBe(false);
  expect(second.stderr).toContain("saved route");
  expect(second.stderr).not.toContain("secret-token");
  expect(second.ms).toBeLessThan(5000); // no 5 s "open the app and wait" detour

  // 3. The app has written a fresh file again: it always wins over the copy.
  const cipher2 = createCipheriv("aes-128-cbc", aesKey, Buffer.alloc(16, 0x20));
  const blob2 = Buffer.concat([Buffer.from("v10"), cipher2.update(plain, "utf8"), cipher2.final()]);
  writeFileSync(routeFile, JSON.stringify({ version: 3, entries: { acct: { savedAtMs: savedAtMs + 5000, encrypted: blob2.toString("base64") } } }));
  const third = run();
  expect(third.outcome).toEqual([{ id: "p", name: "Piper" }]);
  expect(JSON.parse(readFileSync(copyFile, "utf8")).savedAtMs).toBe(savedAtMs + 5000);
}, 60000);

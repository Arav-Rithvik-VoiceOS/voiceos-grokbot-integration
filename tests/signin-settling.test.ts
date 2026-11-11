import { test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { createCipheriv, createHash, pbkdf2Sync } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

// VOS-1616. Grok Bot writes `signedIn: false` as it launches, until its auth
// settles. The client read that as a sign-out: it deleted the saved route copy
// and showed the setup card to a user who had connected fine. These tests run
// the real client in a real process against a real HOME dir, like
// tests/gateway-route-copy.test.ts.

const ACCOUNT_SLOT = "auth0|user_test";
const ACCOUNT = createHash("sha256").update(ACCOUNT_SLOT).digest("hex");
const SLOT_FILE = "onqw4zbomnwgszlooqxhg3djmnss4y3mnfsw45bnnvsxiyjomfrwg33vnz2c243mn52a.blob";

/** A HOME where the app parked its box: no route file, only VoiceOS's copy. */
function parkedHome(status: Record<string, unknown>, slot?: string) {
  const home = mkdtempSync(join(tmpdir(), "grokbot-home-"));
  const appDir = join(home, "Library/Application Support/Grok Bot");
  const copyDir = join(home, "Library/Application Support/VoiceOS Grok Bot");
  mkdirSync(join(appDir, "sand-client-persistence"), { recursive: true });
  mkdirSync(copyDir, { recursive: true });
  const port = 40000 + Math.floor(Math.random() * 20000);
  const aesKey = pbkdf2Sync("k", "saltysalt", 1003, 16, "sha1");
  const cipher = createCipheriv("aes-128-cbc", aesKey, Buffer.alloc(16, 0x20));
  const plain = JSON.stringify({ baseUrl: `http://127.0.0.1:${port}`, token: "secret-token" });
  const encrypted = Buffer.concat([Buffer.from("v10"), cipher.update(plain, "utf8"), cipher.final()]).toString("base64");
  const copyFile = join(copyDir, "route.json");
  writeFileSync(copyFile, JSON.stringify({ version: 1, account: ACCOUNT, savedAtMs: Date.now() - 60_000, encrypted }));
  writeFileSync(join(appDir, "desktop-status.json"), JSON.stringify({ version: 1, ...status }));
  if (slot) writeFileSync(join(appDir, "sand-client-persistence", SLOT_FILE), JSON.stringify({ schemaVersion: 1, value: slot }));
  const fakeSecurity = join(home, "security");
  writeFileSync(fakeSecurity, "#!/bin/sh\necho k\n");
  chmodSync(fakeSecurity, 0o755);
  // Opening the real Grok Bot app from a test is never acceptable.
  const fakeOpen = join(home, "open");
  writeFileSync(fakeOpen, "#!/bin/sh\nexit 0\n");
  chmodSync(fakeOpen, 0o755);

  const script = join(home, "probe.ts");
  writeFileSync(script, `
    import { gateway } from ${JSON.stringify(join(import.meta.dir, "../client.ts"))};
    Bun.serve({ port: ${port}, fetch: () => Response.json([{ id: "p", name: "Piper" }]) });
    const outcome = await gateway("listAgents", {}).catch(e => ({ kind: e.kind, message: e.message }));
    console.log(JSON.stringify({ outcome }));
    process.exit(0);
  `);
  const run = () => {
    const env = { ...process.env, HOME: home, GROKBOT_SECURITY_BIN: fakeSecurity, GROKBOT_OPEN_BIN: fakeOpen };
    const child = spawnSync(process.execPath, [script], { env, encoding: "utf8", timeout: 30000 });
    return { ...JSON.parse(child.stdout.trim().split("\n").pop()!), stderr: child.stderr as string };
  };
  return { run, copyFile, connectedFile: join(copyDir, "connected.json") };
}

test("a signed-out marker from an app that just launched keeps the saved route and connects", () => {
  // This test's own process stands in for the running app.
  const home = parkedHome({ pid: process.pid, startedAtMs: Date.now(), signedIn: false }, ACCOUNT_SLOT);
  const { outcome } = home.run();
  expect(outcome).toEqual([{ id: "p", name: "Piper" }]);
  expect(existsSync(home.copyFile)).toBe(true);
  expect(existsSync(home.connectedFile)).toBe(true);
}, 60000);

test("a settled signed-out marker is still a real sign-out", () => {
  const home = parkedHome({ pid: process.pid, startedAtMs: Date.now() - 5 * 60_000, signedIn: false });
  const { outcome } = home.run();
  expect(outcome.kind).toBe("setup");
  expect(existsSync(home.copyFile)).toBe(false);
  expect(existsSync(home.connectedFile)).toBe(false);
}, 60000);

test("a signed-out marker from an app that is no longer running is a real sign-out", () => {
  // pid 2^22 + 1 is above macOS's pid range, so no process has it.
  const home = parkedHome({ pid: 4194305, startedAtMs: Date.now(), signedIn: false });
  expect(home.run().outcome.kind).toBe("setup");
  expect(existsSync(home.copyFile)).toBe(false);
}, 60000);

test("the saved route is not used once the app is signed in to a different account", () => {
  const home = parkedHome({ pid: process.pid, signedIn: true }, "auth0|someone_else");
  const { outcome, stderr } = home.run();
  expect(Array.isArray(outcome)).toBe(false);
  expect(stderr).toContain("different account");
  expect(existsSync(home.copyFile)).toBe(false);
}, 60000);

test("the saved route is used when the app names the same account", () => {
  const home = parkedHome({ pid: process.pid, signedIn: true }, ACCOUNT_SLOT);
  expect(home.run().outcome).toEqual([{ id: "p", name: "Piper" }]);
  expect(existsSync(home.copyFile)).toBe(true);
}, 60000);

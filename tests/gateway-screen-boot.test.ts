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
  // The boot runs alongside status polls, so more status reads may follow it.
  expect(user.slice(0, 2)).toEqual(["getForeverBoxStatus", "ensureForeverBox"]);
  expect(user.slice(2).every((c: string) => c === "getForeverBoxStatus")).toBe(true);
  expect(background).toEqual(["getForeverBoxStatus"]);
}, 25000);

// Seen 2026-10-02: the screen pane sat on "Connecting…" for ~30 s, then said
// Pepper's computer was not running. The pod was parked, so ensureForeverBox
// took longer than its 15 s timeout (then a curl retry waited 15 s more), yet
// the box came up seconds later. Like the app, keep polling the box status
// while the boot runs, and hand back the desktop as soon as it appears.
test("opening a screen returns the desktop once the box comes up, even while ensureForeverBox is still running", () => {
  const home = mkdtempSync(join(tmpdir(), "grokbot-home-"));
  const appDir = join(home, "Library/Application Support/Grok Bot");
  mkdirSync(appDir, { recursive: true });

  const port = 40000 + Math.floor(Math.random() * 20000);
  const aesKey = pbkdf2Sync("k", "saltysalt", 1003, 16, "sha1");
  const cipher = createCipheriv("aes-128-cbc", aesKey, Buffer.alloc(16, 0x20));
  const plain = JSON.stringify({
    baseUrl: `http://127.0.0.1:${port}`,
    token: "t",
    vncProxy: { primaryUrl: "https://pod-7.cursorvm.com/vnc.html?port_token=p&path=websockify%3Fport_token%3Dp" },
  });
  const blob = Buffer.concat([Buffer.from("v10"), cipher.update(plain, "utf8"), cipher.final()]);
  writeFileSync(join(appDir, "gateway-descriptor.json"),
    JSON.stringify({ entries: { a: { savedAtMs: 1, encrypted: blob.toString("base64") } } }));
  const fakeSecurity = join(home, "security");
  writeFileSync(fakeSecurity, "#!/bin/sh\necho k\n");
  chmodSync(fakeSecurity, 0o755);

  const script = join(home, "probe.ts");
  writeFileSync(script, `
    import { agentScreen } from ${JSON.stringify(join(import.meta.dir, "../client.ts"))};
    const started = Date.now();
    const up = () => Date.now() - started > 2000;
    Bun.serve({ port: ${port}, idleTimeout: 60, fetch: async req => {
      const cmd = new URL(req.url).pathname.split("/").pop();
      if (cmd === "ensureForeverBox") await Bun.sleep(40000); // a parked pod: the reply is slow
      return Response.json(up()
        ? { agentId: "p", state: "running", vncUrl: "http://127.0.0.1:6080/vnc.html" }
        : { agentId: "p", state: "absent", vncUrl: null });
    } });
    const r = await agentScreen("p", 300);
    console.log(JSON.stringify({ ms: Date.now() - started, wsUrl: r.wsUrl ?? null, boxState: r.boxState }));
    process.exit(0);
  `);
  const run = spawnSync(process.execPath, [script], {
    env: { ...process.env, HOME: home, GROKBOT_SECURITY_BIN: fakeSecurity },
    encoding: "utf8",
    timeout: 60000,
  });
  const out = JSON.parse(run.stdout.trim().split("\n").pop()!);
  expect(out.wsUrl).toBe("wss://pod-7.cursorvm.com/websockify?port_token=p");
  expect(out.boxState).toBe("running");
  expect(out.ms).toBeLessThan(10000);
}, 65000);

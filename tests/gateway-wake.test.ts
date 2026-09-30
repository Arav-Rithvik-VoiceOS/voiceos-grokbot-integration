import { test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { createCipheriv, pbkdf2Sync } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The Grok Bot app parks (hibernates) its cloud box while the user seems away,
// and the box answers 417 until a request asks the proxy to wake it. Seen
// 2026-09-29: every voice send was blocked. A call the user started wakes the
// box; a background poll must not, or it keeps the box on for good.
test("user calls wake a parked box; background polls do not, and fail as parked", () => {
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
    import { gateway, withoutWaking } from ${JSON.stringify(join(import.meta.dir, "../client.ts"))};
    // A parked box: 417 unless the request carries the proxy's resume window.
    Bun.serve({ port: ${port}, fetch: req =>
      req.headers.get("x-anyrun-hibernation-lower-bound-s") === "900" &&
      req.headers.get("x-anyrun-hibernation-upper-bound-s") === "18000"
        ? Response.json([{ id: "p", name: "Piper" }])
        : new Response("", { status: 417 }) });
    const user = await gateway("listAgents", {});
    const background = await withoutWaking(() => gateway("listAgents", {})).catch(e => ({ kind: e.kind, message: e.message }));
    console.log(JSON.stringify({ user, background }));
    process.exit(0);
  `);
  const run = spawnSync(process.execPath, [script], {
    env: { ...process.env, HOME: home, GROKBOT_SECURITY_BIN: fakeSecurity },
    encoding: "utf8",
    timeout: 20000,
  });
  const { user, background } = JSON.parse(run.stdout.trim().split("\n").pop()!);
  expect(user).toEqual([{ id: "p", name: "Piper" }]);
  expect(background.kind).toBe("parked");
  expect(background.message).toContain("asleep");
}, 25000);

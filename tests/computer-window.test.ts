import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { gzipSync } from "node:zlib";

const modulePath = "../computerWindow.ts";
const computerWindow = await import(modulePath).catch(() => ({} as Record<string, unknown>));

test("desktop websocket validation is part of the computer-window boundary", () => {
  expect(typeof computerWindow.validateDesktopWebSocketUrl).toBe("function");
});

test("desktop websocket validation accepts the trusted websockify shape", () => {
  const raw = "wss://pod-7.cursorvm.com/websockify?token=5&network_token=secret&resume_lower_s=900";
  expect(computerWindow.validateDesktopWebSocketUrl(raw)).toBe(raw);
});

test("desktop websocket validation rejects non-TLS, private, credentialed, and malformed targets", () => {
  const invalid = [
    "ws://pod-7.cursorvm.com/websockify?token=5&network_token=secret",
    "https://pod-7.cursorvm.com/websockify?token=5&network_token=secret",
    "wss://localhost/websockify?token=5&network_token=secret",
    "wss://127.0.0.1/websockify?token=5&network_token=secret",
    "wss://cursorvm.com.evil.test/websockify?token=5&network_token=secret",
    "wss://user:pass@pod-7.cursorvm.com/websockify?token=5&network_token=secret",
    "wss://pod-7.cursorvm.com:8443/websockify?token=5&network_token=secret",
    "wss://pod-7.cursorvm.com/not-websockify?token=5&network_token=secret",
    "wss://pod-7.cursorvm.com/websockify?network_token=secret",
    "wss://pod-7.cursorvm.com/websockify?token=5",
    "wss://pod-7.cursorvm.com/websockify?token=5&token=6&network_token=secret",
    "not a url",
  ];

  for (const raw of invalid) {
    expect(() => computerWindow.validateDesktopWebSocketUrl(raw)).toThrow("Desktop connection is unavailable");
  }
});

test("the self-contained viewer document allowlists only the validated socket origin and excludes its credential", () => {
  const template = [
    `<meta http-equiv="Content-Security-Policy" content="connect-src __VOICEOS_CSP_CONNECT__; script-src 'nonce-__VOICEOS_NONCE__'">`,
    `<script nonce="__VOICEOS_NONCE__">__VOICEOS_RFB_SOURCE__</script>`,
  ].join("\n");
  const bundle = gzipSync("class f{};export{f as default};").toString("base64");
  const wsUrl = "wss://pod-7.cursorvm.com/websockify?token=5&network_token=top-secret";

  const html = computerWindow.buildViewerDocument(template, bundle, wsUrl, "fixed-nonce");

  expect(html).toContain("connect-src wss://pod-7.cursorvm.com");
  expect(html).toContain('nonce="fixed-nonce"');
  expect(html).toContain("window.VoiceOSRFB=f");
  expect(html).not.toContain("top-secret");
  expect(html).not.toMatch(/__VOICEOS_[A-Z_]+__/);
});

test("viewer bundling preserves JavaScript replacement tokens without recreating HTML placeholders", () => {
  const template = `<script nonce="__VOICEOS_NONCE__">__VOICEOS_RFB_SOURCE__</script>`;
  const bundle = gzipSync(`const replacementToken="$&";class f{};export{f as default};`).toString("base64");
  const html = computerWindow.buildViewerDocument(
    template,
    bundle,
    "wss://pod.cursorvm.com/websockify?token=5&network_token=secret",
    "fixed-nonce",
  );
  expect(html).toContain('replacementToken="$&"');
  expect(html).not.toContain("__VOICEOS_RFB_SOURCE__");
});

test("the standalone viewer page exists", () => {
  expect(existsSync(new URL("../widgets/computer.html", import.meta.url))).toBe(true);
});

test("the native WKWebView host source exists", () => {
  expect(existsSync(new URL("../native/ComputerViewer.swift", import.meta.url))).toBe(true);
});

test("the native WKWebView host compiles without an app project", () => {
  const scratch = mkdtempSync(join(tmpdir(), "grokbot-viewer-test-"));
  try {
    const result = spawnSync(
      "/usr/bin/swiftc",
      ["-parse-as-library", new URL("../native/ComputerViewer.swift", import.meta.url).pathname, "-framework", "AppKit", "-framework", "WebKit", "-o", join(scratch, "ComputerViewer")],
      { encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(0);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("the bundled native host is materialized in a private unpredictable directory", () => {
  const scratch = mkdtempSync(join(tmpdir(), "grokbot-viewer-materialize-test-"));
  try {
    const binary = computerWindow.materializeViewerHost(scratch);
    expect(existsSync(binary)).toBe(true);
    expect(statSync(binary).mode & 0o777).toBe(0o700);
    expect(statSync(dirname(binary)).mode & 0o777).toBe(0o700);
    expect(binary).not.toContain("token");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("opening a computer window is exposed as a native-host operation", () => {
  expect(typeof computerWindow.openComputerWindow).toBe("function");
});

test("the native host independently rejects an unsafe socket before creating a viewer", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "grokbot-viewer-protocol-test-"));
  const binary = computerWindow.materializeViewerHost(scratch);
  const child = spawn(binary, [], { stdio: ["pipe", "pipe", "ignore"] });
  try {
    const response = new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("native host did not answer")), 5_000);
      child.stdout.setEncoding("utf8");
      child.stdout.once("data", chunk => {
        clearTimeout(timer);
        resolve(JSON.parse(String(chunk).trim()));
      });
      child.once("error", reject);
    });
    child.stdin.write(`${JSON.stringify({
      requestId: "unsafe-test",
      botId: "pepper-id",
      botName: "Pepper",
      wsUrl: "ws://127.0.0.1/websockify?token=5&network_token=secret",
      html: "<html></html>",
    })}\n`);
    expect(await response).toEqual({
      requestId: "unsafe-test",
      status: "error",
      message: "The desktop connection was rejected for safety.",
    });
  } finally {
    child.kill("SIGTERM");
    rmSync(scratch, { recursive: true, force: true });
  }
});

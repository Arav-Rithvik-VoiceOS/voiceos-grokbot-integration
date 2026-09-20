import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { chmodSync, lstatSync, mkdtempSync, readdirSync, rmSync, writeFileSync, type Dirent } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { COMPUTER_VIEWER_BINARY_B64, RFB_B64, WIDGETS } from "./assets.generated.ts";

const VIEWER_TEMP_PREFIX = "voiceos-grokbot-viewer-";

/**
 * Security and native-window boundary for the enlarged, view-only computer.
 * Credentials enter this module only in memory and are never placed in a URL
 * visible to the user, a filename, a log message, or a persistent web store.
 */
export function validateDesktopWebSocketUrl(raw: string): string {
  const fail = () => {
    throw new Error("Desktop connection is unavailable. Reopen the computer window to try again.");
  };

  if (!raw || raw !== raw.trim()) return fail();

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return fail();
  }

  const host = url.hostname.toLowerCase();
  const trustedHost = host === "cursorvm.com" || host.endsWith(".cursorvm.com");
  const token = url.searchParams.getAll("token");
  const networkToken = url.searchParams.getAll("network_token");
  if (
    url.protocol !== "wss:" ||
    !trustedHost ||
    Boolean(url.username || url.password) ||
    (url.port !== "" && url.port !== "443") ||
    url.pathname !== "/websockify" ||
    Boolean(url.hash) ||
    token.length !== 1 ||
    !token[0] ||
    networkToken.length !== 1 ||
    !networkToken[0]
  ) {
    return fail();
  }

  return raw;
}

/**
 * Inflate the gzip+base64 noVNC client on the host and inject its source into
 * the viewer's single inline module. The bundle uses top-level await, so it must
 * run as a module — and computer.html keeps the boot code in that SAME module so
 * it runs only after the await settles, without a blob: URL import (WKWebView
 * blocks importing a blob: module in an opaque-origin, baseURL-nil document — the
 * bug that left the window on "The viewer could not start"). The bundle's
 * `export default` becomes a module-scoped `VoiceOSRFB`. The CSP carries only the
 * validated socket origin; the bearer-token query is never written into the
 * document, and the page never fetches anything from the pod.
 */
export function buildViewerDocument(
  template: string,
  compressedRfbBase64: string,
  wsUrl: string,
  nonce = randomBytes(18).toString("base64url"),
): string {
  validateDesktopWebSocketUrl(wsUrl);
  const socketOrigin = new URL(wsUrl).origin;

  let rfbSource: string;
  try {
    rfbSource = gunzipSync(Buffer.from(compressedRfbBase64, "base64")).toString("utf8");
  } catch {
    throw new Error("The view-only desktop viewer is unavailable.");
  }

  const moduleSource = rfbSource.replace(
    /export\{([A-Za-z_$][\w$]*) as default\};?\s*$/,
    "var VoiceOSRFB=$1;",
  );
  if (moduleSource === rfbSource) {
    throw new Error("The view-only desktop viewer is unavailable.");
  }

  // An HTML parser must never read bundle bytes as a closing script tag. This
  // only respells string literals inside the JS.
  const htmlSafeSource = moduleSource.replace(/<\/script/gi, "<\\/script");
  const html = template
    .replaceAll("__VOICEOS_CSP_CONNECT__", socketOrigin)
    .replaceAll("__VOICEOS_NONCE__", nonce)
    .replace("__VOICEOS_RFB_SOURCE__", () => htmlSafeSource);

  if (/__VOICEOS_(?:CSP_CONNECT|NONCE|RFB_SOURCE)__/.test(html)) {
    throw new Error("The view-only desktop viewer is unavailable.");
  }
  return html;
}

/** Extract the signed universal helper with owner-only directory/file modes. */
export function materializeViewerHost(parentDirectory = tmpdir()): string {
  const directory = mkdtempSync(join(parentDirectory, VIEWER_TEMP_PREFIX));
  chmodSync(directory, 0o700);
  const binary = join(directory, `ComputerViewer-${randomBytes(12).toString("hex")}`);
  try {
    writeFileSync(binary, Buffer.from(COMPUTER_VIEWER_BINARY_B64, "base64"), {
      flag: "wx",
      mode: 0o700,
    });
    chmodSync(binary, 0o700);
    return binary;
  } catch (error) {
    try { rmSync(directory, { recursive: true, force: true }); } catch { /* best effort after failed extraction */ }
    throw new Error("The secure computer viewer could not be installed for this session.", { cause: error });
  }
}

interface ViewerAck {
  requestId: string;
  status: "ready" | "error";
}

interface PendingOpen {
  resolve: (value: { reused: boolean }) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  reused: boolean;
}

interface ViewerSession {
  child: ReturnType<typeof spawn>;
  pending: Map<string, PendingOpen>;
  stdoutBuffer: string;
}

let viewerHostPath: string | undefined;
let lifecycleRegistered = false;
const sessions = new Map<string, ViewerSession>();

function cleanupStaleViewerHosts(): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(tmpdir(), { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.name.startsWith(VIEWER_TEMP_PREFIX)) continue;
    const target = join(tmpdir(), entry.name);
    try {
      const stat = lstatSync(target);
      if (stat.isDirectory() || stat.isSymbolicLink()) rmSync(target, { recursive: true, force: true });
    } catch {
      // Another process may have cleaned it between the directory read and lstat.
    }
  }
}

function cleanupViewerLifecycle(): void {
  for (const session of sessions.values()) {
    try { session.child.kill("SIGTERM"); } catch { /* already closed */ }
  }
  sessions.clear();
  if (viewerHostPath) {
    try { rmSync(dirname(viewerHostPath), { recursive: true, force: true }); } catch { /* already removed */ }
    viewerHostPath = undefined;
  }
}

function registerViewerLifecycle(): void {
  if (lifecycleRegistered) return;
  lifecycleRegistered = true;
  process.once("exit", cleanupViewerLifecycle);
  process.once("SIGINT", () => {
    cleanupViewerLifecycle();
    process.exit(130);
  });
  process.once("SIGTERM", () => {
    cleanupViewerLifecycle();
    process.exit(143);
  });
}

function ensureViewerHost(): string {
  if (viewerHostPath) return viewerHostPath;
  cleanupStaleViewerHosts();
  registerViewerLifecycle();
  try {
    viewerHostPath = materializeViewerHost();
    return viewerHostPath;
  } catch {
    throw new Error("The secure computer viewer is unavailable on this Mac.");
  }
}

function failSession(botId: string, session: ViewerSession): void {
  if (sessions.get(botId) === session) sessions.delete(botId);
  for (const pending of session.pending.values()) {
    clearTimeout(pending.timer);
    pending.reject(new Error("The secure computer viewer closed before it was ready."));
  }
  session.pending.clear();
}

function handleViewerOutput(session: ViewerSession, botId: string, chunk: string): void {
  session.stdoutBuffer += chunk;
  while (true) {
    const newline = session.stdoutBuffer.indexOf("\n");
    if (newline < 0) return;
    const line = session.stdoutBuffer.slice(0, newline);
    session.stdoutBuffer = session.stdoutBuffer.slice(newline + 1);
    let ack: ViewerAck;
    try {
      ack = JSON.parse(line) as ViewerAck;
    } catch {
      continue;
    }
    const pending = session.pending.get(ack.requestId);
    if (!pending) continue;
    clearTimeout(pending.timer);
    session.pending.delete(ack.requestId);
    if (ack.status === "ready") pending.resolve({ reused: pending.reused });
    else pending.reject(new Error("The secure computer viewer could not open."));
  }
}

function viewerSession(botId: string): { session: ViewerSession; reused: boolean } {
  const existing = sessions.get(botId);
  if (existing && existing.child.exitCode === null && !existing.child.killed) {
    return { session: existing, reused: true };
  }

  const child = spawn(ensureViewerHost(), [], { stdio: ["pipe", "pipe", "ignore"] });
  const session: ViewerSession = { child, pending: new Map(), stdoutBuffer: "" };
  sessions.set(botId, session);
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => handleViewerOutput(session, botId, chunk));
  child.once("error", () => failSession(botId, session));
  child.once("exit", () => failSession(botId, session));
  child.stdin?.once("error", () => failSession(botId, session));
  return { session, reused: false };
}

/**
 * Open or refresh one bot's hardened native viewer. The credential crosses the
 * process boundary only through an anonymous stdin pipe; it is never an
 * argument, environment variable, filename, browser URL, or on-disk document.
 */
export async function openComputerWindow(input: {
  botId: string;
  botName: string;
  wsUrl: string;
}): Promise<{ reused: boolean }> {
  const wsUrl = validateDesktopWebSocketUrl(input.wsUrl);
  const template = WIDGETS.computer;
  if (!template) throw new Error("The view-only desktop viewer is unavailable.");
  const html = buildViewerDocument(template, RFB_B64, wsUrl);
  const { session, reused } = viewerSession(input.botId);
  const requestId = randomBytes(18).toString("base64url");

  return new Promise<{ reused: boolean }>((resolve, reject) => {
    const timer = setTimeout(() => {
      session.pending.delete(requestId);
      try { session.child.kill("SIGTERM"); } catch { /* already closed */ }
      reject(new Error("The secure computer viewer did not become ready in time."));
    }, 15_000);
    session.pending.set(requestId, { resolve, reject, timer, reused });
    const command = JSON.stringify({
      requestId,
      botId: input.botId,
      botName: input.botName,
      wsUrl,
      html,
    });
    if (!session.child.stdin?.write(`${command}\n`, "utf8")) {
      // A false return means backpressure, not failure; the stream still owns
      // the complete command and the helper will acknowledge it when loaded.
    }
  });
}

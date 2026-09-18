/**
 * Boot check (BUILD.md Stage 5 gate): spawns the server EXACTLY as VoiceOS
 * will — `/bin/zsh run.sh`, same cwd + same PATH/env shape the app uses —
 * completes the MCP `initialize` handshake, and on failure CLASSIFIES it so
 * the builder gets a diagnosis instead of a generic "it didn't start."
 *
 *   bun run boot          (from the integration folder)
 *
 * Why not just `bun server.ts` (the old Stage-5 step)? That uses a different
 * command and a different PATH than the app, so it hides three whole failure
 * classes: run.sh runtime resolution, a leak onto stdout, and an immediate
 * exit. This boots the real launch command and watches BOTH streams.
 *
 * Failure classes (mirrors what VoiceOS's own getErrorHint would report,
 * ~/voiceos-intel/deep/main.deob.js L20709 — verified 2026-08-31):
 *   no-runtime        neither bun nor node/npx resolved inside run.sh
 *   boot-crash        runtime started, server.ts threw during import/init
 *   immediate-exit    process exited before speaking MCP, no crash stack
 *   stdout-violation  server wrote non-JSON-RPC bytes to stdout — the exact
 *                     thing that silently drops the integration from routing
 *                     in production, even when the tools "work"
 *   handshake-timeout process stayed up but never answered `initialize`
 *
 * No live account and no read tools needed — a pure "does it come up clean"
 * check. Dependency-free (node built-ins only) so it runs before node_modules
 * exists; run.sh installs deps on its first spawn.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const FOLDER = new URL("../", import.meta.url).pathname.replace(/\/$/, "");
const BOOT_TIMEOUT_MS = 60_000; // first spawn may `bun install`; the app's own
                                // post-start connect budget is 30s (host CONNECT_TIMEOUT_MS).

// Reproduce VoiceOS's buildMcpProcessEnv (main.deob.js L20780) so PATH
// resolution matches the app exactly — a bun that the app finds but the plain
// shell doesn't (or vice-versa) is a real, caught-here divergence.
const HOST_PATHS = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  join(homedir(), ".bun", "bin"),
  join(homedir(), ".local", "bin"),
];
const mergedPath = [
  ...HOST_PATHS,
  ...(process.env.PATH ?? "").split(":").filter(Boolean),
];
const childEnv: Record<string, string> = {
  ...Object.fromEntries(
    Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined),
  ),
  BUN_JSC_useJIT: "false",
  PATH: [...new Set(mergedPath)].join(":"),
};

// The 8 host hints, copied verbatim from main.deob.js L20709 so we print the
// SAME sentence the user would see. Keep in sync if the app's list changes.
const HOST_ERROR_HINTS: Array<{ pattern: RegExp; hint: string }> = [
  { pattern: /ENOENT|command not found|No such file|not found in PATH/i, hint: "The command was not found. Check that the binary is installed and the path is correct." },
  { pattern: /EACCES|permission denied/i, hint: "Permission denied. Check file permissions or try running with appropriate access." },
  { pattern: /ECONNREFUSED|connection refused/i, hint: "Connection refused. Verify the server is running at the configured URL." },
  { pattern: /MODULE_NOT_FOUND|Cannot find module|ModuleNotFoundError|No module named/i, hint: "A required module is missing. Run npm install / bun install / pip install in the server directory." },
  { pattern: /ETIMEDOUT|timed?\s*out/i, hint: "Connection timed out. Check network connectivity and the server URL." },
  { pattern: /EADDRINUSE|address already in use/i, hint: "The port is already in use. Stop the other process or change the port." },
  { pattern: /SyntaxError|unexpected token/i, hint: "There is a syntax error in the server code. Check the logs below for details." },
  { pattern: /No JS runtime found/i, hint: "Neither bun nor node was found. Install one of them and ensure it is on your PATH." },
];
const hostHint = (text: string): string | undefined =>
  HOST_ERROR_HINTS.find((h) => h.pattern.test(text))?.hint;

// A run.sh that can't resolve a runtime. run.sh tries bun, then local tsx,
// then `npx --yes tsx`; with none present zsh emits "command not found" /
// ENOENT for the inner exec.
const NO_RUNTIME = /No JS runtime found|command not found|not found in PATH|ENOENT[\s\S]*\b(bun|node|npx|tsx)\b|\b(bun|node|npx|tsx)\b[^\n]*No such file/i;
// A real throw during import/init (as opposed to a clean early return).
const CRASH = /\b(Error|TypeError|ReferenceError|SyntaxError|RangeError|Exception)\b|Cannot find module|MODULE_NOT_FOUND|\n\s+at\s|Unhandled|uncaughtException|unexpected token/i;

const child = spawn("/bin/zsh", ["run.sh"], { cwd: FOLDER, env: childEnv, stdio: ["pipe", "pipe", "pipe"] });

let stderr = "";
let stdoutBuf = "";
let sawStdoutJunk = false;
let junkLine = "";
let handshakeOk = false;
let toolCount: number | null = null;
let exited: { code: number | null; signal: string | null } | null = null;

child.stderr.on("data", (b) => { stderr += b.toString(); });

// Watch stdout ourselves — this is how stdout-violation is caught. The MCP
// wire is one JSON-RPC object per line; ANY line that isn't one is the leak
// that breaks routing in production (stdoutGuard.ts exists precisely to
// prevent it — this proves it held).
child.stdout.on("data", (b) => {
  stdoutBuf += b.toString();
  let nl: number;
  while ((nl = stdoutBuf.indexOf("\n")) >= 0) {
    const line = stdoutBuf.slice(0, nl).trim();
    stdoutBuf = stdoutBuf.slice(nl + 1);
    if (!line) continue;
    let msg: any;
    try { msg = JSON.parse(line); } catch { sawStdoutJunk ||= true; junkLine ||= line; continue; }
    if (!msg || msg.jsonrpc !== "2.0") { sawStdoutJunk ||= true; junkLine ||= line; continue; }
    if (msg.id === 1 && msg.result && !msg.error) {
      handshakeOk = true;
      // opportunistically ask for the tool list to report a count
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n");
    }
    if (msg.id === 2 && msg.result?.tools) { toolCount = msg.result.tools.length; finish(); }
  }
});

child.on("exit", (code, signal) => { exited = { code, signal }; if (!handshakeOk) finish(); });
child.on("error", (e) => {
  // A managed BUILD sandbox (Codex) can refuse to SPAWN /bin/zsh as a child —
  // posix_spawn returns ENOENT on the shell itself — even though /bin/zsh
  // exists on disk and `/bin/zsh run.sh` runs fine when invoked directly. That
  // is a sandbox limitation on THIS check, not a defect in the built server, so
  // a perfectly good build (google-meet, 2026-09-06: boots clean outside,
  // advertises 6 tools) was forced to PARTIAL and never installed. The launcher
  // (scripts/run-build.sh) re-runs THIS exact boot check OUTSIDE the sandbox as
  // a hard gate before it installs, so deferring here is safe: a server that
  // genuinely can't boot still fails that outside gate and is not installed.
  const code = (e as NodeJS.ErrnoException).code;
  if (code === "ENOENT" && existsSync("/bin/zsh")) {
    console.log(
      "boot: DEFERRED — this sandbox blocks spawning /bin/zsh as a child (posix_spawn ENOENT) though /bin/zsh exists and `/bin/zsh run.sh` runs directly. Not a build defect; the launcher re-verifies boot outside the sandbox before install. On unrestricted macOS: bun run boot.",
    );
    process.exit(0);
  }
  stderr += `spawn error: ${e.message}\n`;
  finish();
});

// Send `initialize` once the pipe is open.
child.stdin.write(JSON.stringify({
  jsonrpc: "2.0", id: 1, method: "initialize",
  params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "friday-boot-check", version: "1.0.0" } },
}) + "\n");

const timer = setTimeout(() => finish(true), BOOT_TIMEOUT_MS);

let done = false;
function finish(timedOut = false) {
  if (done) return;
  done = true;
  clearTimeout(timer);
  try { child.kill("SIGTERM"); } catch {}
  report(timedOut);
}

function tail(s: string, n = 20): string {
  const lines = s.replace(/\s+$/, "").split("\n");
  return lines.slice(-n).map((l) => "    " + l).join("\n") || "    (nothing on stderr)";
}

function classify(timedOut: boolean): { cls: string; blurb: string } {
  // stdout-violation is checked BEFORE OK on purpose: a single non-JSON-RPC
  // line breaks routing in production even when the handshake also completes
  // and the tools otherwise load — so a server that leaks AND answers is still
  // a violation, never OK. (This is the exact "tools work but integration is
  // silently dropped" trap stdoutGuard.ts exists to prevent.)
  if (sawStdoutJunk) return {
    cls: "stdout-violation",
    blurb: `a non-JSON-RPC line reached stdout — VoiceOS marks the whole connection broken and drops this integration's tools until the app restarts.\n  First offending line: ${junkLine.slice(0, 160)}\n  Fix: something bypassed stdoutGuard.ts / console.error. A dependency likely printed on the first API call — silence it at the source (see COMPOSIO_LOG_LEVEL=off in run.sh) or route it through console.error.`,
  };
  if (handshakeOk) return { cls: "OK", blurb: "server booted and speaks MCP cleanly" };
  if (NO_RUNTIME.test(stderr)) return {
    cls: "no-runtime",
    blurb: "run.sh could not resolve bun or node/npx. Install bun (or node) and ensure it's on the app's PATH (/opt/homebrew/bin, ~/.bun/bin).",
  };
  if (timedOut && exited === null) return {
    cls: "handshake-timeout",
    blurb: `server stayed up ${BOOT_TIMEOUT_MS / 1000}s but never answered MCP initialize. VoiceOS gives it only 30s — it will show as failed. Likely blocking on startup or never calling the transport's connect.`,
  };
  if (CRASH.test(stderr)) return {
    cls: "boot-crash",
    blurb: "the runtime started but server.ts threw during import/init. The stack is in the tail above — fix it in Template/ or client.ts/server.ts (never by hand in the output).",
  };
  return {
    cls: "immediate-exit",
    blurb: `process exited (code ${exited?.code ?? "?"}${exited?.signal ? `, signal ${exited.signal}` : ""}) before speaking MCP, with no crash stack. Usually server.ts returned without starting the stdio transport, or \`bun install\` failed quietly — check the tail.`,
  };
}

function report(timedOut: boolean) {
  const { cls, blurb } = classify(timedOut);
  if (cls === "OK") {
    console.log(`boot: OK — server came up clean via /bin/zsh run.sh${toolCount !== null ? `, advertised ${toolCount} tool${toolCount === 1 ? "" : "s"}` : ""} ✓`);
    process.exit(0);
  }
  console.log(`boot: FAILED — class: ${cls}`);
  console.log(`  ${blurb}`);
  const hint = hostHint(stderr + "\n" + (exited ? `exit ${exited.code}` : ""));
  if (hint) console.log(`  VoiceOS will show the user: "${hint}"`);
  console.log(`  stderr tail (last 20 lines VoiceOS keeps up to 200):\n${tail(stderr)}`);
  process.exit(1);
}

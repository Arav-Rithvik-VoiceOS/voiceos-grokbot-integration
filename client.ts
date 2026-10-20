/**
 * Transport layer: the ONLY file that talks to Grok Bot.
 *
 * server.ts (the product layer) never reaches the gateway directly. It calls the
 * typed helpers here (listAgents, sendPrompt, …) and gets back either plain data
 * or an IntegrationError whose message is safe to read out loud. Everything
 * Grok-Bot-shaped — the local gateway, the Keychain decrypt, the token rotation,
 * HTTP error wording — stops in this file. An app update can only ever break
 * this one file.
 *
 * There is NO Composio here and NO official API. Grok Bot (xAI / Cursor) ships a
 * per-session local gateway descriptor + a Keychain-encrypted token, exactly the
 * way its community clients (grok-bot-cli, grokbot-sdk) reach it. We read the
 * user's OWN session on the user's OWN Mac. See SPIKE.md for the proof run and
 * PLAN.md for the design.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import { pbkdf2Sync, createDecipheriv, createHash } from "node:crypto";
import {
  openComputerWindow as launchComputerWindow,
  validateDesktopWebSocketUrl,
} from "./computerWindow.ts";

/** Human name of the service, used in spoken error messages. */
export const SERVICE_NAME = "Grok Bot";

/** Slug — the server name + log prefix. Not a Composio toolkit; there is none. */
export const TOOLKIT = "grokbot";

/** stdout carries the MCP JSON-RPC stream — every log line goes to stderr. */
export const log = (...args: unknown[]) => console.error(`[${TOOLKIT}]`, ...args);

/** Reads should feel quick; writes (send/create) may take a beat longer. */
export const READ_TIMEOUT_MS = 8_000;
export const WRITE_TIMEOUT_MS = 20_000;

export type FailureKind =
  | "setup" // Grok Bot app not installed / not signed in — nothing to decrypt
  | "not_connected" // the session token was rejected — app needs a refresh
  | "auth_expired"
  | "forbidden"
  | "not_found" // the bot the user named doesn't exist
  | "rate_limited"
  | "timeout"
  | "network"
  | "parked" // the cloud box is hibernated and this call did not wake it
  | "session_unavailable" // a missing local route is not evidence of logout
  | "upstream";

/**
 * The one error type that crosses into server.ts. `kind` drives behaviour
 * (setup / not_connected → "open Grok Bot and sign in"; everything else → an
 * honest spoken failure); `message` is written to be read aloud, so it never
 * contains a stack, a token, or a raw URL.
 */
export class IntegrationError extends Error {
  constructor(
    readonly kind: FailureKind,
    message: string,
  ) {
    super(message);
    this.name = "IntegrationError";
  }
}

// ── Local session: descriptor + Keychain → gateway creds ─────────────────────

const DESCRIPTOR_PATH = `${process.env.HOME}/Library/Application Support/Grok Bot/gateway-descriptor.json`;
const DESKTOP_STATUS_PATH = `${process.env.HOME}/Library/Application Support/Grok Bot/desktop-status.json`;

/** Grok Bot removes its transient route when the cloud computer parks. */
export const hasGatewaySession = () => existsSync(DESCRIPTOR_PATH);
function savedSignIn(): boolean | undefined {
  try {
    const status = JSON.parse(readFileSync(DESKTOP_STATUS_PATH, "utf8"));
    return status.version === 1 && typeof status.signedIn === "boolean" ? status.signedIn : undefined;
  } catch {
    return undefined;
  }
}
/** Only the app's explicit signed-out marker proves logout. Older versions
 * export just a descriptor; when both are absent, sign-in state is unknown. */
export const grokBotSignIn = (): boolean | undefined => savedSignIn() ?? (hasGatewaySession() ? true : undefined);
export const hasGrokBotSignIn = grokBotSignIn;
export const hasGrokBotApp = () =>
  existsSync("/Applications/Grok Bot.app") || existsSync(`${process.env.HOME}/Applications/Grok Bot.app`);

// Chromium "Safe Storage" Keychain item the app writes its master key under.
const KEYCHAIN_SERVICE = "Grok Bot Safe Storage";

interface GatewayCreds {
  baseUrl: string;
  token: string;
  networkToken?: string;
  vncPrimaryUrl?: string; // noVNC viewer URL for the shared cloud computer (port 6080)
  vncForkBaseUrl?: string; // origin that serves every bot's OWN desktop (port 6081), token-addressed
  remembered?: boolean; // served from memory because the app removed its route file
}

/**
 * The token rotates (~12h) and the pod host changes per session, so creds are
 * re-derived from disk, not hardcoded. Cache briefly and re-derive when the
 * cache is stale or the gateway rejects the token (see gateway()).
 */
let credsCache: { creds: GatewayCreds; at: number } | null = null;
const CREDS_TTL_MS = 60_000;

/**
 * The last route that decrypted, kept in memory only: never written or logged.
 * Grok Bot deletes its route file when its cloud computer sleeps, and writes a
 * new one only when the app reconnects while the computer is awake. A user
 * request with no file would be stuck, because waking the computer needs the
 * route. The remembered route lets that request send the wake headers itself.
 * Any 401/403, or a network failure on the remembered route, forgets it.
 * It belongs to one sign-in: a later sign-in (the app rewrites its status
 * file) or the token's ~12h lifetime passing forgets it too, so a request can
 * never carry an earlier account's token to that account's computer.
 */
let rememberedRoute: { creds: GatewayCreds; signIn: number | null; at: number } | null = null;
const REMEMBERED_ROUTE_MAX_AGE_MS = 12 * 60 * 60_000;

/** When the app last wrote its sign-in status; changes on sign-out and sign-in. */
function signInStamp(): number | null {
  try {
    return statSync(DESKTOP_STATUS_PATH).mtimeMs;
  } catch {
    return null;
  }
}

const DESCRIPTOR_RECOVERY_MS = 5_000;
let descriptorRecovery: Promise<string> | null = null;

/** The Safe Storage key never changes, so one read serves the whole process.
 * Re-reading it with every creds refresh re-prompted users who clicked
 * "Allow" instead of "Always Allow" once a minute. */
let masterKeyCache: string | null = null;
let keychainRead: Promise<string> | null = null;
/** A hidden prompt must not hold a request until VoiceOS cancels it (60 s).
 * The read itself keeps waiting, so answering the prompt late still helps. */
const KEYCHAIN_WAIT_MS = 30_000;

function signedOutError(): IntegrationError {
  return new IntegrationError("setup", `${SERVICE_NAME} is signed out. Open the Grok Bot app and sign in, then try again.`);
}

function descriptorUnavailable(error: unknown): IntegrationError {
  const code = (error as NodeJS.ErrnoException)?.code;
  log(`gateway descriptor unavailable (${code ?? "read failed"})`);
  if (code !== "ENOENT") {
    return new IntegrationError("session_unavailable", `${SERVICE_NAME}'s local connection file could not be read. Open the Grok Bot app and try again.`);
  }
  const signedIn = savedSignIn();
  if (signedIn === false) return signedOutError();
  return new IntegrationError(
    signedIn === true && !isWaking() ? "parked" : "session_unavailable",
    // Restarting alone is not enough: the app writes the route only when it
    // connects while the cloud computer is awake, and messaging a bot wakes it.
    `${SERVICE_NAME}'s local connection is off. Open Grok Bot and message any bot, then quit Grok Bot and open it again.`,
  );
}

function forgetSession(): void {
  credsCache = null;
  rememberedRoute = null;
}

/** User requests share one bounded recovery; background refreshes never join
 * it or launch the app. Re-read the route after opening the existing session. */
async function readDescriptor(): Promise<string> {
  try {
    return readFileSync(DESCRIPTOR_PATH, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT" || !isWaking() || savedSignIn() === false) {
      throw descriptorUnavailable(error);
    }
  }
  descriptorRecovery ??= (async () => {
    openGrokBotApp();
    const deadline = Date.now() + DESCRIPTOR_RECOVERY_MS;
    for (;;) {
      if (savedSignIn() === false) throw signedOutError();
      try {
        return readFileSync(DESCRIPTOR_PATH, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== "ENOENT" || Date.now() >= deadline) {
          throw descriptorUnavailable(error);
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  })().finally(() => { descriptorRecovery = null; });
  return descriptorRecovery;
}

/** Async so a first-time Keychain prompt cannot block the MCP handshake.
 * Concurrent reads share one prompt; denial is not evidence of signing out. */
function keychainKey(): Promise<string> {
  if (masterKeyCache) return Promise.resolve(masterKeyCache);
  keychainRead ??= new Promise<string>((resolve, reject) => {
    execFile(
      process.env.GROKBOT_SECURITY_BIN || "/usr/bin/security",
      ["find-generic-password", "-w", "-s", KEYCHAIN_SERVICE],
      { encoding: "utf8" },
      (error, stdout) => {
        if (!error) return resolve(stdout.trim());
        // Errors may include captured secrets, so log only the exit code.
        log(`keychain read failed (${String(error.code ?? error.name)})`);
        reject(new IntegrationError(
          "session_unavailable",
          error.code === 44
            ? `${SERVICE_NAME}'s saved session key is unavailable. Open the Grok Bot app to refresh its connection, then try again.`
            : `${SERVICE_NAME} needs Keychain access. Try again and click Always Allow when macOS asks.`,
        ));
      },
    );
  }).then((key) => (masterKeyCache = key)).finally(() => { keychainRead = null; });
  return waitForKeychain(keychainRead);
}

function waitForKeychain(read: Promise<string>): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const waited = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      log("keychain read still waiting; is the macOS prompt hidden?");
      reject(new IntegrationError(
        "session_unavailable",
        `${SERVICE_NAME} is waiting for Keychain access. Look for the macOS Keychain popup, click Always Allow, then try again.`,
      ));
    }, KEYCHAIN_WAIT_MS);
  });
  return Promise.race([read, waited]).finally(() => clearTimeout(timer));
}

/** Read + decrypt the descriptor into live gateway creds. */
async function loadCreds(force = false, keyRefreshed = false): Promise<GatewayCreds> {
  if (savedSignIn() === false) {
    forgetSession();
    throw signedOutError();
  }
  if (!force && credsCache && Date.now() - credsCache.at < CREDS_TTL_MS) {
    return credsCache.creds;
  }
  // Only user requests may wake a computer the app put to sleep.
  if (rememberedRoute && isWaking() && !hasGatewaySession()) {
    if (rememberedRoute.signIn === signInStamp() && Date.now() - rememberedRoute.at < REMEMBERED_ROUTE_MAX_AGE_MS) {
      log("route file missing; trying the remembered route");
      return { ...rememberedRoute.creds, remembered: true };
    }
    log("remembered route is from an earlier sign-in or too old; forgetting it");
    rememberedRoute = null;
  }
  // Stamped before the read, so a sign-in landing mid-read can't be credited
  // to the route that came before it.
  const signIn = signInStamp();
  const raw = await readDescriptor();
  // A key cached by an earlier call may predate a reinstall; see the catch.
  const keyWasCached = masterKeyCache !== null;
  // Keep Keychain failures out of the descriptor-decryption error handler.
  const masterKey = await keychainKey();
  // Sign-out can happen while the user is answering a Keychain prompt.
  if (savedSignIn() === false) {
    forgetSession();
    throw signedOutError();
  }

  let baseUrl: string;
  let token: string;
  let networkToken: string | undefined;
  let vncPrimaryUrl: string | undefined;
  let vncForkBaseUrl: string | undefined;
  try {
    const descriptor = JSON.parse(raw) as {
      entries: Record<string, { savedAtMs?: number; encrypted: string }>;
    };
    // One entry today, but pick the freshest defensively.
    const entry = Object.values(descriptor.entries).sort(
      (a, b) => (b.savedAtMs ?? 0) - (a.savedAtMs ?? 0),
    )[0];
    if (!entry) throw new Error("descriptor has no entries");

    // Chromium Safe Storage v10: PBKDF2-HMAC-SHA1(keychainKey, "saltysalt",
    // 1003, 16) → AES-128-CBC, IV = 16 spaces, over the blob after the "v10"
    // prefix. Node's crypto strips the PKCS7 padding for us.
    const blob = Buffer.from(entry.encrypted, "base64");
    const aesKey = pbkdf2Sync(masterKey, "saltysalt", 1003, 16, "sha1");
    const decipher = createDecipheriv("aes-128-cbc", aesKey, Buffer.alloc(16, 0x20));
    const plain = Buffer.concat([decipher.update(blob.subarray(3)), decipher.final()]).toString("utf8");

    const creds = JSON.parse(plain) as {
      baseUrl: string;
      token: string;
      headers?: Record<string, string>;
      vncProxy?: { primaryUrl?: string; forkBaseUrl?: string };
    };
    baseUrl = creds.baseUrl.replace(/\/$/, "");
    token = creds.token;
    networkToken = creds.headers?.["x-anyrun-network-token"];
    vncPrimaryUrl = creds.vncProxy?.primaryUrl;
    vncForkBaseUrl = creds.vncProxy?.forkBaseUrl?.replace(/\/$/, "");
  } catch (error) {
    // Parse errors can contain decrypted session data. Never log their text.
    log(`descriptor decrypt failed (${error instanceof Error ? error.name : "unknown error"})`);
    // A reinstalled app writes a new Safe Storage key. Read it again now, once,
    // rather than failing this request with a false "needs a refresh".
    masterKeyCache = null;
    if (keyWasCached && !keyRefreshed) return loadCreds(force, true);
    throw new IntegrationError(
      "not_connected",
      `${SERVICE_NAME} needs a refresh — open the Grok Bot app, then try again.`,
    );
  }

  const creds = { baseUrl, token, networkToken, vncPrimaryUrl, vncForkBaseUrl };
  credsCache = { creds, at: Date.now() };
  rememberedRoute = { creds, signIn, at: Date.now() };
  return creds;
}

/** The noVNC viewer URL for the shared cloud computer (for the live screen card). */
export async function vncViewerUrl(): Promise<string | undefined> {
  return (await loadCreds()).vncPrimaryUrl;
}

/**
 * The websockify WebSocket behind a noVNC viewer URL — the same address the
 * viewer page would open itself. The `path` query param already carries the
 * pod's `port_token`, which the router needs on every request; that is why
 * the card opens this socket directly instead of embedding vnc.html.
 */
export function vncWsUrl(viewerUrl: string): string {
  const u = new URL(viewerUrl);
  const path = new URLSearchParams(u.search).get("path") ?? "websockify";
  return `wss://${u.host}/${path.replace(/^\//, "")}`;
}

/**
 * Does a websockify socket have a VNC desktop behind it right now? A real
 * desktop sends its RFB ProtocolVersion greeting the instant the socket opens;
 * websockify will accept the socket even with nothing behind it, so only actual
 * bytes prove a streamable session — an open alone does not.
 */
async function wsHasDesktop(wsUrl: string, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let done = false;
    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl);
    } catch {
      resolve(false);
      return;
    }
    const fin = (v: boolean) => {
      if (done) return;
      done = true;
      try { ws.close(); } catch { /* already closing */ }
      resolve(v);
    };
    ws.addEventListener("message", () => fin(true));
    ws.addEventListener("error", () => fin(false));
    ws.addEventListener("close", () => fin(false));
    setTimeout(() => fin(false), timeoutMs);
  });
}

/** What the gateway says about one bot's own computer ("forever box"). */
interface ForeverBoxStatus {
  agentId?: string;
  state?: string; // "running" | "absent" | …
  vncUrl?: string | null; // localhost form: http://127.0.0.1:6081/vnc.html?path=websockify%3Ftoken%3DN
  windows?: Array<{ windowIndex?: number; vncUrl?: string | null }>;
}

/** Ports the gateway uses in its localhost-form VNC URLs (Grok Bot app: py/my). */
const VNC_PRIMARY_PORT = "6080";
const VNC_FORK_PORT = "6081";
const VNC_RESUME = "resume_lower_s=900&resume_upper_s=18000";
/** How long opening a screen waits for a box to boot. VoiceOS cancels a card's
 * tool call after 60 s, and the call also resolves the bot and checks the feed. */
const BOOT_WAIT_MS = 40_000;
const BOOT_POLL_MS = 1_500;
/** The same resume window as headers. The Grok Bot app parks (hibernates) the
 * cloud box while you seem away, and the box answers 417 until woken; the
 * app's viewer wakes it by sending these on its requests, so every gateway
 * call does too. */
const WAKE_HEADERS = {
  "x-anyrun-hibernation-lower-bound-s": "900",
  "x-anyrun-hibernation-upper-bound-s": "18000",
};
const quiet = new AsyncLocalStorage<true>();
/** Runs background work (polls, watches) without waking a parked box, so it
 * never keeps the box on after the app parks it. It then fails as "parked". */
export const withoutWaking = <T>(work: () => Promise<T>): Promise<T> => quiet.run(true, work);
export const isWaking = () => quiet.getStore() !== true;
const wakeHeaders = () => (isWaking() ? WAKE_HEADERS : {});

/**
 * Turn the gateway's localhost-form VNC URL into public cloud URLs, exactly the
 * way the Grok Bot app does (its xR/fy helpers, verified 2026-09-12):
 *  - port 6080 → the shared computer: `vncProxy.primaryUrl` as-is.
 *  - port 6081 → this bot's OWN desktop: `${forkBaseUrl}/vnc.html?network_token=…&path=websockify?token=<N>&network_token=…`
 * Returns undefined when the URL is not one of those two shapes.
 */
async function publicVncUrls(localUrl: string): Promise<{ viewerUrl: string; wsUrl: string } | undefined> {
  const creds = await loadCreds();
  let u: URL;
  try { u = new URL(localUrl); } catch { return undefined; }
  if (!["127.0.0.1", "localhost"].includes(u.hostname) || !u.pathname.endsWith("/vnc.html")) return undefined;
  if (u.port === VNC_PRIMARY_PORT) {
    return creds.vncPrimaryUrl ? { viewerUrl: creds.vncPrimaryUrl, wsUrl: vncWsUrl(creds.vncPrimaryUrl) } : undefined;
  }
  if (u.port === VNC_FORK_PORT) {
    const path = u.searchParams.get("path") ?? "";
    const q = path.indexOf("?");
    const forkToken = q >= 0 ? new URLSearchParams(path.slice(q + 1)).get("token") : null;
    const base = creds.vncForkBaseUrl;
    const nt = creds.networkToken;
    if (!forkToken || !base || !nt) return undefined;
    const socketPath = `websockify?token=${forkToken}&network_token=${nt}&${VNC_RESUME}`;
    return {
      viewerUrl: `${base}/vnc.html?network_token=${nt}&${VNC_RESUME}&path=${encodeURIComponent(socketPath)}`,
      wsUrl: `wss://${new URL(base).host}/${socketPath}`,
    };
  }
  return undefined;
}

/**
 * The live screen of ONE bot. Each bot works on its own cloud desktop (a
 * "forever box", persistent across tasks), not on the shared computer whose
 * URL sits in the descriptor — that shared desktop is what a card streams if
 * it uses `vncViewerUrl()`, and it is NOT what the bot is doing. Ask the
 * gateway for the bot's box, map its localhost VNC URL to the public one, and
 * prove the desktop answers before handing the socket to a card.
 */
export async function agentScreen(
  agentId: string,
  timeoutMs = 2500,
): Promise<{ live: boolean; boxState?: string; viewerUrl?: string; wsUrl?: string }> {
  let box: ForeverBoxStatus | null;
  try {
    box = await gateway<ForeverBoxStatus | null>("getForeverBoxStatus", { id: agentId });
  } catch (error) {
    log("getForeverBoxStatus failed:", error);
    return { live: false };
  }
  const desktopOf = (b: ForeverBoxStatus | null) => b?.vncUrl ?? b?.windows?.find((w) => w.vncUrl)?.vncUrl ?? null;
  let localUrl = desktopOf(box);
  if (!localUrl && isWaking()) {
    // A bot's box stays "absent" until something boots it; the app does that
    // (ensureForeverBox) whenever its screen opens. Do the same, or the screen
    // reads "not running" until the user opens the app. Background probes skip
    // this so they never boot boxes nobody asked to see.
    // On a parked pod the ensure reply can take far longer than the boot
    // itself, so — like the app — don't hang on it: poll the status too, and
    // take the desktop from whichever answers first.
    let ensured: ForeverBoxStatus | null | undefined;
    gateway<ForeverBoxStatus | null>("ensureForeverBox", { id: agentId }, { timeoutMs: BOOT_WAIT_MS })
      .then((b) => { ensured = b; }, (error) => { log("ensureForeverBox failed:", error); ensured = null; });
    const deadline = Date.now() + BOOT_WAIT_MS;
    while (!localUrl && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, BOOT_POLL_MS));
      if (ensured) {
        box = ensured;
        localUrl = desktopOf(box);
        if (localUrl) break;
      }
      try {
        box = await gateway<ForeverBoxStatus | null>("getForeverBoxStatus", { id: agentId });
        localUrl = desktopOf(box);
      } catch (error) {
        log("getForeverBoxStatus failed while booting:", error);
      }
      if (ensured !== undefined && !localUrl) break; // the boot answered with no desktop: stop waiting
    }
  }
  if (!localUrl) return { live: false, boxState: box?.state };
  const urls = await publicVncUrls(localUrl);
  if (!urls) {
    log("unrecognised box desktop URL shape");
    return { live: false, boxState: box?.state };
  }
  let safeWsUrl: string;
  try {
    safeWsUrl = validateDesktopWebSocketUrl(urls.wsUrl);
  } catch {
    log("rejected an invalid desktop websocket destination");
    throw new IntegrationError(
      "upstream",
      `${SERVICE_NAME} returned an invalid desktop connection. Try reopening the computer in a moment.`,
    );
  }
  const live = await wsHasDesktop(safeWsUrl, timeoutMs);
  return { live, boxState: box?.state, ...urls };
}

// ── The one funnel every gateway call goes through ───────────────────────────

/**
 * POST {baseUrl}/api/{command}. One funnel means timeouts, headers, token
 * refresh, and error classification are written once and can't drift between
 * tools. On a rejected token it clears the cache and retries ONCE with fresh
 * creds — the app may have rotated the session out from under us.
 */
export async function gateway<T = unknown>(
  command: string,
  body: Record<string, unknown> = {},
  { timeoutMs = READ_TIMEOUT_MS, _retried = false }: { timeoutMs?: number; _retried?: boolean } = {},
): Promise<T> {
  const creds = await loadCreds(_retried);
  const started = performance.now();

  let status: number;
  let text: string;
  try {
    const res = await fetch(`${creds.baseUrl}/api/${command}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${creds.token}`,
        "Content-Type": "application/json",
        ...(creds.networkToken ? { "x-anyrun-network-token": creds.networkToken } : {}),
        ...wakeHeaders(),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    status = res.status;
    text = await res.text();
  } catch (error) {
    // bun's fetch is TLS-fingerprint-blocked by some edges; curl isn't. Fall
    // back before giving up. (Same trick the Template's getJson uses.)
    const curled = await curlPost(creds, command, body, timeoutMs);
    if (curled) {
      status = curled.status;
      text = curled.text;
    } else if (creds.remembered && !_retried) {
      // The remembered route is gone; fall back to the app's own recovery.
      rememberedRoute = null;
      return gateway<T>(command, body, { timeoutMs, _retried: true });
    } else {
      throw classifyThrown(error, timeoutMs);
    }
  }

  log(`${command} → ${status} in ${Math.round(performance.now() - started)}ms${creds.remembered ? " (remembered route)" : ""}`);

  if (status === 401 || status === 403) {
    // The remembered route holds this token (or an older one): drop both.
    forgetSession();
    if (!_retried) {
      return gateway<T>(command, body, { timeoutMs, _retried: true });
    }
    throw new IntegrationError(
      "not_connected",
      `${SERVICE_NAME} rejected the session — open the Grok Bot app to refresh it, then try again.`,
    );
  }
  if (status >= 400) throw classifyStatus(status, text);

  try {
    return JSON.parse(text) as T;
  } catch {
    // Some gateway commands answer with prose, not JSON. Hand it back as-is.
    return text as unknown as T;
  }
}

/** curl fallback for gateway() — resolves null when curl itself fails.
 * Async on purpose: a sync curl froze the whole server for up to timeoutMs,
 * so parallel reads (one per bot on the roster) ran their curls one by one. */
function curlPost(
  creds: GatewayCreds,
  command: string,
  body: Record<string, unknown>,
  timeoutMs: number,
): Promise<{ status: number; text: string } | null> {
  return new Promise((resolve) => {
    execFile(
      "/usr/bin/curl",
      [
        "-sS", "--max-time", String(Math.max(1, Math.round(timeoutMs / 1000))),
        "-w", "\n%{http_code}",
        "-X", "POST",
        "-H", `Authorization: Bearer ${creds.token}`,
        "-H", "Content-Type: application/json",
        ...(creds.networkToken ? ["-H", `x-anyrun-network-token: ${creds.networkToken}`] : []),
        ...Object.entries(wakeHeaders()).flatMap(([name, value]) => ["-H", `${name}: ${value}`]),
        "-d", JSON.stringify(body),
        `${creds.baseUrl}/api/${command}`,
      ],
      { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
      (error, out) => {
        if (error) {
          // Never log the error object: its `cmd` holds the bearer and network tokens.
          const code = (error as { code?: unknown }).code;
          log(`curl fallback for ${command} failed (curl exit ${String(code ?? "?")})`);
          return resolve(null);
        }
        const nl = out.lastIndexOf("\n");
        resolve({ status: Number(out.slice(nl + 1).trim()) || 0, text: out.slice(0, nl) });
      },
    );
  });
}

function classifyStatus(status: number, text: string): IntegrationError {
  // The gateway names the failure in a JSON body: {"error":"…"}.
  let detail = "";
  try {
    detail = String((JSON.parse(text) as { error?: unknown }).error ?? "").trim();
  } catch {
    detail = text.slice(0, 160);
  }
  const low = detail.toLowerCase();

  if (status === 417) {
    return new IntegrationError("parked", `${SERVICE_NAME}'s cloud computer is asleep. Open the Grok Bot app to wake it, then try again.`);
  }
  if (status === 429 || /rate limit|too many requests/.test(low)) {
    return new IntegrationError("rate_limited", `${SERVICE_NAME} is busy — wait a moment and try again.`);
  }
  if (/does not exist|not found|no such/.test(low)) {
    return new IntegrationError("not_found", `${SERVICE_NAME} couldn't find that.`);
  }
  log(`unclassified ${status}:`, detail.slice(0, 200));
  return new IntegrationError("upstream", `${SERVICE_NAME} returned an error${detail ? `: ${detail}` : "."}`);
}

function classifyThrown(error: unknown, timeoutMs: number): IntegrationError {
  if (error instanceof IntegrationError) return error;
  const name = error instanceof Error ? error.name : "";
  if (name === "TimeoutError" || name === "AbortError") {
    return new IntegrationError("timeout", `${SERVICE_NAME} didn't respond in time. Try again in a moment.`);
  }
  return new IntegrationError("network", `Couldn't reach ${SERVICE_NAME} — is the Grok Bot app running?`);
}

// ── Typed commands (the surface server.ts uses) ──────────────────────────────

/** The agent fields we actually read. The gateway returns many more. */
export interface Agent {
  id: string;
  name: string;
  description?: string;
  title?: string;
  avatarDataUrl?: string | null;
  /** Set when the bot wears a picture instead of its shape (Grok Bot's own test). */
  avatarVersion?: string | null;
  avatarShape?: string | null;
  avatarColor?: string | null;
  /** Ours, not the gateway's: the bot's picture as a small data: URI, filled in
   * by listAgents (see "Bot pictures" below). Absent → draw the shape. */
  avatarImage?: string;
  isGroup?: boolean;
  memberIds?: string[];
  isRunning?: boolean;
  isRunningTurn?: boolean;
  isComposingMessage?: boolean;
  awaitingUserResponse?: boolean | string | Record<string, unknown> | null;
  hasUnread?: boolean;
  unreadCount?: number;
  lastMessagePreview?: string;
  lastActivityAt?: number;
  /** The per-bot "Notify on updates" switch in the Grok Bot app (on by default). */
  notifyOnUpdatesEnabled?: boolean;
}

export interface TranscriptEntry {
  kind?: string; // "send-message" (agent out) | "message" (a chat turn)
  id?: string;
  message?: unknown; // send-message: { type, content }
  content?: string; // message: the text lives at top level
  role?: string; // message: "user" | "assistant"
  fromAgent?: { id?: string; name?: string }; // set when another agent sent it
  author?: { id?: string; name?: string }; // group send-message: which bot sent it
  toAgent?: { id?: string; name?: string };
  timestampMs?: number;
  requestId?: string;
  images?: { url: string; alt?: string }[];
  file_path?: string;
  file_name?: string;
  text?: string;
  respondedValue?: string | null;
  widgetSkipped?: boolean;
  widgetDismissed?: boolean;
  secretProvided?: boolean;
  credentialResolution?: string;
  formResolution?: string;
  draftSent?: boolean;
  draftDiscarded?: boolean;
}

export async function listAgents() {
  return withAvatarImages(await gateway<Agent[]>("listAgents", {}));
}

// ── Bot pictures ─────────────────────────────────────────────────────────────
//
// A Grok Bot user can give a bot a picture instead of its shape. The app's own
// rule (its roster code): a bot has a picture when avatarDataUrl or
// avatarVersion is set. avatarDataUrl, when present, IS the picture; otherwise
// the app asks the gateway's getAgentAvatar → { dataUrl, version } (a
// "background" command: it never wakes a parked computer) and caches it per
// version. We do the same. Cards cannot reach the network, so the picture
// travels inside the card as a data: URI, center-cropped to 72px (36px avatars
// at 2x) with macOS's sips: PNG when it has transparency, JPEG otherwise.
// Only inline raster images are used; anything else keeps the shape.

export const getAgentAvatar = (id: string) =>
  gateway<{ dataUrl?: string | null; version?: string | null } | null>("getAgentAvatar", { id });

const AVATAR_PX = 72;
const AVATAR_SOURCE_MAX_BYTES = 8 * 1024 * 1024;
/** A shrunk picture over this many characters is not used (the shape is). */
export const AVATAR_IMAGE_MAX_CHARS = 24_000;
/** How long one roster read waits for pictures it has not seen yet. Loads
 * that miss it keep going and land in the cache for the next read. */
const AVATAR_WAIT_MS = 1_200;
const AVATAR_RETRY_MS = 5 * 60_000;
const AVATAR_CACHE_MAX = 200;
/** key (bot id + picture version) → data URI, or null: no usable picture. */
const avatarCache = new Map<string, string | null>();
const avatarLoads = new Map<string, Promise<string | null>>();
const avatarFailures = new Map<string, number>();
/** Grok Bot's own sidebar fetches at most 3 pictures at a time. */
let avatarSlots = 3;
const avatarQueue: (() => void)[] = [];

const hasPicture = (a: Agent) => !a.isGroup && (!!a.avatarDataUrl || !!a.avatarVersion);
const pictureKey = (a: Agent) => [a.id, a.avatarVersion ?? "",
  a.avatarDataUrl ? createHash("sha1").update(a.avatarDataUrl).digest("hex") : ""].join("\n");

async function inAvatarSlot<T>(work: () => Promise<T>): Promise<T> {
  if (avatarSlots === 0) await new Promise<void>((resolve) => avatarQueue.push(resolve));
  else avatarSlots--;
  try {
    return await work();
  } finally {
    const next = avatarQueue.shift();
    if (next) next();
    else avatarSlots++;
  }
}

function sips(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("/usr/bin/sips", args, { encoding: "utf8", timeout: 5_000 }, (error, stdout) =>
      error ? reject(error) : resolve(stdout));
  });
}

/** An inline picture → a small square data: URI, or null when it is not a
 * raster image sips can read. Never logs the picture or where it came from. */
export async function shrinkAvatar(dataUrl: string): Promise<string | null> {
  const head = /^data:image\/(?:png|jpe?g|gif|webp|heic|heif|tiff|bmp);base64,/i.exec(dataUrl);
  if (!head) {
    log("bot picture skipped: not an inline raster image");
    return null;
  }
  const bytes = Buffer.from(dataUrl.slice(head[0].length), "base64");
  if (bytes.length === 0 || bytes.length > AVATAR_SOURCE_MAX_BYTES) return null;
  const dir = await mkdtemp(join(tmpdir(), "grokbot-avatar-"));
  try {
    const src = join(dir, "source");
    await writeFile(src, bytes);
    const info = await sips(["-g", "pixelWidth", "-g", "pixelHeight", "-g", "hasAlpha", src]);
    const width = Number(/pixelWidth: (\d+)/.exec(info)?.[1]);
    const height = Number(/pixelHeight: (\d+)/.exec(info)?.[1]);
    if (!width || !height) return null;
    const alpha = /hasAlpha: yes/.test(info);
    const side = Math.min(width, height);
    const size = Math.min(AVATAR_PX, side);
    // Resample first (short side → size), then crop the middle square: sips
    // applies the two in its own order within one call, so they are two calls.
    let scaled = src;
    if (side > size) {
      scaled = join(dir, "scaled");
      await sips(["-z", String(Math.round((height * size) / side)), String(Math.round((width * size) / side)), src, "--out", scaled]);
    }
    const out = join(dir, alpha ? "out.png" : "out.jpg");
    await sips(["-c", String(size), String(size), "-s", "format", alpha ? "png" : "jpeg",
      ...(alpha ? [] : ["-s", "formatOptions", "82"]), scaled, "--out", out]);
    const uri = `data:image/${alpha ? "png" : "jpeg"};base64,${(await readFile(out)).toString("base64")}`;
    return uri.length <= AVATAR_IMAGE_MAX_CHARS ? uri : null;
  } catch (error) {
    log(`bot picture could not be read (${error instanceof Error ? error.name : "error"})`);
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function loadPicture(a: Agent): Promise<string | null> {
  const source = a.avatarDataUrl || (await inAvatarSlot(() => getAgentAvatar(a.id)))?.dataUrl;
  return typeof source === "string" && source ? shrinkAvatar(source) : null;
}

function rememberPicture(key: string, uri: string | null): void {
  avatarCache.delete(key);
  avatarCache.set(key, uri);
  if (avatarCache.size > AVATAR_CACHE_MAX) avatarCache.delete(avatarCache.keys().next().value!);
}

/** Fills `avatarImage` on bots that wear a picture. Cached pictures land at
 * once; new ones get AVATAR_WAIT_MS, then the roster goes out without them
 * (those bots show their shape this time). A failed read waits a few minutes
 * before it is tried again. */
export async function withAvatarImages(agents: Agent[]): Promise<Agent[]> {
  if (!Array.isArray(agents)) return agents;
  const pending: Promise<void>[] = [];
  let waiting = true;
  for (const a of agents) {
    if (!a || typeof a !== "object" || !hasPicture(a)) continue;
    const key = pictureKey(a);
    if (avatarCache.has(key)) {
      const uri = avatarCache.get(key);
      if (uri) a.avatarImage = uri;
      continue;
    }
    if (Date.now() - (avatarFailures.get(key) ?? 0) < AVATAR_RETRY_MS) continue;
    let load = avatarLoads.get(key);
    if (!load) {
      load = loadPicture(a)
        .then((uri) => { rememberPicture(key, uri); avatarFailures.delete(key); return uri; })
        .catch(() => { avatarFailures.set(key, Date.now()); return null; })
        .finally(() => avatarLoads.delete(key));
      avatarLoads.set(key, load);
    }
    pending.push(load.then((uri) => { if (uri && waiting) a.avatarImage = uri; }));
  }
  if (pending.length) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([Promise.all(pending), new Promise((resolve) => { timer = setTimeout(resolve, AVATAR_WAIT_MS); })]);
    clearTimeout(timer);
    waiting = false;
  }
  return agents;
}

/** Tests only: forget every cached picture. */
export function resetAvatarCache(): void {
  avatarCache.clear();
  avatarLoads.clear();
  avatarFailures.clear();
}

// ── Automations (Grok's name for scheduled tasks) ────────────────────────────
/** One run of a scheduled task; `finishedAt` set means it completed. */
export interface AutomationRun {
  id: string;
  requestId?: string;
  trigger?: string; // "schedule" | "manual" | …
  startedAt?: number; // epoch ms
  finishedAt?: number; // epoch ms — absent while still running
  status?: string; // "ok" | "error" | …
}
/** A scheduled task on one bot. `nextRunAt` is when it fires next (epoch ms). */
export interface Automation {
  id: string;
  name: string;
  prompt?: string;
  triggerDescription?: string; // "Every day at 3:30 PM"
  schedule?: string; // cron
  isEnabled?: boolean;
  createdAt?: number;
  lastRunAt?: number;
  nextRunAt?: number;
  runs?: AutomationRun[];
}
/** listAllAutomations wraps each automation with the bot it belongs to. */
export interface AutomationEntry {
  agentId: string;
  automation: Automation;
}
/** Every scheduled task across all bots, each tagged with its agentId. */
export const listAllAutomations = () => gateway<AutomationEntry[]>("listAllAutomations", {});

export const sendPrompt = (agentId: string, prompt: string) =>
  gateway<{ accepted?: boolean }>("sendPrompt", { agentId, prompt }, { timeoutMs: WRITE_TIMEOUT_MS });

export const createAgent = (
  name: string,
  description: string,
  opts: { title?: string; notificationsEnabled?: boolean; avatarShape?: string; avatarColor?: string } = {},
) =>
  gateway<Agent>(
    "createAgent",
    {
      name,
      description,
      ...(opts.title ? { title: opts.title } : {}),
      // Verified against Grok Bot's createAgent schema: both are optional
      // strings validated against its own shape/color enums.
      ...(opts.avatarShape ? { avatarShape: opts.avatarShape } : {}),
      ...(opts.avatarColor ? { avatarColor: opts.avatarColor } : {}),
      ...(opts.notificationsEnabled !== undefined ? { notificationsEnabled: opts.notificationsEnabled } : {}),
    },
    { timeoutMs: WRITE_TIMEOUT_MS },
  );

export const createGroup = async (name: string, memberAgentIds: string[], description?: string): Promise<Agent> => {
  const created = await gateway<Agent | { agent: Agent }>(
    "createGroup",
    { name, memberAgentIds, ...(description ? { description } : {}) },
    { timeoutMs: WRITE_TIMEOUT_MS },
  );
  return "agent" in created ? created.agent : created;
};

// Gateway contracts verified against Grok Bot's shipped RPC schema.
export const setGroupMembers = (id: string, memberAgentIds: string[]) =>
  gateway("setGroupMembers", { id, memberAgentIds }, { timeoutMs: WRITE_TIMEOUT_MS });

/** Flip a bot's "Notify on updates" switch — the same one the Grok Bot app shows. */
export const setAgentNotifyOnUpdates = (id: string, isEnabled: boolean) =>
  gateway("setAgentNotifyOnUpdates", { id, isEnabled }, { timeoutMs: WRITE_TIMEOUT_MS });

export const renameGroup = (group: Agent, name: string) =>
  gateway("updateAgent", {
    id: group.id,
    profile: {
      name, description: group.description ?? "",
      ...(group.title !== undefined ? { title: group.title } : {}),
      ...(group.avatarShape !== undefined ? { avatarShape: group.avatarShape } : {}),
      ...(group.avatarColor !== undefined ? { avatarColor: group.avatarColor } : {}),
    },
  }, { timeoutMs: WRITE_TIMEOUT_MS });

export const transcriptTail = (id: string, limit = 8, beforeSeq?: number) =>
  gateway<{ entries?: TranscriptEntry[]; nextBeforeSeq?: number }>("getAgentTranscriptTail", { id, limit, ...(beforeSeq !== undefined ? { beforeSeq } : {}) });

export const respondToWidget = (agentId: string, entryId: string, value: string) =>
  gateway<{ accepted?: boolean } | null>("respondToWidget", { agentId, entryId, value }, { timeoutMs: WRITE_TIMEOUT_MS });
export const dismissWidget = (agentId: string, entryId: string) =>
  gateway<{ accepted?: boolean }>("dismissWidget", { agentId, entryId }, { timeoutMs: WRITE_TIMEOUT_MS });
export const readAttachmentImage = (path: string) =>
  gateway<{ dataUrl: string; width?: number; height?: number } | null>("readAttachmentImage", { path });

// ── Reply detection (reply-ping) ─────────────────────────────────────────────
//
// A bot's reply arrives async as a fresh transcript entry. Verified live: the
// bot's own reply to the user comes back as kind:"send-message" (role unset);
// the user's prompt is a different kind, and another agent's inbound sets
// fromAgent. So a reply = a fresh entry that isBotReply.

/** True when an entry is THIS bot replying to the user. */
export function isBotReply(e: TranscriptEntry): boolean {
  if (e.role === "user") return false;
  return e.kind === "send-message" || e.role === "assistant";
}

/** The human-readable text of a transcript entry, across its shapes. */
export function entryText(e: TranscriptEntry): string {
  if (typeof e.content === "string" && e.content) return e.content;
  const m = e.message as { content?: unknown } | string | undefined;
  if (typeof m === "string") return m;
  if (m && typeof m.content === "string") return m.content;
  if (m && typeof m === "object") {
    const message = m as Record<string, any>;
    if (message.type === "widget") return String(message.widget?.prompt ?? "Needs your answer.");
    if (message.type === "attachment" || Array.isArray(message.images) && message.images.length) return "Shared an attachment.";
    if (message.type === "secret-request") return String(message.secretRequest?.label ?? "Authentication required.");
    if (message.type === "user-form") return String(message.formRequest?.title ?? "Needs your input.");
    if (message.type) return "Needs your attention in Grok Bot.";
  }
  return "";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Poll a bot's transcript until it replies, or the budget runs out. `seen` is
 * the set of entry ids captured BEFORE the send, so the reply is any fresh
 * entry that passes isBotReply. Returns { entry, text } or null on timeout.
 * A poll error is swallowed (the session token rotates; one miss must not
 * abort the whole wait).
 */
export async function pollForBotReply(
  botId: string,
  seen: Iterable<string | undefined>,
  opts: { pollMs: number; maxMs: number },
): Promise<{ entry: TranscriptEntry; text: string } | null> {
  const known = new Set(seen);
  const t0 = Date.now();
  while (Date.now() - t0 < opts.maxMs) {
    await sleep(opts.pollMs);
    let tail: { entries?: TranscriptEntry[] };
    try {
      tail = await transcriptTail(botId, 12);
    } catch (error) {
      log("reply poll miss:", error);
      continue;
    }
    const fresh = (tail.entries ?? []).filter((e) => !known.has(e.id));
    const reply = fresh.find(isBotReply);
    if (reply) return { entry: reply, text: entryText(reply) };
    for (const e of fresh) known.add(e.id);
  }
  return null;
}

// ── Spoken name → bot id ─────────────────────────────────────────────────────
//
// Voice users say "Piper", not a UUID. A wrong guess would message the wrong
// bot, so ambiguity is an error ("which one?"), never a coin flip.

/** "F.I.N.C.H." / "finch" / "Finch" → one comparable token. */
export const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Resolve one spoken name to exactly one bot, or throw a spoken error. */
export async function resolveAgent(spoken: string, agents?: Agent[]): Promise<Agent> {
  const list = agents ?? (await listAgents());
  const target = normalize(spoken);
  const exact = list.filter((a) => normalize(a.name) === target);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) {
    throw new IntegrationError("not_found", `You have more than one bot named "${spoken}". Which one?`);
  }
  const partial = list.filter((a) => normalize(a.name).includes(target) && target.length >= 2);
  if (partial.length === 1) return partial[0];
  const names = list.map((a) => a.name).slice(0, 6).join(", ");
  throw new IntegrationError(
    "not_found",
    `I couldn't find a bot called "${spoken}".${names ? ` You have: ${names}.` : ""}`,
  );
}

/** Resolve several spoken names (for a group) to bots; each must match. */
export async function resolveAgents(spokenNames: string[]): Promise<Agent[]> {
  const list = await listAgents();
  return Promise.all(spokenNames.map((name) => resolveAgent(name, list)));
}

/**
 * Resolve group members. Each token is a bot id (the confirmation card stages
 * members as ids) OR a spoken name (what the agent fills). Ids match directly;
 * names go through the spoken-name resolver.
 */
export async function resolveMembers(tokens: string[]): Promise<Agent[]> {
  const list = await listAgents();
  return Promise.all(
    tokens.map((t) => {
      const byId = list.find((a) => a.id === t);
      return byId ? Promise.resolve(byId) : resolveAgent(t, list);
    }),
  );
}

/** Open the bot's larger interactive desktop in the hardened native host. */
export async function openComputerWindow(input: {
  botId: string;
  botName: string;
  wsUrl: string;
  botColor?: string;
  botShape?: string;
}): Promise<{ reused: boolean }> {
  try {
    return await launchComputerWindow(input);
  } catch {
    throw new IntegrationError(
      "upstream",
      "The secure computer viewer could not open on this Mac. Close any old viewer window and try again.",
    );
  }
}

/**
 * Open one bot's chat in the Grok Bot app via its deep link
 * (grokbot://app/v1/agent?id=…). The app's parser rejects anything outside
 * [A-Za-z0-9_-]{1,128}, so we check the id first. Resolves once `open` exits
 * cleanly; rejects if it didn't, so a reminder button can show a real error.
 */
export function openBotChat(agentId: string): Promise<void> {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(agentId)) {
    return Promise.reject(new IntegrationError("not_found", "That bot can't be opened."));
  }
  const url = `grokbot://app/v1/agent?id=${agentId}`;
  return new Promise((resolve, reject) => {
    execFile("/usr/bin/open", [url], (error) => {
      if (error) {
        log("could not open bot chat:", error);
        reject(new IntegrationError("upstream", "Couldn't open Grok Bot."));
      } else resolve();
    });
  });
}

/** Launch the Grok Bot app (used on the setup / not-connected path). */
export function openGrokBotApp(): void {
  try {
    execFile("/usr/bin/open", ["-a", "Grok Bot"], () => {});
  } catch (error) {
    log("could not launch Grok Bot app:", error);
  }
}

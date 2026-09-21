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
import { readFileSync } from "node:fs";
import { execFileSync, execFile } from "node:child_process";
import { pbkdf2Sync, createDecipheriv } from "node:crypto";
import { avatarThumbnail } from "./avatarImage.ts";
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
// Chromium "Safe Storage" Keychain item the app writes its master key under.
const KEYCHAIN_SERVICE = "Grok Bot Safe Storage";

interface GatewayCreds {
  baseUrl: string;
  token: string;
  networkToken?: string;
  vncPrimaryUrl?: string; // noVNC viewer URL for the shared cloud computer (port 6080)
  vncForkBaseUrl?: string; // origin that serves every bot's OWN desktop (port 6081), token-addressed
}

/**
 * The token rotates (~12h) and the pod host changes per session, so creds are
 * re-derived from disk, not hardcoded. Decrypting on EVERY call would re-spawn
 * `security` each time, so cache briefly and re-derive when the cache is stale
 * or the gateway rejects the token (see gateway()).
 */
let credsCache: { creds: GatewayCreds; at: number } | null = null;
const CREDS_TTL_MS = 60_000;

/** The Chromium master key, read from the login Keychain. */
function keychainKey(): string {
  try {
    // Absolute path: the VoiceOS-spawned sandbox resets PATH, so a bare
    // `security` is "command not found". The first read may raise a one-time
    // macOS "allow access" prompt — the user clicks Always Allow once.
    return execFileSync(
      "/usr/bin/security",
      ["find-generic-password", "-w", "-s", KEYCHAIN_SERVICE],
      { encoding: "utf8" },
    ).trim();
  } catch (error) {
    log("keychain read failed:", error);
    throw new IntegrationError(
      "setup",
      `${SERVICE_NAME} isn't set up on this Mac yet. Open the Grok Bot app and sign in, then try again.`,
    );
  }
}

/** Read + decrypt the descriptor into live gateway creds. */
function loadCreds(force = false): GatewayCreds {
  if (!force && credsCache && Date.now() - credsCache.at < CREDS_TTL_MS) {
    return credsCache.creds;
  }

  let raw: string;
  try {
    raw = readFileSync(DESCRIPTOR_PATH, "utf8");
  } catch {
    // No descriptor → the app has never run / signed in on this account.
    throw new IntegrationError(
      "setup",
      `${SERVICE_NAME} isn't signed in on this Mac. Open the Grok Bot app and sign in, then try again.`,
    );
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
    const aesKey = pbkdf2Sync(keychainKey(), "saltysalt", 1003, 16, "sha1");
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
    log("descriptor decrypt failed:", error);
    throw new IntegrationError(
      "not_connected",
      `${SERVICE_NAME} needs a refresh — open the Grok Bot app, then try again.`,
    );
  }

  const creds = { baseUrl, token, networkToken, vncPrimaryUrl, vncForkBaseUrl };
  credsCache = { creds, at: Date.now() };
  return creds;
}

/** The noVNC viewer URL for the shared cloud computer (for the live screen card). */
export function vncViewerUrl(): string | undefined {
  return loadCreds().vncPrimaryUrl;
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

/**
 * Turn the gateway's localhost-form VNC URL into public cloud URLs, exactly the
 * way the Grok Bot app does (its xR/fy helpers, verified 2026-09-12):
 *  - port 6080 → the shared computer: `vncProxy.primaryUrl` as-is.
 *  - port 6081 → this bot's OWN desktop: `${forkBaseUrl}/vnc.html?network_token=…&path=websockify?token=<N>&network_token=…`
 * Returns undefined when the URL is not one of those two shapes.
 */
function publicVncUrls(localUrl: string): { viewerUrl: string; wsUrl: string } | undefined {
  const creds = loadCreds();
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
  const localUrl = box?.vncUrl ?? box?.windows?.find((w) => w.vncUrl)?.vncUrl ?? null;
  if (!localUrl) return { live: false, boxState: box?.state };
  const urls = publicVncUrls(localUrl);
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
  const creds = loadCreds(_retried);
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
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    status = res.status;
    text = await res.text();
  } catch (error) {
    // bun's fetch is TLS-fingerprint-blocked by some edges; curl isn't. Fall
    // back before giving up. (Same trick the Template's getJson uses.)
    const curled = curlPost(creds, command, body, timeoutMs);
    if (curled) {
      status = curled.status;
      text = curled.text;
    } else {
      throw classifyThrown(error, timeoutMs);
    }
  }

  log(`${command} → ${status} in ${Math.round(performance.now() - started)}ms`);

  if (status === 401 || status === 403) {
    if (!_retried) {
      credsCache = null;
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

/** curl fallback for gateway() — returns null when curl itself fails. */
function curlPost(
  creds: GatewayCreds,
  command: string,
  body: Record<string, unknown>,
  timeoutMs: number,
): { status: number; text: string } | null {
  try {
    const out = execFileSync(
      "/usr/bin/curl",
      [
        "-sS", "--max-time", String(Math.max(1, Math.round(timeoutMs / 1000))),
        "-w", "\n%{http_code}",
        "-X", "POST",
        "-H", `Authorization: Bearer ${creds.token}`,
        "-H", "Content-Type: application/json",
        ...(creds.networkToken ? ["-H", `x-anyrun-network-token: ${creds.networkToken}`] : []),
        "-d", JSON.stringify(body),
        `${creds.baseUrl}/api/${command}`,
      ],
      { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
    );
    const nl = out.lastIndexOf("\n");
    return { status: Number(out.slice(nl + 1).trim()) || 0, text: out.slice(0, nl) };
  } catch (error) {
    log(`curl fallback for ${command} failed:`, error);
    return null;
  }
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
  avatarShape?: string | null;
  avatarColor?: string | null;
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
  const agents = await gateway<Agent[]>("listAgents", {});
  return Promise.all(agents.map(async agent => ({
    ...agent,
    ...(agent.avatarDataUrl ? { avatarDataUrl: await avatarThumbnail(agent.avatarDataUrl) } : {}),
  })));
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

export const sendPrompt = (agentId: string, prompt: string, attachments: {
  attachmentPaths?: string[]; attachmentNames?: string[]; clientNonce?: string;
} = {}) =>
  gateway<{ accepted?: boolean }>("sendPrompt", { agentId, prompt, ...attachments }, { timeoutMs: WRITE_TIMEOUT_MS });

export const uploadAttachmentChunk = (args: {
  agentId: string; uploadId: string; filename: string; offset: number;
  totalSize: number; bytesBase64: string;
}) => gateway<{ committedPath?: string }>("uploadAttachmentChunk", args, { timeoutMs: WRITE_TIMEOUT_MS });

export interface TeachRecordingStatus {
  state: "idle" | "recording" | "stopping";
  agentId: string | null;
  startedAtMs: number | null;
  maxDurationMs: number;
}
export const ensureAgentComputer = (id: string) => gateway("ensureForeverBox", { id }, { timeoutMs: WRITE_TIMEOUT_MS });
export const getTeachRecordingStatus = () => gateway<TeachRecordingStatus>("getTeachRecordingStatus");
export const startTeachRecording = (agentId: string) => gateway<TeachRecordingStatus>("startTeachRecording", { agentId, entryPoint: "composer_menu" }, { timeoutMs: WRITE_TIMEOUT_MS });
export const stopTeachRecording = (agentId: string, save: boolean) => gateway<TeachRecordingStatus>("stopTeachRecording", { agentId, save }, { timeoutMs: WRITE_TIMEOUT_MS });

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
// Voice users say "Pepper", not a UUID. A wrong guess would message the wrong
// bot, so ambiguity is an error ("which one?"), never a coin flip.

/** "F.R.I.D.A.Y." / "friday" / "Friday" → one comparable token. */
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

/** Launch the Grok Bot app (used on the setup / not-connected path). */
export function openGrokBotApp(): void {
  try {
    execFile("/usr/bin/open", ["-a", "Grok Bot"], () => {});
  } catch (error) {
    log("could not launch Grok Bot app:", error);
  }
}

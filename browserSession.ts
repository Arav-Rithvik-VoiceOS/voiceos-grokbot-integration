// Grok Bot's separate browser login. The desktop app does not take part.
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  createLogin,
  GrokBotClient,
  pollLogin,
  type Bot,
  type LoginFlow,
} from "./vendor/grok-bot-sdk/sdk.mjs";
import type {
  Agent,
  SentAttachment,
  SidebarPrefs,
  TranscriptEntry,
} from "./client.ts";

const baseFolder =
  process.platform === "win32"
    ? join(
        process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"),
        "VoiceOS",
        "GrokBot",
      )
    : join(process.env.HOME || homedir(), "Library", "Application Support", "VoiceOS", "GrokBot");
const scope = process.env.VOICEOS_GROKBOT_SESSION_SCOPE;
if (scope !== undefined && !/^[a-f0-9]{64}$/.test(scope))
  throw new Error("Invalid VoiceOS account scope.");
const folder = scope ? join(baseFolder, "accounts", scope) : baseFolder;
const sessionFile = join(folder, "browser-session.json");
const pendingFile = join(folder, "pending-login.json");
const lifetime = 10 * 60_000;
/** The Grok Bot client version we present when the app has no newer one
 * (see clientVersion below). The only place these numbers live. */
export const DEFAULT_CLIENT_VERSION =
  process.platform === "win32" ? "0.79.3" : "0.78.5";
let version = DEFAULT_CLIENT_VERSION;
const api = "https://api2.cursor.sh";
type Session = { accessToken: string; selectedTeamId?: number };
type Pending = LoginFlow & { expiresAt: number };

// ── Where the sign-in lives ──────────────────────────────────────────────────
//
// In VoiceOS the app keeps it, encrypted with the OS keystore (Keychain on
// macOS, DPAPI on Windows), through the `voiceos/grokbot/vault` host request.
// This process holds a copy in memory only. Older plain files from 1.0.0 are
// moved into the vault once and deleted. Without a VoiceOS host (tests, dev
// scripts) the files below are still used.

/** The app's answer: `available: false` means no OS keystore on this computer. */
export type HostVault = {
  get(key: "session" | "pending"): Promise<{ available: boolean; value?: string | null }>;
  set(key: "session" | "pending", value: string): Promise<{ available: boolean }>;
  delete(key: "session" | "pending"): Promise<{ available: boolean }>;
  clientVersion(): Promise<string | null>;
};
let vault: HostVault | undefined;
/** Memory copy while the vault is in use; undefined = signed out / no request. */
const memory: { session?: Session; pending?: Pending } = {};
/** Keystore missing: keep the sign-in for this run only. */
let memoryOnly = false;
type Key = "session" | "pending";
/** Keys read from the keystore this run. */
const loaded = new Set<Key>();
/** Keys changed in this run that the keystore does not have yet. */
const unsaved = new Set<Key>();
/** After a vault error, try again at the next tool call after this time. */
let retryAt = 0;
let loading: Promise<void> | undefined;
const RETRY_MS = 60_000;
let ready: Promise<void> = Promise.resolve();
let markReady: () => void = () => {};

/** Call at startup, before the host connects: tools wait for the vault. */
export function expectHostVault(): void {
  ready = new Promise((resolve) => (markReady = resolve));
}

function parse<T>(value: string | null | undefined): T | undefined {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

/** Once the host is connected: load the sign-in and retire the plain files. */
export async function useHostVault(host: HostVault): Promise<void> {
  // Called once per process; start from nothing (tests call it again).
  vault = host;
  memoryOnly = false;
  retryAt = 0;
  loaded.clear();
  unsaved.clear();
  memory.session = memory.pending = undefined;
  try {
    await loadVault();
  } catch {
    // Never crash the integration over the vault: try again at the next call.
    retryAt = Date.now() + RETRY_MS;
  }
  try {
    version = (await host.clientVersion().catch(() => null)) ?? version;
  } finally {
    markReady();
  }
}

/** Every caller waits for this. After a vault error it tries the vault again
 * (at most once a minute), so a startup race does not last the whole run. */
async function vaultReady(): Promise<void> {
  await ready;
  if (!vault || memoryOnly || Date.now() < retryAt) return;
  if (loaded.size < 2 || unsaved.size)
    await (loading ??= loadVault()
      .catch(() => void (retryAt = Date.now() + RETRY_MS))
      .finally(() => (loading = undefined)));
}

const legacyFile = (key: Key) => (key === "session" ? sessionFile : pendingFile);
/** An old 1.0.0 file, or nothing: a broken or locked file must never crash startup. */
function readOld(key: Key): unknown {
  try {
    return read(legacyFile(key));
  } catch {
    return undefined;
  }
}
/** Best effort: Windows can hold a file open (EBUSY/EPERM); the next change retries. */
/** Removes the old 1.0.0 plain file. False when it is still there (a locked
 * file on Windows): a sign-out must then say so, or the next start would move
 * it back into the vault and sign the user in again. */
function dropOld(key: Key): boolean {
  try {
    rmSync(legacyFile(key), { force: true });
    return true;
  } catch {
    return false;
  }
}
function usable<T>(key: Key, value: unknown): T | undefined {
  if (key === "session") return (value as Session | undefined)?.accessToken ? (value as T) : undefined;
  const flow = value as Pending | undefined;
  return flow && flow.expiresAt > Date.now() ? (value as T) : undefined;
}

/**
 * Reads each key the keystore has not given us yet, then saves what changed
 * here. A failed read or write (the app refused because VoiceOS login is not
 * ready, a timeout, a locked file) keeps the sign-in in memory and tries again
 * later. It never writes a plain file; an old 1.0.0 file is only read, and is
 * deleted once the keystore has its value.
 */
async function loadVault(): Promise<void> {
  const host = vault!;
  const keys = (["session", "pending"] as const).filter((key) => !loaded.has(key));
  const answers = await Promise.allSettled(keys.map((key) => host.get(key)));
  let failed = false;
  answers.forEach((answer, i) => {
    const key = keys[i];
    if (answer.status === "rejected") {
      failed = true;
      // Until the keystore answers, an old file still signs the user in.
      if (!unsaved.has(key) && !memory[key]) memory[key] = usable(key, readOld(key));
      return;
    }
    loaded.add(key);
    if (!answer.value.available) memoryOnly = true;
    if (unsaved.has(key)) return; // changed during this run: newer than the keystore
    const stored = usable<Session & Pending>(key, parse(answer.value.value));
    if (stored) memory[key] = stored;
    else {
      // Move a 1.0.0 plain-file sign-in into the keystore.
      memory[key] = usable(key, readOld(key));
      if (memory[key]) unsaved.add(key);
    }
    if (memoryOnly) dropOld(key);
  });
  for (const key of [...unsaved]) if (!(await persist(key))) failed = true;
  retryAt = failed ? Date.now() + RETRY_MS : 0;
}

/** Saves one key in the keystore (a sign-out deletes it). False on an error:
 * the key stays unsaved and the next vault retry tries again. */
async function persist(key: Key): Promise<boolean> {
  if (!vault) return true;
  unsaved.add(key);
  if (memoryOnly) return true;
  try {
    const value = memory[key];
    const answer = value
      ? await vault.set(key, JSON.stringify(value))
      : await vault.delete(key);
    if (!answer.available) memoryOnly = true;
    else {
      unsaved.delete(key);
      dropOld(key);
    }
    return true;
  } catch (error) {
    // -32601: this app has no vault at all, so it holds no copy to delete.
    if ((error as { code?: number }).code === -32601) {
      memoryOnly = true;
      return true;
    }
    retryAt = Math.min(retryAt || Infinity, Date.now() + RETRY_MS);
    return false;
  }
}

function getSession(): Session | undefined {
  return vault ? memory.session : read<Session>(sessionFile);
}
function getPending(): Pending | undefined {
  return vault ? memory.pending : read<Pending>(pendingFile);
}
/** Updates the copy this process reads at once (so two callers never race),
 * then the keystore. */
function setSession(value: Session | undefined): Promise<boolean> {
  if (!vault) {
    if (value) save(sessionFile, value);
    else rmSync(sessionFile, { force: true });
    return Promise.resolve(true);
  }
  memory.session = value;
  // An old 1.0.0 file can still be here when the vault failed. A sign-out or a
  // new sign-in replaces it, so it must never come back after a restart.
  dropOld("session");
  return persist("session");
}
/** Updates the copy this process reads at once (so two callers never race),
 * then the keystore. */
function setPending(value: Pending | undefined): Promise<boolean> {
  if (!vault) {
    if (value) save(pendingFile, value);
    else rmSync(pendingFile, { force: true });
    return Promise.resolve(true);
  }
  memory.pending = value;
  dropOld("pending");
  return persist("pending");
}

function read<T>(file: string): T | undefined {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(
      "VoiceOS could not read its Grok Bot connection. Check your account folder permissions.",
    );
  }
}
function save(file: string, value: unknown, exclusive = false) {
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const temp = join(folder, randomUUID() + ".tmp");
  writeFileSync(temp, JSON.stringify(value), { mode: 0o600, flag: "wx" });
  try {
    if (exclusive) linkSync(temp, file);
    else renameSync(temp, file);
  } finally {
    rmSync(temp, { force: true });
  }
}
export const browserSelected = () =>
  scope !== undefined ||
  process.platform === "win32" ||
  Boolean(getSession() || getPending());
export const browserSignedIn = () => Boolean(getSession()?.accessToken);
export class BrowserLoginRequired extends Error {
  constructor() {
    super(
      "Open Apps, choose Grok Bot, then click Connect.",
    );
  }
}

// Persist the verifier until the exchange succeeds, so an MCP restart while the
// browser is open does not discard the login. Only a click opens a browser.
export async function openBrowserLogin(): Promise<void> {
  await vaultReady();
  return openLogin();
}
/** Callers have awaited `ready`; the claim below runs before any await, so two
 * concurrent connects share one login request. */
async function openLogin(): Promise<void> {
  let flow = getPending();
  if (!flow || flow.expiresAt <= Date.now()) {
    flow = { ...createLogin(), expiresAt: Date.now() + lifetime };
    await setPending(flow);
  }
  const url = new URL(flow.loginUrl);
  if (
    url.origin !== "https://cursor.com" ||
    url.pathname !== "/loginDeepControl"
  )
    throw new Error("Invalid Grok Bot sign-in address.");
  const cmd = process.platform === "win32" ? "rundll32.exe" : "/usr/bin/open";
  const args =
    process.platform === "win32"
      ? ["url.dll,FileProtocolHandler", url.href]
      : [url.href];
  try {
    await new Promise<void>((resolve, reject) =>
      execFile(cmd, args, (error) =>
        error
          ? reject(new Error("Could not open the browser for Grok Bot."))
          : resolve(),
      ),
    );
  } catch (error) {
    if (getPending()?.uuid === flow.uuid) await setPending(undefined);
    throw error;
  }
  // Start polling now, even if the user waits before opening the notch again.
  void pollFlow(flow).catch(() => {});
}
let polling: { uuid: string; done: Promise<void> } | undefined;
function pollFlow(flow: Pending): Promise<void> {
  if (polling?.uuid === flow.uuid) return polling.done;
  const done = (async () => {
    const result = await pollLogin(flow, { maxAttempts: 65 });
    if (getPending()?.uuid !== flow.uuid || flow.expiresAt < Date.now())
      return;
    // The refresh token is not kept: Grok Bot has no public refresh call, and
    // an unused long-lived secret is only something more to lose.
    await setSession({
      accessToken: result.accessToken,
      selectedTeamId: result.selectedTeamId,
    });
    await setPending(undefined);
  })().finally(() => {
    if (polling?.uuid === flow.uuid) polling = undefined;
  });
  polling = { uuid: flow.uuid, done };
  return done;
}
/** Settings and the notch use the same account-scoped browser exchange. */
export async function browserAccount(action: "status" | "connect" | "disconnect"): Promise<{
  state: "signed_out" | "pending" | "connected";
}> {
  if (!scope) throw new Error("Sign in to VoiceOS before connecting Grok Bot.");
  await vaultReady();
  if (action === "disconnect") {
    // The app restarts Grok Bot after a sign-out. Any copy left behind (a
    // locked file on Windows, a vault timeout) would sign the user back in:
    // the session, the half-finished browser login (a restart resumes it)
    // and the old 1.0.0 files. Try each delete twice, then say so.
    const pendingGone = (await setPending(undefined)) || (await persist("pending"));
    const sessionGone = (await setSession(undefined)) || (await persist("session"));
    if (!pendingGone || !sessionGone || !dropOld("pending") || !dropOld("session"))
      throw new Error("Couldn't sign out of Grok Bot. Try again.");
    return { state: "signed_out" };
  }
  if (browserSignedIn()) return { state: "connected" };
  const pending = getPending();
  if (pending && pending.expiresAt > Date.now()) {
    // A process restart can leave a live browser tab waiting for its exchange.
    void pollFlow(pending).catch(() => {});
    return { state: "pending" };
  }
  if (action === "status") return { state: "signed_out" };
  await openLogin();
  if (browserSignedIn()) return { state: "connected" };
  return { state: getPending() ? "pending" : "signed_out" };
}

async function session(): Promise<Session> {
  await vaultReady();
  const current = getSession();
  if (current?.accessToken) return current;
  const flow = getPending();
  if (flow && flow.expiresAt > Date.now()) {
    // Newly restarted MCPs resume an outstanding exchange. A card read never
    // has to wait for a person to finish typing in the browser.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        pollFlow(flow).catch(() => {}),
        new Promise((resolve) => {
          timer = setTimeout(resolve, 900);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    const finished = getSession();
    if (finished?.accessToken) return finished;
  }
  throw new BrowserLoginRequired();
}
/** Grok Bot turned away the client version we present. */
export class ClientVersionRejected extends Error {
  constructor() {
    super(
      "Grok Bot stopped accepting this connection version. VoiceOS is being updated for it. Try again later.",
    );
    this.name = "ClientVersionRejected";
  }
}
const OUTDATED =
  /\b(client|app)\b[^.]{0,40}\b(version|outdated|too old|update required|upgrade)\b|\bupdate (your|the) (app|client)\b|\bunsupported (client )?version\b/i;
/** 426 Upgrade Required, or an error that names the client version. */
export function isOutdatedClient(status: number | undefined, text: string): boolean {
  return status === 426 || OUTDATED.test(text);
}

function platformHeaders(init?: RequestInit) {
  const headers = new Headers(init?.headers);
  headers.set("x-cursor-client-os", process.platform);
  if (process.platform === "win32")
    headers.set(
      "user-agent",
      `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Sand/${version} Safari/537.36`,
    );
  return headers;
}
function rejectExpired(value: Session): never {
  if (getSession()?.accessToken === value.accessToken) {
    // Without a host, an empty file still marks this computer as browser login.
    if (!vault) save(sessionFile, {});
    else void setSession(undefined).catch(() => {});
  }
  throw new BrowserLoginRequired();
}
async function useClient<T>(
  /** `refused()` is true once Grok Bot turned away our client version. */
  work: (client: GrokBotClient, refused: () => boolean) => Promise<T>,
  signal?: AbortSignal,
  /** Sees the raw JSON of these methods' replies, for fields the SDK drops. */
  peek?: { methods: string[]; seen: (method: string, body: unknown) => void },
): Promise<T> {
  const value = await session();
  // The SDK reports only a code like RPC_FAILED, never the reply body, and it
  // swallows a throw from here. So the body is read here and remembered.
  let outdated = false;
  const client = new GrokBotClient({
    accessToken: value.accessToken,
    teamId: value.selectedTeamId,
    version,
    fetchImpl: async (url, init) => {
      const response = await fetch(url, {
        ...init,
        headers: platformHeaders(init),
        signal: signal && init?.signal ? AbortSignal.any([signal, init.signal]) : signal ?? init?.signal,
        redirect: "error",
      });
      const method = String(url).split("/").pop() ?? "";
      if (peek?.methods.includes(method) && response.ok)
        peek.seen(method, await response.clone().json().catch(() => null));
      if (response.status >= 400 && response.status !== 401 &&
          isOutdatedClient(response.status, await response.clone().text().catch(() => "")))
        outdated = true;
      return response;
    },
  });
  try {
    return await work(client, () => outdated);
  } catch (error) {
    if ((error as { httpStatus?: number }).httpStatus === 401) rejectExpired(value);
    if (outdated) throw new ClientVersionRejected();
    throw error;
  }
}
function cardBot(bot: Bot): Agent {
  return {
    id: bot.id,
    name: bot.name,
    title: bot.title,
    description: bot.description,
    avatarColor: bot.avatarColor,
    avatarShape: bot.avatarShape,
    avatarVersion: bot.avatar.picture?.version,
    avatarDataUrl: bot.avatar.picture?.url?.startsWith("data:image/")
      ? bot.avatar.picture.url
      : undefined,
    isGroup: ["2", "ROOM", "GROK_BOT_AGENT_KIND_ROOM"].includes(bot.kind),
    memberIds: bot.memberAgentIds,
    createdAt: Number(bot.createdAtMs),
    updatedAt: Number(bot.updatedAtMs),
  };
}
/** Each bot's current activity line from a raw ListGrokBotAgentStatuses reply
 * (`live.activity.text`, "Finding today's date"). The SDK keeps only its kind. */
export function activityTexts(body: unknown): Map<string, string> {
  const out = new Map<string, string>();
  const rows = (body as { statuses?: unknown })?.statuses;
  for (const row of Array.isArray(rows) ? rows : []) {
    const id = row?.agentId, text = row?.live?.activity?.text;
    if (typeof id === "string" && typeof text === "string" && text.trim())
      out.set(id, text.replace(/\s+/g, " ").trim().slice(0, 120));
  }
  return out;
}

export const browserRoster = () => {
  let activity = new Map<string, string>();
  return useClient(async (client) => {
    const { bots } = await client.listBots();
    const statuses = bots.length
      ? await client
          .listAgentStatuses(bots.map((bot) => bot.id))
          .catch(() => ({ statuses: [] }))
      : { statuses: [] };
    const byId = new Map(
      statuses.statuses.map((row) => [row.agentId, row] as const),
    );
    const avatarUrls = new Map<string, URL>();
    const agents = bots.flatMap((bot) => {
      const status = byId.get(bot.id);
      const state = status?.client;
      if (state?.hiddenFromSidebar || state?.removedFromSidebar) return [];
      const picture = bot.avatar.picture?.url;
      if (picture && URL.canParse(picture)) {
        const url = new URL(picture);
        if (url.protocol === "https:" && !url.username && !url.password && !url.port &&
            url.hostname === "sand-box-stores.s3.us-east-1.amazonaws.com") {
          avatarUrls.set(bot.id, url);
        }
      }
      return [
        {
          ...cardBot(bot),
          isRunning: status?.isRunning,
          isRunningTurn: status?.live?.isRunning,
          isComposingMessage: status?.live?.isComposingMessage,
          unreadCount: state?.unreadCount,
          hasUnread: Boolean(state?.unreadCount),
          lastActivityAt: state?.lastActivityAtMs
            ? Number(state.lastActivityAtMs)
            : undefined,
          lastMessagePreview: state?.lastMessagePreview,
          notifyOnUpdatesEnabled: state?.notifyOnUpdatesEnabled,
          ...(activity.has(bot.id) ? { activityText: activity.get(bot.id) } : {}),
        },
      ];
    });
    return { agents, avatarUrls };
  }, undefined, { methods: ["ListGrokBotAgentStatuses"], seen: (_m, body) => { activity = activityTexts(body); } });
};
async function findBot(client: GrokBotClient, id: string) {
  const bot = (await client.listBots()).bots.find((row) => row.id === id);
  if (!bot) throw new Error("That bot is no longer in your Grok Bot account.");
  return bot;
}
export const browserTranscript = (
  id: string,
  limit: number,
  beforeSeq?: number,
) =>
  useClient(async (client) => {
    const { sessionId } = await findBot(client, id);
    const page = await client.listTranscript({
      botId: id,
      sessionId,
      limit,
      beforeSeq: beforeSeq?.toString(),
    });
    const rows = page.entries.sort((a, b) => Number(a.seq) - Number(b.seq));
    const entries: TranscriptEntry[] = rows
      .filter((row) => row.body)
      .map((row) => ({
        ...row.body,
        id: row.entryId ?? String(row.body?.id ?? row.seq),
        kind: String(row.body?.kind ?? row.entryKind),
        seq: Number(row.seq),
      }));
    return {
      entries,
      nextBeforeSeq:
        rows.length >= limit && Number(rows[0].seq) > 0
          ? Number(rows[0].seq)
          : undefined,
    };
  });
/** A claim Grok Bot says it never saw is released after this long. */
const CLAIM_GRACE_MS = 60_000;
/** Any claim still unsettled after this long is released (send again). */
const CLAIM_TTL_MS = 10 * 60_000;
/** Send records older than this are deleted. */
const SENDS_KEEP_MS = 7 * 24 * 60 * 60_000;
/** How often a long-running process cleans up send records again. */
const SWEEP_EVERY_MS = 6 * 60 * 60_000;
let sweptAt = 0;

/** At most every few hours: delete send records nobody needs any more. A
 * text sent often ("ok") keeps one folder that is always recent, so each
 * generation is aged by its own files, never by the folder (VOS-1672). */
export function sweepSends(root: string, now = Date.now()) {
  if (now - sweptAt < SWEEP_EVERY_MS) return;
  sweptAt = now;
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return;
  }
  for (const name of names) {
    const dir = join(root, name);
    try {
      const files = readdirSync(dir);
      const age = (file: string) => now - statSync(join(dir, file)).mtimeMs;
      if (files.every((file) => age(file) > SENDS_KEEP_MS)) {
        rmSync(dir, { recursive: true, force: true });
        continue;
      }
      // Keep the newest generation: its number stops a late answer to an
      // older send from unlocking a newer one.
      const generations = files.map((file) => Number(/^(\d+)\./.exec(file)?.[1] ?? NaN));
      const newest = Math.max(...generations.filter(Number.isFinite));
      files.forEach((file, i) => {
        if (generations[i] !== newest && age(file) > SENDS_KEEP_MS)
          rmSync(join(dir, file), { force: true });
      });
    } catch {
      // Gone or unreadable: the next sweep tries again.
    }
  }
}

const claimAge = (file: string) => {
  try {
    return Date.now() - statSync(file).mtimeMs;
  } catch {
    return 0;
  }
};

export const browserSend = (
  botId: string,
  text: string,
  attachments: SentAttachment[],
) =>
  useClient(async (client, refused) => {
    const { sessionId } = await findBot(client, botId);
    const digest = createHash("sha256")
      .update(JSON.stringify([botId, sessionId, text, attachments.map(a => a.sha256 ? { name: a.name, sha256: a.sha256 } : a)]))
      .digest("hex");
    sweepSends(join(folder, "sends"));
    const directory = join(folder, "sends", digest);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    // At most two rounds: an earlier claim that Grok Bot never saw (or that is
    // too old to trust) is released once, then this send gets a fresh one.
    for (let round = 0; round < 2; round++) {
      const prior = readdirSync(directory).reduce((last, file) => {
        const match = /^(\d+)\.claim$/.exec(file);
        return match ? Math.max(last, Number(match[1])) : last;
      }, 0);
      // Settlement is per generation. A late acknowledgement from an earlier send
      // must never unlock a newer intentional send of the same text.
      const generation =
        !prior || existsSync(join(directory, prior + ".settled"))
          ? prior + 1
          : prior;
      const claim = join(directory, generation + ".claim");
      const settle = () => save(join(directory, generation + ".settled"), {});
      let messageId = randomUUID() as string;
      let owner = true;
      try {
        save(claim, { messageId }, true);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const previous = read<{ messageId: string }>(claim);
        if (!previous)
          throw new Error("Another send finished. Check your conversation.");
        messageId = previous.messageId;
        owner = false;
      }
      if (owner) {
        try {
          await client.sendMessage({
            botId,
            sessionId,
            // The SDK refuses empty text, but files alone are a message
            // (VOS-1672): their names stand in for the missing text.
            text: text.trim() || attachments.map((a) => a.name).join(", "),
            messageId,
            attachmentPaths: attachments.map((a) => a.path),
            attachmentNames: attachments.map((a) => a.name),
          });
          settle();
          return { accepted: true };
        } catch (error) {
          if ((error as { httpStatus?: number }).httpStatus === 401) {
            settle();
            throw error;
          }
          // Grok Bot turned away this version: nothing was delivered.
          if (refused()) {
            settle();
            throw new ClientVersionRejected();
          }
          // Refused before anything left this computer: a definite failure,
          // not an unknown delivery, so settle and let the user send again.
          if ((error as { code?: string }).code === "MESSAGE_INVALID") {
            settle();
            throw new Error("Grok Bot could not send this message.");
          }
        }
      }
      const result = await client
        .getSendStatus({ botId, messageId, sessionId })
        .catch(() => undefined);
      if (result?.status === "accepted" || result?.status === "rejected") {
        settle();
        if (result.status === "accepted") return { accepted: true };
        throw new Error("Grok Bot rejected this message.");
      }
      // An earlier attempt that Grok Bot never saw, or one stuck for too long,
      // must not block this text forever: release it and send again.
      const age = claimAge(claim);
      if (
        !owner &&
        round === 0 &&
        ((result?.status === "not-found" && age > CLAIM_GRACE_MS) ||
          age > CLAIM_TTL_MS)
      ) {
        settle();
        continue;
      }
      break;
    }
    throw new Error(
      "Delivery is unknown. Check the conversation before sending again.",
    );
  });
async function rpc(method: string, body: object, timeoutMs = 12_000) {
  const value = await session();
  const headers = platformHeaders();
  headers.set("authorization", "Bearer " + value.accessToken);
  headers.set("content-type", "application/json");
  headers.set("connect-protocol-version", "1");
  headers.set("x-cursor-client-type", "sand");
  headers.set("x-cursor-client-source", "sand-desktop");
  headers.set("x-cursor-client-version", version);
  headers.set("x-sand-box-namespace", "prod");
  if (value.selectedTeamId !== undefined)
    headers.set("x-cursor-team-id", String(value.selectedTeamId));
  const response = await fetch(api + "/aiserver.v1.GrokBotService/" + method, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (response.status === 401) rejectExpired(value);
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    if (isOutdatedClient(response.status, text)) throw new ClientVersionRejected();
    throw new Error(`Grok Bot declined ${method} (HTTP ${response.status}).`);
  }
  return response.json();
}
export async function browserGateway(wake: boolean) {
  const route = await rpc(
    "EnsureSandBox",
    { wake, supportsAsleepBox: true },
    wake ? 20_000 : 5_000,
  );
  if (!route.gatewayUrl || !route.gatewayToken)
    throw new Error(
      "Grok Bot did not provide a running computer for this tool.",
    );
  const url = new URL(route.gatewayUrl);
  if (
    url.protocol !== "https:" ||
    !url.hostname.endsWith(".cursorvm.com") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.port
  )
    throw new Error("Grok Bot returned an unknown gateway address.");
  return {
    baseUrl: url.href.replace(/\/$/, ""),
    token: String(route.gatewayToken),
    networkToken: route.networkToken,
    vncPrimaryUrl: safeViewerUrl(route.vncUrl),
    vncForkBaseUrl: safeViewerUrl(route.forkVncBaseUrl),
  };
}

export const browserCreate = (
  name: string,
  description: string,
  opts: {
    title?: string;
    avatarShape?: string;
    avatarColor?: string;
    notificationsEnabled?: boolean;
  },
) =>
  useClient(async (client) => {
    const { bot } = await client.createBot({
      name,
      description,
      title: opts.title,
      avatarShape: opts.avatarShape,
      avatarColor: opts.avatarColor,
    });
    if (opts.notificationsEnabled !== undefined) {
      try {
        await browserNotify(bot.id, opts.notificationsEnabled);
      } catch {
        throw new Error(
          "The bot was created, but Grok Bot could not change its notifications.",
        );
      }
    }
    return cardBot(bot);
  });
export const browserRoom = (
  name: string,
  members: string[],
  description?: string,
) =>
  useClient(async (client) =>
    cardBot(
      (await client.createRoom({ name, memberAgentIds: members, description }))
        .bot,
    ),
  );
export const browserMembers = (roomId: string, memberAgentIds: string[]) =>
  useClient((client) => client.setRoomMembers({ roomId, memberAgentIds }));
export const browserRename = (id: string, name: string) =>
  useClient(async (client) => {
    const bot = await findBot(client, id);
    if (!bot.serverId)
      throw new Error(
        "Grok Bot did not provide an ID for renaming this group.",
      );
    return client.updateBot({ id: bot.serverId, name });
  });

function safeViewerUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  try {
    const u = new URL(value);
    return u.protocol === "https:" &&
      u.hostname.endsWith(".cursorvm.com") &&
      !u.username &&
      !u.password &&
      !u.port
      ? u.href
      : undefined;
  } catch {
    return undefined;
  }
}
export async function browserPrefs(): Promise<SidebarPrefs> {
  const { settings } = await rpc("GetGrokBotUserRuntimeSettings", {}, 3_000);
  const strings = (v: unknown) =>
    Array.isArray(v)
      ? v.filter((id): id is string => typeof id === "string")
      : [];
  const groups = Array.isArray(settings?.sidebarSections?.sections)
    ? settings.sidebarSections.sections
    : [];
  return {
    pinnedIds: strings(settings?.pinnedAgents?.agentIds),
    mainId:
      typeof settings?.mainAgentId === "string"
        ? settings.mainAgentId
        : undefined,
    sections: groups
      .filter(
        (g: Record<string, unknown>) =>
          g && typeof g.id === "string" && typeof g.name === "string",
      )
      .map((g: { id: string; name: string; agentIds: unknown }) => ({
        id: g.id,
        name: g.name,
        agentIds: strings(g.agentIds),
      })),
  };
}
export async function browserMarkRead(agentId: string) {
  const { state } = await rpc("SetGrokBotAgentClientState", { agentId, markRead: true });
  if (state?.agentId !== agentId || Number(state.unreadCount ?? 0) !== 0)
    throw new Error("Grok Bot did not confirm that this chat was read.");
}
export async function browserNotify(agentId: string, enabled: boolean) {
  const { state } = await rpc("SetGrokBotAgentClientState", {
    agentId,
    notifyOnUpdatesEnabled: enabled,
  });
  if (
    state?.agentId !== agentId ||
    (state.notifyOnUpdatesEnabled ?? false) !== enabled
  )
    throw new Error("Grok Bot did not confirm the new notification setting.");
  return { accepted: true };
}
export const browserWidget = (
  agentId: string,
  entryId: string,
  value?: string,
) =>
  useClient(async (client) => {
    const { sessionId } = await findBot(client, agentId);
    const reply = await rpc(
      value === undefined ? "DismissGrokBotWidget" : "RespondGrokBotWidget",
      { agentId, sessionId, entryId, value },
    );
    return { accepted: reply.accepted === true };
  });
export const browserUpload = (
  agentId: string,
  fileName: string,
  base64: string,
) =>
  useClient(async (client) => {
    const { sessionId } = await findBot(client, agentId);
    const data = Buffer.from(base64, "base64");
    const digest = createHash("sha256").update(data).digest("hex");
    const uploadId = randomUUID();
    // Each reply acknowledges a byte offset. Only the final reply can supply the
    // server-side path which SendGrokBotUserMessage expects.
    let offset = 0;
    do {
      const end = Math.min(offset + 256 * 1024, data.length);
      const response = await rpc("UploadGrokBotAgentAttachmentChunk", {
        agentId,
        sessionId,
        uploadId,
        fileName,
        offset: String(offset),
        totalSize: String(data.length),
        data: data.subarray(offset, end).toString("base64"),
        sha256Hex: digest,
      });
      if (Number(response.receivedBytes ?? 0) !== end)
        throw new Error("Grok Bot did not confirm the uploaded bytes.");
      if (end === data.length) {
        if (typeof response.path !== "string" || !response.path)
          throw new Error("Grok Bot did not return an uploaded file path.");
        return response.path;
      }
      offset = end;
    } while (offset < data.length);
    throw new Error("The file upload did not finish.");
  });

/** The official browser transport resolves all session IDs with one roster
 * read. The caller discards every result on a timeout or incomplete coverage. */
export function browserRoutingHistory(bots: Agent[], signal: AbortSignal): Promise<TranscriptEntry[][]> {
  return useClient(async client => {
    const roster = (await client.listBots()).bots;
    return Promise.all(bots.map(async bot => {
      const match = roster.find(b => b.id === bot.id);
      if (!match) throw new Error("Grok Bot's roster changed.");
      const page = await client.listTranscript({ botId: bot.id, sessionId: match.sessionId, limit: 6 });
      if (page.entries.some(entry => entry.bodyOmitted)) throw new Error("Grok Bot did not return complete recent history.");
      return page.entries.flatMap(entry => entry.body ? [{ ...entry.body, kind:String(entry.body.kind ?? entry.entryKind) } as TranscriptEntry] : []);
    }));
  }, signal);
}

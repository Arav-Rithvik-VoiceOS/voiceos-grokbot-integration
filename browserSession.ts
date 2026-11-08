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
} from "grok-bot-sdk";
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
const version = process.platform === "win32" ? "0.79.3" : "0.78.5";
const api = "https://api2.cursor.sh";
type Session = { accessToken: string; selectedTeamId?: number };
type Pending = LoginFlow & { expiresAt: number };

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
  existsSync(sessionFile) ||
  existsSync(pendingFile);
export const browserSignedIn = () =>
  Boolean(read<Session>(sessionFile)?.accessToken);
export class BrowserLoginRequired extends Error {
  constructor() {
    super(
      "Sign in to Grok Bot in your browser, then say “show my bots” again.",
    );
  }
}

// Persist the verifier until the exchange succeeds, so an MCP restart while the
// browser is open does not discard the login. Only a click opens a browser.
export async function openBrowserLogin(): Promise<void> {
  let flow = read<Pending>(pendingFile);
  if (!flow || flow.expiresAt <= Date.now()) {
    flow = { ...createLogin(), expiresAt: Date.now() + lifetime };
    save(pendingFile, flow);
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
  await new Promise<void>((resolve, reject) =>
    execFile(cmd, args, (error) =>
      error
        ? reject(new Error("Could not open the browser for Grok Bot."))
        : resolve(),
    ),
  );
  // Start polling now, even if the user waits before opening the notch again.
  void pollFlow(flow).catch(() => {});
}
let polling: { uuid: string; done: Promise<void> } | undefined;
function pollFlow(flow: Pending): Promise<void> {
  if (polling?.uuid === flow.uuid) return polling.done;
  const done = (async () => {
    const result = await pollLogin(flow, { maxAttempts: 65 });
    if (
      read<Pending>(pendingFile)?.uuid !== flow.uuid ||
      flow.expiresAt < Date.now()
    )
      return;
    save(sessionFile, {
      accessToken: result.accessToken,
      selectedTeamId: result.selectedTeamId,
    });
    rmSync(pendingFile, { force: true });
  })().finally(() => {
    if (polling?.uuid === flow.uuid) polling = undefined;
  });
  polling = { uuid: flow.uuid, done };
  return done;
}
async function session(): Promise<Session> {
  const current = read<Session>(sessionFile);
  if (current?.accessToken) return current;
  const flow = read<Pending>(pendingFile);
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
    const finished = read<Session>(sessionFile);
    if (finished?.accessToken) return finished;
  }
  throw new BrowserLoginRequired();
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
function rejectExpired(value: Session) {
  if (read<Session>(sessionFile)?.accessToken === value.accessToken)
    save(sessionFile, {});
  throw new BrowserLoginRequired();
}
async function useClient<T>(
  work: (client: GrokBotClient) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const value = await session();
  const client = new GrokBotClient({
    accessToken: value.accessToken,
    teamId: value.selectedTeamId,
    version,
    fetchImpl: (url, init) =>
      fetch(url, {
        ...init,
        headers: platformHeaders(init),
        signal: signal && init?.signal ? AbortSignal.any([signal, init.signal]) : signal ?? init?.signal,
        redirect: "error",
      }),
  });
  try {
    return await work(client);
  } catch (error) {
    if ((error as { httpStatus?: number }).httpStatus === 401)
      rejectExpired(value);
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
export const browserRoster = () =>
  useClient(async (client) => {
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
        },
      ];
    });
    return { agents, avatarUrls };
  });
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
export const browserSend = (
  botId: string,
  text: string,
  attachments: SentAttachment[],
) =>
  useClient(async (client) => {
    const { sessionId } = await findBot(client, botId);
    const digest = createHash("sha256")
      .update(JSON.stringify([botId, sessionId, text, attachments]))
      .digest("hex");
    const directory = join(folder, "sends", digest);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
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
          text,
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
  if (!response.ok)
    throw new Error(`Grok Bot declined ${method} (HTTP ${response.status}).`);
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

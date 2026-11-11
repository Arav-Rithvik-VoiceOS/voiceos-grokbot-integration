import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "grok-browser-test-"));
process.env.HOME = home;
process.env.LOCALAPPDATA = join(home, "Local");
process.env.VOICEOS_GROKBOT_SESSION_SCOPE = "a".repeat(64);
const base =
  process.platform === "win32"
    ? join(home, "Local", "VoiceOS", "GrokBot")
    : join(home, "Library", "Application Support", "VoiceOS", "GrokBot");
const dir = join(base, "accounts", process.env.VOICEOS_GROKBOT_SESSION_SCOPE);
mkdirSync(dir, { recursive: true });
writeFileSync(
  join(base, "browser-session.json"),
  JSON.stringify({ accessToken: "different-local-profile" }),
);
const path = join(dir, "browser-session.json");
const seed = () =>
  writeFileSync(
    path,
    JSON.stringify({ accessToken: "test-session", selectedTeamId: 2 }),
  );
const browser = await import("../browserSession.ts");
const client = await import("../client.ts");
const calls: { method: string; body: any }[] = [];
const storageHost = "sand-box-stores.s3.us-east-1.amazonaws.com";
let pictureUrl: string | undefined;
let pictureReads = 0;
let unreadCount = 1;
let unknown = false,
  expired = false,
  deliveryStatus = "unknown",
  remoteHost = "account.cursorvm.com";
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (u, init) => {
  const url = new URL(String(u));
  if (url.hostname === storageHost) {
    expect(new Headers(init?.headers).has("authorization")).toBe(false);
    expect(init?.credentials).toBe("omit");
    expect(init?.redirect).toBe("error");
    pictureReads++;
    return new Response(Bun.file(join(import.meta.dir, "../icon.png")), { headers: { "Content-Type": "image/png" } });
  }
  expect(url.origin).toBe("https://api2.cursor.sh");
  expect(new Headers(init?.headers).get("authorization")).toBe(
    "Bearer test-session",
  );
  const method = url.pathname.split("/").at(-1)!;
  const body = JSON.parse(String(init?.body));
  calls.push({ method, body });
  if (expired)
    return Response.json({ code: "unauthenticated" }, { status: 401 });
  if (method === "SetGrokBotAgentClientState" && body.markRead === true) {
    expect(body).toEqual({ agentId: "assistant", markRead: true });
    unreadCount = 0;
    return Response.json({ state: { agentId: body.agentId } });
  }
  const replies: Record<string, unknown> = {
    ListGrokBotAgents: {
      agents: [
        {
          agentId: "assistant",
          id: "server",
          name: "Assistant",
          viewerSessionId: "chat",
          avatarUrl: pictureUrl,
        },
      ],
    },
    ListGrokBotAgentStatuses: {
      statuses: [
        {
          agentId: "assistant",
          client: { agentId: "assistant", unreadCount },
        },
      ],
    },
    ListGrokBotTranscriptEntries: {
      entries: [
        {
          seq: "1",
          entryId: "e1",
          body: Buffer.from(
            JSON.stringify({
              kind: "message",
              role: "assistant",
              content: "Hello",
            }),
          ).toString("base64"),
        },
      ],
    },
    SendGrokBotUserMessage: { delivery: 1 },
    GetGrokBotSendStatus: { status: deliveryStatus },
    GetGrokBotUserRuntimeSettings: {
      settings: {
        mainAgentId: "assistant",
        pinnedAgents: { agentIds: ["assistant"] },
      },
    },
    UploadGrokBotAgentAttachmentChunk: {
      receivedBytes: String(Number(body.offset || 0) + Buffer.from(body.data || "", "base64").length),
      ...(Number(body.offset || 0) + Buffer.from(body.data || "", "base64").length === Number(body.totalSize)
        ? { path: "/sandbox/" + body.fileName } : {}),
    },
    RespondGrokBotWidget: { accepted: true },
    EnsureSandBox: {
      gatewayUrl: "https://" + remoteHost,
      gatewayToken: "fixture",
      forkVncBaseUrl: "https://fork.cursorvm.com",
    },
  };
  if (method === "SendGrokBotUserMessage" && unknown)
    return Response.json({ code: "unavailable" }, { status: 503 });
  if (!(method in replies)) throw new Error("Unexpected method " + method);
  return Response.json(replies[method]);
}) as typeof fetch;
afterAll(() => {
  globalThis.fetch = originalFetch;
  rmSync(home, { recursive: true, force: true });
});

test("a new VoiceOS account never imports another profile's session or uses the desktop gateway", async () => {
  expect(client.grokBotSignIn()).toBe(false);
  await expect(client.listAgents()).rejects.toBeInstanceOf(
    browser.BrowserLoginRequired,
  );
  expect(calls.length).toBe(0);
});
test("same cards read browser roster, unread status, history and sidebar settings; send the uploaded server path", async () => {
  seed();
  expect((await client.listAgents())[0]).toMatchObject({
    id: "assistant",
    unreadCount: 1,
  });
  expect((await client.transcriptTail("assistant")).entries?.[0]).toMatchObject(
    { id: "e1", content: "Hello" },
  );
  expect(await browser.browserPrefs()).toMatchObject({
    mainId: "assistant",
    pinnedIds: ["assistant"],
  });
  const path = await client.uploadAttachment("assistant", "proof.txt", "aGk=");
  expect(
    await client.sendPrompt("assistant", "hi", [{ path, name: "proof.txt" }]),
  ).toEqual({ accepted: true });
  expect(
    calls.find((c) => c.method === "SendGrokBotUserMessage")?.body,
  ).toMatchObject({
    agentId: "assistant",
    sessionId: "chat",
    attachmentPaths: ["/sandbox/proof.txt"],
  });
  expect(await client.respondToWidget("assistant", "question", "Yes")).toEqual({
    accepted: true,
  });
});
test("reading the roster or history leaves unread alone; only the displayed page clears it", async () => {
  seed();
  unreadCount = 1;
  const { acknowledgeChat, conversationSnapshot } = await import("../conversationService.ts");
  await conversationSnapshot();
  await conversationSnapshot("assistant");
  const writes = () => calls.filter(row => row.method === "SetGrokBotAgentClientState" && row.body.markRead).length;
  expect(writes()).toBe(0);
  expect(await acknowledgeChat("assistant", "older-message")).toMatchObject({ seen: false });
  expect(writes()).toBe(0);
  expect(await acknowledgeChat("assistant", "e1")).toMatchObject({ seen: true, botId: "assistant", entryId: "e1" });
  expect((await client.listAgents())[0].hasUnread).toBe(false);
  await acknowledgeChat("assistant", "e1");
  expect(writes()).toBe(1);
});
test("cloud profile pictures reach the card without exposing the signed URL", async () => {
  seed();
  pictureUrl = `https://${storageHost}/avatar.png?signature=private`;
  try {
    const agents = await client.listAgents();
    const { avatarMap } = await import("../cards.ts");
    expect(avatarMap(agents).assistant).toMatch(/^data:image\/png;base64,/);
    expect(JSON.stringify(agents)).not.toContain("signature");
    pictureUrl = `https://${storageHost}/avatar.png?signature=rotated`;
    expect(avatarMap(await client.listAgents())).toEqual(avatarMap(agents));
    expect(pictureReads).toBe(1);
    pictureUrl = "https://untrusted.example/avatar.png";
    expect(avatarMap(await client.listAgents())).toEqual({});
  } finally {
    pictureUrl = undefined;
  }
});
test("an unknown acknowledgement uses the same message ID across retries and never resends until settled", async () => {
  seed();
  calls.length = 0;
  unknown = true;
  deliveryStatus = "unknown";
  await expect(client.sendPrompt("assistant", "once")).rejects.toThrow(
    "Delivery is unknown",
  );
  deliveryStatus = "GROK_BOT_SEND_STATUS_ACCEPTED";
  await expect(client.sendPrompt("assistant", "once")).resolves.toEqual({
    accepted: true,
  });
  expect(
    calls.filter((c) => c.method === "SendGrokBotUserMessage"),
  ).toHaveLength(1);
  const ids = new Set(
    calls.filter((c) => c.body.messageId).map((c) => c.body.messageId),
  );
  expect(ids.size).toBe(1);
  unknown = false;
  await client.sendPrompt("assistant", "once");
  expect(
    calls.filter((c) => c.method === "SendGrokBotUserMessage"),
  ).toHaveLength(2);
});
test("a 3 MB binary is acknowledged chunk by chunk; re-uploaded bytes share an unresolved send", async () => {
  seed();
  calls.length = 0;
  const { randomBytes, createHash } = await import("node:crypto");
  const bytes = randomBytes(3 * 1024 * 1024);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const name = "video.mp4";
  const path = await client.uploadAttachment("assistant", name, bytes.toString("base64"));
  const chunks = calls.filter(c => c.method === "UploadGrokBotAgentAttachmentChunk").map(c => c.body);
  expect(chunks).toHaveLength(12);
  expect(chunks.every((c, i) => c.offset === String(i * 256 * 1024) && c.sha256Hex === sha256)).toBe(true);
  expect(Buffer.concat(chunks.map(c => Buffer.from(c.data, "base64"))).equals(bytes)).toBe(true);
  unknown = true;
  deliveryStatus = "unknown";
  try {
    await expect(client.sendPrompt("assistant", "Video", [{name, path, sha256}])).rejects.toThrow("Delivery is unknown");
    deliveryStatus = "GROK_BOT_SEND_STATUS_ACCEPTED";
    await expect(client.sendPrompt("assistant", "Video", [{name, path: "/different/upload", sha256}])).resolves.toEqual({accepted:true});
    expect(calls.filter(c => c.method === "SendGrokBotUserMessage")).toHaveLength(1);
  } finally { unknown = false; }
});

test("gateway URLs are restricted, expired credentials ask for browser login, and no unscoped fallback occurs", async () => {
  seed();
  remoteHost = "malicious.example";
  await expect(browser.browserGateway(false)).rejects.toThrow(
    "unknown gateway address",
  );
  remoteHost = "account.cursorvm.com";
  expect((await browser.browserGateway(false)).vncForkBaseUrl).toContain(
    "fork.cursorvm.com",
  );
  expired = true;
  await expect(client.listAgents()).rejects.toBeInstanceOf(
    browser.BrowserLoginRequired,
  );
  expect(client.grokBotSignIn()).toBe(false);
  await expect(client.listAgents()).rejects.toBeInstanceOf(
    browser.BrowserLoginRequired,
  );
});

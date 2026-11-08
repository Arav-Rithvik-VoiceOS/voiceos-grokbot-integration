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
let unknown = false,
  expired = false,
  deliveryStatus = "unknown",
  remoteHost = "account.cursorvm.com";
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (u, init) => {
  const url = new URL(String(u));
  expect(url.origin).toBe("https://api2.cursor.sh");
  expect(new Headers(init?.headers).get("authorization")).toBe(
    "Bearer test-session",
  );
  const method = url.pathname.split("/").at(-1)!;
  const body = JSON.parse(String(init?.body));
  calls.push({ method, body });
  if (expired)
    return Response.json({ code: "unauthenticated" }, { status: 401 });
  const replies: Record<string, unknown> = {
    ListGrokBotAgents: {
      agents: [
        {
          agentId: "assistant",
          id: "server",
          name: "Assistant",
          viewerSessionId: "chat",
        },
      ],
    },
    ListGrokBotAgentStatuses: {
      statuses: [
        {
          agentId: "assistant",
          client: { agentId: "assistant", unreadCount: 1 },
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
      receivedBytes: "2",
      path: "/sandbox/proof.txt",
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

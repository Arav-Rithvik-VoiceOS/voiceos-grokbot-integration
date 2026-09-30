import { beforeEach, expect, mock, test } from "bun:test";
import * as actual from "../client.ts";
import { toBot } from "../cards.ts";

// Replace only external boundaries. These tests run the production handlers and cards.
const resolveReal = actual.resolveAgent;
const handlers = new Map<string, (args: any) => Promise<any>>();
const requestHandlers = new Map<string, (req: any) => Promise<any>>();
let openedChats: string[] = [];
const bots: actual.Agent[] = [
  { id: "p", name: "Piper", avatarColor: "orange" },
  { id: "f", name: "Finch", avatarColor: "green" },
  { id: "t", name: "Theo", avatarColor: "blue" },
];
let agents: actual.Agent[], writes: any[], rejectSend: boolean;
let publishCreated = true;
const EARLIER: actual.TranscriptEntry[] = [{ kind: "message", role: "user", content: "Earlier message", id: "old" }];
let tail: actual.TranscriptEntry[] = EARLIER;
let tailCursor: number | undefined;
let tailFails = false;
let desktopProbe: Awaited<ReturnType<typeof actual.agentScreen>>;
let computerWindows: Array<{ botId: string; botName: string; wsUrl: string }>;
mock.module("@modelcontextprotocol/sdk/server/mcp.js", () => ({ McpServer: class {
  server = {
    request: async () => ({ notificationId: "test" }),
    setNotificationHandler() {},
    setRequestHandler(schema: any, handler: any) { requestHandlers.set(schema.shape.method.value, (req) => handler(schema.parse(req))); },
  };
  registerTool(name: string, _schema: any, handler: any) { handlers.set(name, handler); return { update() {} }; }
  tool(name: string, _description: string, _schema: any, handler: any) { handlers.set(name, handler); }
  sendToolListChanged() {}
  async connect() {}
} }));
mock.module("../client.ts", () => ({
  ...actual,
  log: () => {},
  listAgents: async () => agents,
  listAllAutomations: async () => [],
  createAgent: async (name: string) => {
    const bot = { id: "created", name };
    writes.push(["createBot", name]);
    if (publishCreated) agents.push(bot);
    return bot;
  },
  resolveAgent: async (name: string, list = agents) => resolveReal(name, list),
  transcriptTail: async () => {
    if (tailFails) throw new actual.IntegrationError("upstream", "transcript read failed");
    return { entries: tail, ...(tailCursor !== undefined ? { nextBeforeSeq: tailCursor } : {}) };
  },
  agentScreen: async () => desktopProbe,
  openBotChat: async (id: string) => { openedChats.push(id); },
  openComputerWindow: async (input: { botId: string; botName: string; wsUrl: string }) => {
    computerWindows.push(input);
    return { reused: false };
  },
  sendPrompt: async (id: string, message: string) => {
    writes.push(["send", id, message]);
    if (rejectSend) throw new actual.IntegrationError("upstream", "Send failed");
    return { accepted: true };
  },
  createGroup: async (name: string, members: string[]) => {
    writes.push(["create", name, members]);
    const group = { id: "new", name, isGroup: true, memberIds: members };
    agents.push(group); return group;
  },
  setGroupMembers: async (id: string, members: string[]) => {
    writes.push(["members", id, members]);
    agents.find(a => a.id === id)!.memberIds = members;
  },
  renameGroup: async (group: actual.Agent, name: string) => {
    writes.push(["name", group.id, name]);
    group.name = name;
  },
  setAgentNotifyOnUpdates: async (id: string, isEnabled: boolean) => {
    writes.push(["notify", id, isEnabled]);
    agents.find(a => a.id === id)!.notifyOnUpdatesEnabled = isEnabled;
  },
}));
// server.ts is the published bundle (client.ts inlined), so mocks never reach it.
await import("../server.src.ts");
const call = async (name: string, args: any) => {
  try {
    if (name === "grokbot_send" && args.bot && !args.recipientId) {
      // Simulate the host preparation hook followed by approval. Direct
      // unverified handler calls are tested separately in intents.test.ts.
      await handlers.get("grokbot_show")!({});
      const hook = await handlers.get("voiceos_hook_pre_tool_use")!({ payload_json: JSON.stringify({
        hookApiVersion: 1, event: "preToolUse", toolName: name, args,
      }) });
      const prepared = JSON.parse(hook.content[0].text);
      if (prepared.decision === "block") return { isError: true, error: prepared.responseText };
      args = prepared.updatedArgs ?? args;
    }
    const response = await handlers.get(name)!(args);
    return { ...JSON.parse(response.content[0].text), isError: response.isError };
  } catch (error) { return { isError: true, error: String(error) }; }
};
const demoOf = (html: string) => JSON.parse(html.match(/const DEMO=(.*);/)![1]);
const cardData = (r: any) => demoOf(r._voiceos_glance.blocks[0].html);
beforeEach(() => {
  agents = [...bots.map(a => ({ ...a })), { id: "g", name: "Study group", isGroup: true, memberIds: ["p", "f"] }];
  writes = []; rejectSend = false;
  publishCreated = true;
  tail = EARLIER;
  tailCursor = undefined;
  tailFails = false;
  desktopProbe = { live: false, boxState: "absent" };
  computerWindows = [];
  openedChats = [];
});

test("an offline bot returns a clear result without opening a computer window", async () => {
  const r = await call("grokbot_open_computer_window", { bot: "Piper" });
  expect(r).toMatchObject({
    opened: false,
    bot: "Piper",
    live: false,
    message: "Piper's computer is not running right now.",
  });
  expect(computerWindows).toEqual([]);
  expect(r._voiceos_glance).toBeUndefined();
});

test("a live bot opens one native interactive computer window with plain JSON", async () => {
  const wsUrl = "wss://pod.cursorvm.com/websockify?token=5&network_token=secret";
  desktopProbe = { live: true, wsUrl, viewerUrl: "https://pod.cursorvm.com/vnc.html" };
  const r = await call("grokbot_open_computer_window", { bot: "Piper" });
  expect(computerWindows).toEqual([{ botId: "p", botName: "Piper", botColor: toBot(bots[0]).color, botShape: toBot(bots[0]).shape, wsUrl }]);
  expect(r).toMatchObject({
    opened: true,
    bot: "Piper",
    live: true,
    viewOnly: false,
    message: "Opened Piper's computer in an interactive window.",
  });
  expect(r._voiceos_glance).toBeUndefined();
});

test("the computer-window tool accepts the exact bot ID carried by a screen card", async () => {
  const wsUrl = "wss://pod.cursorvm.com/websockify?token=5&network_token=secret";
  desktopProbe = { live: true, wsUrl, viewerUrl: "https://pod.cursorvm.com/vnc.html" };

  const r = await call("grokbot_open_computer_window", { bot: "p" });

  expect(r.opened).toBe(true);
  expect(r.bot).toBe("Piper");
  expect(computerWindows).toEqual([{ botId: "p", botName: "Piper", botColor: toBot(bots[0]).color, botShape: toBot(bots[0]).shape, wsUrl }]);
});

test("asking for a bot's screen opens the roster card on its screen pane", async () => {
  desktopProbe = {
    live: true,
    wsUrl: "wss://pod.cursorvm.com/websockify?token=5&network_token=secret",
    viewerUrl: "https://pod.cursorvm.com/vnc.html",
  };

  const r = await call("view_bot_desktop_live", { bot: "Piper" });
  const html = r._voiceos_glance.blocks[0].html;
  const manifest = await Bun.file(new URL("../voiceos.integration.json", import.meta.url)).json();
  const tool = manifest.tools.find((candidate: any) => candidate.name === "grokbot_open_computer_window");

  expect(r.live).toBe(true);
  expect(tool.uiCallable).toBe(true);
  expect(tool.confirmation).toBeUndefined();
  // One card for the screen: the show card (with its back button), opened on Piper's screen pane.
  expect(html).toContain('"open":{"bot":"p","screen":true}');
  expect(html).toContain("const ScreenPane=");
  expect(html).toContain("grokbot_open_computer_window");
  // The pane fetches the feed itself; the card never carries the socket's token.
  expect(html).not.toContain("network_token=secret");
});

test("unknown recipients fail lookup without opening a message card", async () => {
  const r = await call("grokbot_prepare_message", { bot: "James", message: "Hello" });
  expect(r.isError).toBe(true);
  expect(r.error).toContain("couldn't find");
  expect(r._voiceos_glance).toBeUndefined();
  expect(writes).toEqual([]);
});
test("live lookup supplies a newly registered bot to an old confirmation", async () => {
  agents.push({ id: "j", name: "James" });
  const r = await call("grokbot_prepare_message", { bot: "James", message: "Hello" });
  expect(r.nextTool).toBe("grokbot_send");
  expect(r.args.bot).toBe("j");
  // The message is written once, in the send itself, never passed through.
  expect(r.args.message).toBeUndefined();
  expect(JSON.parse(r.args.confirmationContext).bots).toContainEqual(expect.objectContaining({ id: "j", name: "James" }));
  expect(writes).toEqual([]);
});
test("a successful lookup returns plain JSON with no glance, so the thread card can open", async () => {
  // A glance on this read-only step makes the notch present it as the turn's
  // result and park the thread card that follows (bare "Piper" header, no card).
  const direct = await call("grokbot_prepare_message", { bot: "Piper", message: "Hello" });
  expect(direct.ready).toBe(true);
  expect(direct._voiceos_glance).toBeUndefined();
  const group = await call("grokbot_prepare_message", { members: ["Piper", "Theo"], groupName: "Research", message: "Hello" });
  expect(group.ready).toBe(true);
  expect(group._voiceos_glance).toBeUndefined();
});
test("message lookup and execution never guess a partial name", async () => {
  agents.push({ id: "j", name: "Jameson" });
  for (const tool of ["grokbot_prepare_message", "grokbot_send"]) {
    const r = await call(tool, { bot: "James", message: "Hello" });
    expect(r.isError).toBe(true);
  }
  expect(writes).toEqual([]);
});
test("group lookup rejects every unresolved member before a confirmation", async () => {
  const r = await call("grokbot_prepare_message", { members: ["Piper", "James"], message: "Hello" });
  expect(r.isError).toBe(true);
  expect(r.error).toContain("couldn't find");
  expect(writes).toEqual([]);
});
test("group lookup preserves drafts and returns resolved member IDs", async () => {
  const r = await call("grokbot_prepare_message", { members: ["Piper", "Theo"], groupName: "Research", message: "Hello" });
  expect(r.nextTool).toBe("grokbot_group");
  expect(r.args).toMatchObject({ members: ["p", "t"], groupName: "Research" });
  expect(r.args.message).toBeUndefined();
  expect(writes).toEqual([]);
});
test("a lookup with no recipient returns every bot's role as plain JSON, never the roster card", async () => {
  const r = await call("grokbot_prepare_message", {});
  expect(r.ready).toBe(false);
  expect(r.nextTool).toBe("grokbot_send");
  expect(r.bots.map((b: any) => b.id)).toEqual(agents.filter(a => !a.isGroup).map(a => a.id));
  expect(r._voiceos_glance).toBeUndefined();
  expect(writes).toEqual([]);
});
test("a voice toggle flips one bot's Notify on updates switch, and skips a no-op write", async () => {
  const off = await call("grokbot_notifications", { bot: "piper", enabled: false });
  expect(off).toMatchObject({ bot: "Piper", notifications: false });
  expect(writes).toEqual([["notify", "p", false]]);
  // Already off: nothing to write.
  await call("grokbot_notifications", { bot: "Piper", enabled: false });
  expect(writes).toEqual([["notify", "p", false]]);
  // Unset means on (the app's default), so turning it on is a no-op too.
  await call("grokbot_notifications", { bot: "Finch", enabled: true });
  expect(writes).toEqual([["notify", "p", false]]);
  expect((await call("grokbot_notifications", { bot: "Nobody", enabled: false })).isError).toBe(true);
});
test("creation reports pending registration without inventing a roster entry", async () => {
  publishCreated = false;
  const r = await call("grokbot_create", { name: "James", description: "Help" });
  expect(r.created).toBe(true);
  expect(r.readyToMessage).toBe(false);
  expect(cardData(r).data.bots.some((b: any) => b.name === "James")).toBe(false);
  const lookup = await call("grokbot_prepare_message", { bot: "James" });
  expect(lookup.isError).toBe(true);
  agents.push({ id: "created", name: "James" });
  expect((await call("grokbot_prepare_message", { bot: "James" })).args.bot).toBe("created");
});

test("voice send sends at once and opens the bot's chat pane with the message marked sent (it flies in)", async () => {
  const r = await call("grokbot_send", { bot: "Piper", message: "Hello." });
  expect(writes).toEqual([["send", "p", "Hello."]]);
  expect(r).toMatchObject({ sent: true, bot: "Piper", sentMessage: "Hello." });
  expect(cardData(r).args).toEqual({ open: { bot: "p" }, message: "Hello.", sent: true });
  // History is read before the send, so the card never shows the message twice.
  expect(cardData(r).data.threads.p.map((i: any) => i.text)).not.toContain("Hello.");
  expect(r._voiceos_glance.blocks[0].html).toContain('<title>Your Bots</title>');
});
test("voice group sends to an existing group at once and opens its chat pane marked sent", async () => {
  const r = await call("grokbot_group", { group: "Study group", message: "Team note." });
  expect(writes).toEqual([["send", "g", "Team note."]]);
  expect(r).toMatchObject({ sent: true, group: "Study group", created: false, sentMessage: "Team note." });
  expect(cardData(r).args).toEqual({ open: { group: "g" }, message: "Team note.", sent: true });
});
test("voice edits to an existing group are saved before the send, and the pane opens on the saved group", async () => {
  const r = await call("grokbot_group", { group: "Study group", members: ["p", "t"], groupName: "Research", message: "Hi." });
  expect(writes).toEqual([["members", "g", ["p", "t"]], ["name", "g", "Research"], ["send", "g", "Hi."]]);
  expect(r).toMatchObject({ sent: true, group: "Research", members: ["p", "t"] });
  expect(cardData(r).args.open).toEqual({ group: "g" });
  expect(cardData(r).data.groups.find((g: any) => g.id === "g").name).toBe("Research");
});
test("voice group with two or more new members creates the group, sends, and opens its chat", async () => {
  const r = await call("grokbot_group", { members: ["p", "t"], groupName: "Research", message: "Kickoff." });
  expect(writes).toEqual([["create", "Research", ["p", "t"]], ["send", "new", "Kickoff."]]);
  expect(r).toMatchObject({ sent: true, created: true, group: "Research", members: ["p", "t"] });
  expect(cardData(r).args).toEqual({ open: { group: "new" }, message: "Kickoff.", sent: true });
  expect(cardData(r).data.groups.some((g: any) => g.id === "new")).toBe(true);
});
test("voice group with one new member keeps the message as a draft on the new-group pane", async () => {
  const r = await call("grokbot_group", { members: ["p"], message: "Draft." });
  expect(writes).toEqual([]);
  expect(r).toMatchObject({ opened: true, sent: false, newGroup: true, draft: "Draft." });
  expect(cardData(r).args).toEqual({ open: { members: ["p"] }, message: "Draft." });
});
test("host string member edits are saved on an existing group before a card send", async () => {
  const r = await call("grokbot_card_send", { group: "g", members: "p,t", groupName: "Research", message: "Draft" });
  expect(writes).toEqual([["members", "g", ["p", "t"]], ["name", "g", "Research"], ["send", "g", "Draft"]]);
  expect(r.sent).toBe(true);
  expect(r.receipt).toBeUndefined();
});
test("voice send and group with no message still open (never error) and never write", async () => {
  const send = await call("grokbot_send", { bot: "Piper" });
  expect(send).toMatchObject({ opened: true, sent: false });
  const group = await call("grokbot_group", { members: ["p", "t"] });
  expect(group).toMatchObject({ opened: true, sent: false, newGroup: true, draft: "" });
  expect(writes).toEqual([]);
});
test("card group send persists edited members and name on the same existing group, with no receipt", async () => {
  const r = await call("grokbot_card_send", { group: "g", members: ["p", "t"], groupName: "Research", message: "Edited" });
  expect(writes).toEqual([["members", "g", ["p", "t"]], ["name", "g", "Research"], ["send", "g", "Edited"]]);
  expect(r).toMatchObject({ sent: true, group: "g", groupName: "Research", members: ["p", "t"] });
  expect(r.receipt).toBeUndefined();
  expect(r._voiceos_glance).toBeUndefined();
});
test("unknown members cannot be silently omitted from the recipients", async () => {
  const r = await call("grokbot_card_send", { members: ["p", "t", "missing"], message: "Start" });
  expect(r.isError).toBe(true);
  expect(writes).toEqual([]);
});
test("card send delivers once and returns no receipt; the card stays open", async () => {
  const r = await call("grokbot_card_send", { bot: "Piper", message: "From the card" });
  expect(writes).toEqual([["send", "p", "From the card"]]);
  expect(r).toMatchObject({ sent: true, bot: "Piper", sentMessage: "From the card" });
  expect(r.receipt).toBeUndefined();
  expect(r._voiceos_glance).toBeUndefined();
});
test("card send refuses empty text and unknown bots without sending", async () => {
  expect((await call("grokbot_card_send", { bot: "Piper", message: "   " })).isError).toBe(true);
  expect((await call("grokbot_card_send", { bot: "Nobody", message: "Hi" })).isError).toBe(true);
  expect(writes).toEqual([]);
});
test("a card send on an existing group reports created:false, and a brand-new group's first send reports created:true — neither returns a receipt", async () => {
  const edited = await call("grokbot_card_send", { group: "g", members: ["p", "t"], groupName: "Research", message: "Edited" });
  expect(writes).toEqual([["members", "g", ["p", "t"]], ["name", "g", "Research"], ["send", "g", "Edited"]]);
  expect(edited).toMatchObject({ sent: true, created: false, group: "g", groupName: "Research", members: ["p", "t"], sentMessage: "Edited" });
  expect(edited.receipt).toBeUndefined();
  writes = [];
  const created = await call("grokbot_card_send", { members: ["p", "f"], groupName: "Study", message: "Start" });
  expect(writes).toEqual([["create", "Study", ["p", "f"]], ["send", "new", "Start"]]);
  expect(created).toMatchObject({ sent: true, created: true, group: "new", groupName: "Study", members: ["p", "f"], sentMessage: "Start" });
  expect(created.receipt).toBeUndefined();
  expect((await call("grokbot_card_send", { message: "no recipient" })).isError).toBe(true);
});
test("the roster card sends only through the confirm-less card tool", async () => {
  const adapter = await Bun.file(new URL("../widgets/show-adapter.js", import.meta.url)).text();
  const show = await Bun.file(new URL("../widgets/show.html", import.meta.url)).text();
  for (const src of [adapter, show]) {
    expect(src).toContain("'grokbot_card_send'");
    expect(src).not.toMatch(/name: (isGroup \? )?'grokbot_(send|group)'/);
    expect(src).not.toContain("invoke('grokbot_send'");
  }
});
test("card send to a group (picked as bot) sends once with no receipt", async () => {
  const r = await call("grokbot_card_send", { bot: "Study group", message: "From the card" });
  expect(writes).toEqual([["send", "g", "From the card"]]);
  expect(r).toMatchObject({ sent: true, group: "g", groupName: "Study group", sentMessage: "From the card" });
  expect(r.receipt).toBeUndefined();
  expect(r._voiceos_glance).toBeUndefined();
});
test("a follow-up card send on an existing group leaves members and name alone", async () => {
  const r = await call("grokbot_card_send", { group: "g", message: "One more thing" });
  expect(writes).toEqual([["send", "g", "One more thing"]]);
  expect(r.sent).toBe(true);
  expect(r.receipt).toBeUndefined();
});
test("a failed card send never marks sent and never returns a receipt", async () => {
  rejectSend = true;
  const r = await call("grokbot_card_send", { bot: "Piper", message: "Hello" });
  expect(r.isError).toBe(true);
  expect(r.sent).not.toBe(true);
  expect(r.receipt).toBeUndefined();
});

test("a deleted bot is rejected before its thread opens, even with previously prepared card data", async () => {
  const ready = await call("grokbot_prepare_message", { bot: "Piper", message: "Hi" });
  agents = agents.filter(a => a.id !== "p");
  const r = await call("grokbot_send", ready.args);
  expect(r.isError).toBe(true);
  expect(writes).toEqual([]);
});
test("duplicate names and deleted group members never send", async () => {
  agents.push({ id: "p2", name: "Piper" });
  expect((await call("grokbot_prepare_message", { bot: "Piper" })).isError).toBe(true);
  agents = agents.filter(a => a.id !== "p");
  expect((await call("grokbot_group", { group: "g", message: "Hello" })).isError).toBe(true);
  expect(writes).toEqual([]);
});

test("existing groups keep one member after removal; empty groups cannot send", async () => {
  const empty = await call("grokbot_card_send", { group: "g", members: [], message: "Hi" });
  expect(empty.isError).toBe(true);
  expect(writes).toEqual([]);
  const one = await call("grokbot_card_send", { group: "g", members: ["p"], message: "Hi" });
  expect(one.sent).toBe(true);
  expect(writes).toEqual([["members", "g", ["p"]], ["send", "g", "Hi"]]);
});
test("script-like text and template-token text remain message data", async () => {
  const message = '</script><script>throw new Error("injected")</script> __VOICEOS_RFB__ $&.';
  const r = await call("grokbot_send", { bot: "Piper", message });
  expect(cardData(r).args.message).toBe(message);
  const scripts = [...r._voiceos_glance.blocks[0].html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  expect(scripts).toHaveLength(1);
  expect(() => new Function(scripts[0][1])).not.toThrow();
});
test("a pending connect card reaches the model as where to connect; a connected one stays silent", async () => {
  tail = [
    { kind: "send-message", message: { type: "connector", connector: "Gmail" }, id: "c1" },
    { kind: "send-message", message: { type: "connector", connector: "Google Calendar", variant: "connected" }, id: "c2" },
  ];
  const r = await call("grokbot_thread", { bot: "Piper" });
  expect(r.thread).toHaveLength(1);
  expect(r.thread[0].text).toContain("connect Gmail");
  expect(r.thread[0].text).toContain("Open in Grok Bot");
});
test("reading a thread gives the model the message text and no card by default", async () => {
  tail = [
    { kind: "message", role: "user", content: "What is my homework?", id: "1", timestampMs: 1_000 },
    { kind: "tool-call", content: "noise", id: "2" },
    { kind: "send-message", message: { type: "text", content: "Math: page 42, due Friday." }, id: "3", timestampMs: 2_000 },
    { kind: "message", role: "user", fromAgent: { id: "f", name: "Finch" }, content: "I can help too.", id: "4" },
  ];
  const r = await call("grokbot_thread", { bot: "Piper" });
  expect(r._voiceos_glance).toBeUndefined();
  expect(r.thread).toEqual([
    { from: "user", text: "What is my homework?", at: new Date(1_000).toISOString() },
    { from: "Piper", text: "Math: page 42, due Friday.", at: new Date(2_000).toISOString() },
    { from: "Finch", text: "I can help too." },
  ]);
  expect(r.truncated).toBe(false);
});
test("reading a thread shows the card only when the user asks to see it", async () => {
  const r = await call("grokbot_thread", { bot: "Piper", show: true });
  expect(cardData(r).args.open).toEqual({ bot: "p" });
  expect(r.thread).toEqual([{ from: "user", text: "Earlier message" }]);
});
test("a long thread keeps the newest messages inside the size limit", async () => {
  tail = Array.from({ length: 6 }, (_, i) => ({ kind: "send-message", message: { content: `${i}:` + "x".repeat(4998) }, id: String(i) }));
  const r = await call("grokbot_thread", { bot: "Piper" });
  expect(r.truncated).toBe(true);
  expect(r.thread.map((m: any) => m.text).join("").length).toBeLessThanOrEqual(12000);
  expect(r.thread.at(-1).text.startsWith("5:")).toBe(true);
  expect(r.thread[0].text.startsWith("0:")).toBe(false);
});
test("manifest advertises exactly the registered server tools", async () => {
  const manifest = await Bun.file(new URL("../voiceos.integration.json", import.meta.url)).json();
  expect(handlers.has("voiceos_hook_pre_tool_use")).toBe(true);
  expect(manifest.hooks.preToolUse.scope).toBe("own");
  expect(manifest.tools.map((t: any) => t.name).sort()).toEqual([...handlers.keys()].filter(name => !name.startsWith("voiceos_hook_")).sort());
  // Voice sends (grokbot_send/grokbot_group) and the card's send arrow
  // (grokbot_card_send) send at once — none carry a host confirmation dialog.
  // grokbot_create is the sole survivor: its card asks the user to review a
  // brand-new bot before it exists.
  for (const name of ["grokbot_prepare_message", "grokbot_send", "grokbot_group", "grokbot_card_send"]) {
    expect(manifest.tools.find((t: any) => t.name === name).confirmation).toBeUndefined();
  }
  const create = manifest.tools.find((t: any) => t.name === "grokbot_create");
  expect(create.confirmation.schemaVersion).toBe(1);
  expect(create.confirmation.root.type).toBe("widget");
  // The per-bot mute acts, so it confirms: a card whose switch is the arg that runs.
  const notify = manifest.tools.find((t: any) => t.name === "grokbot_notifications");
  expect(notify.confirmation.root.type).toBe("card");
  expect(notify.confirmation.root.children.some((c: any) => c.type === "toggle" && c.bind === "{{enabled}}")).toBe(true);
  // grokbot_send / grokbot_group are card-callable.
  for (const name of ["grokbot_send", "grokbot_group"]) {
    expect(manifest.tools.find((t: any) => t.name === name).uiCallable).toBe(true);
  }
  const cardSend = manifest.tools.find((t: any) => t.name === "grokbot_card_send");
  expect(cardSend.uiCallable).toBe(true);
  expect(cardSend.inputSchema.required).toEqual(["message"]);
  expect(Object.keys(cardSend.inputSchema.properties).sort()).toEqual(["bot", "group", "groupName", "members", "message"]);
  // No tool declares the old card-origin `via` metadata any more.
  for (const name of ["grokbot_send", "grokbot_group"]) {
    expect(Object.keys(manifest.tools.find((t: any) => t.name === name).inputSchema.properties)).not.toContain("via");
  }
});

const PICTURE: actual.TranscriptEntry = {
  kind: "send-message", id: "pic", timestampMs: Date.now() - 3 * 60_000,
  message: { type: "text", content: "**Done.** Here it is", images: [{ url: "file:///home/box/secret/a.png", alt: "Shot" }] },
};
test("the roster card opens chat panes populated with card items and their cursors", async () => {
  tail = [...EARLIER, PICTURE];
  tailCursor = 31;
  const r = await call("grokbot_show", {});
  const data = cardData(r).data;
  expect(data.bots.map((b: any) => b.id)).toEqual(["p", "f", "t"]);
  expect(data.threads.p.map((i: any) => i.id)).toEqual(["old", "pic"]);
  expect(data.threads.g).toHaveLength(2);
  expect(data.threads.p[1]).toMatchObject({ html: expect.stringContaining("<strong>Done.</strong>"), media: [{ kind: "image", name: "Shot", index: 0 }], t: "3m" });
  expect(data.nextBeforeSeqs).toMatchObject({ p: 31, g: 31 });
  expect(JSON.stringify(data)).not.toContain("file://");
  expect(r.groups).toEqual([{ name: "Study group", members: ["p", "f"] }]);
});
test("showing one bot opens its conversation on the roster card; a group opens in group mode", async () => {
  tailCursor = 8;
  const one = await call("grokbot_show", { bot: "Piper" });
  expect(one.focus).toBe("Piper");
  expect(cardData(one).args.open).toEqual({ bot: "p" });
  expect(cardData(one).data.threads.p[0]).toMatchObject({ id: "old", from: "me", text: "Earlier message" });
  expect(cardData(one).data.nextBeforeSeqs.p).toBe(8);
  expect(one._voiceos_glance.blocks[0].html).toContain("<title>Your Bots</title>");
  const group = await call("grokbot_show", { bot: "Study group" });
  expect(cardData(group).args.open).toEqual({ group: "g" });
  expect(cardData(group).data.threads.g[0]).toMatchObject({ id: "old" });
});
test("a pending request on an older gateway still marks its bot as needing you", async () => {
  tail = [{ kind: "send-message", id: "ask", message: { type: "widget", widget: { prompt: "Pick", options: [{ label: "A", value: "A" }] } } }];
  const r = await call("grokbot_show", {});
  expect(r.bots.find((b: any) => b.name === "Piper").status).toBe("waiting for you");
  agents[0].awaitingUserResponse = false;
  expect((await call("grokbot_show", {})).bots.find((b: any) => b.name === "Piper").status).toBe("idle");
});
test("the card snapshot returns roster shapes and card items without presentation time", async () => {
  tail = [...EARLIER, PICTURE];
  tailCursor = 12;
  const r = await call("grokbot_card_snapshot", { bot: "p" });
  expect(r.ok).toBe(true);
  expect(r.bots.map((b: any) => b.id)).toEqual(["p", "f", "t"]);
  expect(r.groups).toEqual([expect.objectContaining({ id: "g", members: ["p", "f"] })]);
  expect(r.thread.map((i: any) => i.id)).toEqual(["old", "pic"]);
  expect(r.thread.every((i: any) => !("t" in i))).toBe(true);
  expect(r.nextBeforeSeq).toBe(12);
  expect(JSON.stringify(r)).not.toContain("file://");
  expect(r._voiceos_glance).toBeUndefined();
  expect(await call("grokbot_card_snapshot", { bot: "missing" })).toMatchObject({ ok: false, message: expect.stringContaining("no longer available") });
});
test("reading a thread with show:true opens a group in group mode", async () => {
  const r = await call("grokbot_thread", { bot: "Study group", show: true });
  expect(cardData(r).args.open).toEqual({ group: "g" });
});
test("the send confirmation context stays small when recent replies are huge", async () => {
  tail = [{ kind: "send-message", id: "big", message: { type: "text", content: "| a | b |\n|---|---|\n" + "| `x` | **y** |\n".repeat(3000) } }];
  const r = await call("grokbot_prepare_message", { bot: "Piper", message: "Hi" });
  expect(r.args.confirmationContext.length).toBeLessThan(16_000);
  // A deferred preview is its opening text; the confirmation has no loader.
  const [row] = JSON.parse(r.args.confirmationContext).threads.p;
  expect(row).toMatchObject({ id: "big", text: expect.stringMatching(/…$/) });
  expect(row.html).toBeUndefined();
  expect(row.deferred).toBeUndefined();
});

// What thread.html's own msgHtml draws in a confirmation (no live chat there).
const confirmRowsOf = (context: string, id: string) => JSON.parse(context).threads[id] as any[];
const PENDING: actual.TranscriptEntry[] = [
  { kind: "send-message", id: "ask", author: { id: "t", name: "Theo" }, message: { type: "widget", widget: { prompt: "Which venue for the talk?", options: [{ label: "Hall A", value: "Hall A" }] } } },
  { kind: "notice", id: "note", text: "Theo finished a task" },
  { kind: "notice", id: "blank", text: "" },
  { kind: "user-attachment", id: "file", file_path: "/Users/arav/Private/Q3 report.pdf", file_name: "Q3 report.pdf" },
  { kind: "send-message", id: "shot", message: { type: "text", content: "", images: [{ url: "file:///home/box/a.png", alt: "Concept A" }] } },
  { kind: "send-message", id: "perm", message: { type: "permission-request", permission: { title: "Approve command" } } },
  { kind: "message", role: "user", fromAgent: { id: "f", name: "Finch" }, content: "From Finch", id: "fri" },
];
test("confirmation rows never draw an empty bubble or a nameless orb", async () => {
  tail = PENDING;
  for (const [args, key] of [[{ bot: "Theo", message: "Hall A" }, "t"], [{ group: "Study group", message: "Hi" }, "g"]] as const) {
    const r = await call("grokbot_prepare_message", args);
    const rows = confirmRowsOf(r.args.confirmationContext, key);
    expect(rows.map(i => i.id)).toEqual(["ask", "note", "file", "shot", "perm", "fri"]);
    for (const row of rows) {
      if (row.sys === undefined) expect(Boolean(row.text || row.html)).toBe(true);
      expect(Object.keys(row).every(k => ["id", "from", "bot", "sys", "t", "text", "html"].includes(k))).toBe(true);
    }
    expect(rows[0]).toMatchObject({ from: "bot", bot: "t", text: "Which venue for the talk?" });
    expect(rows[1]).toEqual({ id: "note", from: "bot", sys: "Theo finished a task" });
    expect(rows[2]).toMatchObject({ from: "me", text: "Q3 report.pdf" });
    expect(rows[3]).toMatchObject({ text: "Concept A" });
    expect(rows[4]).toMatchObject({ text: "Approve command" });
    expect(rows[5]).toMatchObject({ bot: "f", html: expect.stringContaining("From Finch") });
    expect(JSON.stringify(rows)).not.toContain("/Users/arav");
  }
});
test("a model-initiated send without preparation still shows the recipient's rows and whole roster", async () => {
  tail = [...EARLIER, { kind: "message", role: "user", fromAgent: { id: "f", name: "Finch" }, content: "From Finch", id: "fri" }];
  await handlers.get("grokbot_show")!({});
  const hook = await handlers.get("voiceos_hook_pre_tool_use")!({ payload_json: JSON.stringify({
    hookApiVersion: 1, event: "preToolUse", toolName: "grokbot_send", args: { bot: "Piper", message: "Hi" },
  }) });
  const { updatedArgs } = JSON.parse(hook.content[0].text);
  expect(updatedArgs.recipientId).toBe("p");
  const context = JSON.parse(updatedArgs.confirmationContext);
  expect(context.bots.map((b: any) => b.id)).toEqual(["p", "f", "t"]);
  expect(context.threads.p.map((i: any) => i.id)).toEqual(["old", "fri"]);
});
test("a group named like a bot does not stop a send to that bot", async () => {
  agents.push({ id: "g2", name: "Piper", isGroup: true, memberIds: ["f", "t"] });
  const r = await call("grokbot_send", { bot: "Piper", message: "Hi." });
  expect(r).toMatchObject({ sent: true, bot: "Piper" });
  expect(writes).toEqual([["send", "p", "Hi."]]);
});
test("showing one bot opens its conversation even when its history cannot be read", async () => {
  tailFails = true;
  const r = await call("grokbot_show", { bot: "Piper" });
  expect(r.isError).toBeFalsy();
  expect(r).toMatchObject({ focus: "Piper", historyUnavailable: true });
  expect(cardData(r).args.open).toEqual({ bot: "p" });
  // showCard only bakes a conversation into `threads` when it has entries, so
  // an empty (failed-read) history for the focused bot leaves its key absent.
  expect(cardData(r).data.threads.p).toBeUndefined();
  tailFails = false;
  expect((await call("grokbot_show", { bot: "Piper" })).historyUnavailable).toBeUndefined();
});

const clickReminder = (actionId: string, data?: Record<string, unknown>) =>
  requestHandlers.get("voiceos/reminders/action")!({
    method: "voiceos/reminders/action",
    params: { notificationId: "n1", actionId, ...(data ? { data } : {}) },
  });

test("reminder Open returns that bot's conversation card for the notch, marked from newSince", async () => {
  const r = await clickReminder("open_chat", { botId: "p", newSince: 1234 });
  expect(r.ok).toBe(true);
  // No fallback text: the host would draw it above the card and cap the card's height.
  expect(r.responseText).toBeUndefined();
  expect(r.view.blocks).toHaveLength(1);
  expect(r.view.blocks[0].type).toBe("widget");
  expect(cardData({ _voiceos_glance: r.view }).args.open).toEqual({ bot: "p", newSince: 1234 });
  // The card is the notch's view now; nothing opens the Grok Bot app.
  expect(openedChats).toEqual([]);
});

test("reminder Open without newSince opens the plain conversation; Close just dismisses", async () => {
  const r = await clickReminder("open_chat", { botId: "p" });
  expect(cardData({ _voiceos_glance: r.view }).args.open).toEqual({ bot: "p" });
  expect(await clickReminder("close")).toEqual({ ok: true });
});

test("reminder Open for a deleted bot fails instead of opening an empty card", async () => {
  await expect(clickReminder("open_chat", { botId: "gone" })).rejects.toThrow("no longer exists");
});

test("an unknown reminder button fails instead of claiming success", async () => {
  await expect(clickReminder("delete_all")).rejects.toThrow("no longer available");
});

test("a spoken message is tidied before it goes out; typed card sends are sent as typed", async () => {
  const { tidySpoken } = await import("../messaging.ts");
  expect(tidySpoken("how's the screen test going")).toBe("How's the screen test going?");
  expect(tidySpoken("check the latest build")).toBe("Check the latest build.");
  expect(tidySpoken("iPhone build looks off")).toBe("iPhone build looks off.");
  expect(tidySpoken("Done!")).toBe("Done!");
  // A long pasted task keeps its paragraphs; only spaces and blank-line runs shrink.
  expect(tidySpoken("  run  the radar.\r\n\n\n\nReply-review phase:  \n check replies ")).toBe("Run the radar.\n\nReply-review phase:\ncheck replies.");
  const r = await call("grokbot_send", { bot: "Piper", message: "how's the screen test going" });
  expect(writes).toEqual([["send", "p", "How's the screen test going?"]]);
  expect(cardData(r).args.message).toBe("How's the screen test going?");
  writes = [];
  await call("grokbot_card_send", { bot: "Piper", message: "lowercase on purpose" });
  expect(writes).toEqual([["send", "p", "lowercase on purpose"]]);
});

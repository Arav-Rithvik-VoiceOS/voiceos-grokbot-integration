import { beforeEach, expect, mock, test } from "bun:test";
import * as actual from "../client.ts";
import { toBot } from "../cards.ts";

// Replace only external boundaries. These tests run the production handlers and cards.
const resolveReal = actual.resolveAgent;
const handlers = new Map<string, (args: any) => Promise<any>>();
const requestHandlers = new Map<string, (req: any) => Promise<any>>();
let openedChats: string[] = [];
const bots: actual.Agent[] = [
  { id: "p", name: "Pepper", avatarColor: "orange" },
  { id: "f", name: "Friday", avatarColor: "green" },
  { id: "t", name: "Titus", avatarColor: "blue" },
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
  agents = [...bots.map(a => ({ ...a })), { id: "g", name: "Homework crew", isGroup: true, memberIds: ["p", "f"] }];
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
  const r = await call("grokbot_open_computer_window", { bot: "Pepper" });
  expect(r).toMatchObject({
    opened: false,
    bot: "Pepper",
    live: false,
    message: "Pepper's computer is not running right now.",
  });
  expect(computerWindows).toEqual([]);
  expect(r._voiceos_glance).toBeUndefined();
});

test("a live bot opens one native interactive computer window with plain JSON", async () => {
  const wsUrl = "wss://pod.cursorvm.com/websockify?token=5&network_token=secret";
  desktopProbe = { live: true, wsUrl, viewerUrl: "https://pod.cursorvm.com/vnc.html" };
  const r = await call("grokbot_open_computer_window", { bot: "Pepper" });
  expect(computerWindows).toEqual([{ botId: "p", botName: "Pepper", botColor: toBot(bots[0]).color, botShape: toBot(bots[0]).shape, wsUrl }]);
  expect(r).toMatchObject({
    opened: true,
    bot: "Pepper",
    live: true,
    viewOnly: false,
    message: "Opened Pepper's computer in an interactive window.",
  });
  expect(r._voiceos_glance).toBeUndefined();
});

test("the computer-window tool accepts the exact bot ID carried by a screen card", async () => {
  const wsUrl = "wss://pod.cursorvm.com/websockify?token=5&network_token=secret";
  desktopProbe = { live: true, wsUrl, viewerUrl: "https://pod.cursorvm.com/vnc.html" };

  const r = await call("grokbot_open_computer_window", { bot: "p" });

  expect(r.opened).toBe(true);
  expect(r.bot).toBe("Pepper");
  expect(computerWindows).toEqual([{ botId: "p", botName: "Pepper", botColor: toBot(bots[0]).color, botShape: toBot(bots[0]).shape, wsUrl }]);
});

test("a live screen card opens its exact bot in the hardened computer-window tool", async () => {
  desktopProbe = {
    live: true,
    wsUrl: "wss://pod.cursorvm.com/websockify?token=5&network_token=secret",
    viewerUrl: "https://pod.cursorvm.com/vnc.html",
  };

  const r = await call("view_bot_desktop_live", { bot: "Pepper" });
  const html = r._voiceos_glance.blocks[0].html;
  const manifest = await Bun.file(new URL("../voiceos.integration.json", import.meta.url)).json();
  const tool = manifest.tools.find((candidate: any) => candidate.name === "grokbot_open_computer_window");

  expect(tool.uiCallable).toBe(true);
  expect(tool.confirmation).toBeUndefined();
  expect(html).toContain("invoke('grokbot_open_computer_window',{bot:B.id})");
  expect(html).not.toContain("grokbot_open_screen");
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
  expect(r.args.message).toBe("Hello");
  expect(JSON.parse(r.args.confirmationContext).bots).toContainEqual(expect.objectContaining({ id: "j", name: "James" }));
  expect(writes).toEqual([]);
});
test("a successful lookup returns plain JSON with no glance, so the thread card can open", async () => {
  // A glance on this read-only step makes the notch present it as the turn's
  // result and park the thread card that follows (bare "Pepper" header, no card).
  const direct = await call("grokbot_prepare_message", { bot: "Pepper", message: "Hello" });
  expect(direct.ready).toBe(true);
  expect(direct._voiceos_glance).toBeUndefined();
  const group = await call("grokbot_prepare_message", { members: ["Pepper", "Titus"], groupName: "Research", message: "Hello" });
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
  const r = await call("grokbot_prepare_message", { members: ["Pepper", "James"], message: "Hello" });
  expect(r.isError).toBe(true);
  expect(r.error).toContain("couldn't find");
  expect(writes).toEqual([]);
});
test("group lookup preserves drafts and returns resolved member IDs", async () => {
  const r = await call("grokbot_prepare_message", { members: ["Pepper", "Titus"], groupName: "Research", message: "Hello" });
  expect(r.nextTool).toBe("grokbot_group");
  expect(r.args).toMatchObject({ members: ["p", "t"], groupName: "Research", message: "Hello" });
  expect(writes).toEqual([]);
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

test("voice send opens the bot's chat pane on the roster card with the draft typed in and sends nothing", async () => {
  const r = await call("grokbot_send", { bot: "Pepper", message: "Draft" });
  expect(writes).toEqual([]);
  expect(r).toMatchObject({ opened: true, sent: false, bot: "Pepper", draft: "Draft" });
  expect(cardData(r).args).toMatchObject({ open: { bot: "p" }, message: "Draft" });
  expect(r._voiceos_glance.blocks[0].html).toContain('<title>Your Bots</title>');
});
test("voice group opens an existing group's chat pane on the roster card with the draft and sends nothing", async () => {
  const r = await call("grokbot_group", { group: "Homework crew", message: "Team draft" });
  expect(writes).toEqual([]);
  expect(r).toMatchObject({ opened: true, sent: false, group: "Homework crew", draft: "Team draft" });
  expect(cardData(r).args).toMatchObject({ open: { group: "g" }, message: "Team draft" });
  expect(r._voiceos_glance.blocks[0].html).toContain('<title>Your Bots</title>');
});
test("voice group with new members opens compose mode and creates nothing", async () => {
  const r = await call("grokbot_group", { members: ["p", "t"], groupName: "Research", message: "Draft" });
  expect(writes).toEqual([]);
  expect(r).toMatchObject({ opened: true, sent: false, newGroup: true, members: ["p", "t"], draft: "Draft" });
  expect(cardData(r).args).toMatchObject({ open: { members: ["p", "t"], groupName: "Research" }, message: "Draft" });
});
test("host string member edits are saved on an existing group before a card send", async () => {
  const r = await call("grokbot_card_send", { group: "g", members: "p,t", groupName: "Research", message: "Draft" });
  expect(writes).toEqual([["members", "g", ["p", "t"]], ["name", "g", "Research"], ["send", "g", "Draft"]]);
  expect(r.sent).toBe(true);
  expect(r.receipt).toBeUndefined();
});
test("voice send and group with no message still open (never error) and never write", async () => {
  const send = await call("grokbot_send", { bot: "Pepper" });
  expect(send).toMatchObject({ opened: true, sent: false, draft: "" });
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
  const r = await call("grokbot_card_send", { bot: "Pepper", message: "From the card" });
  expect(writes).toEqual([["send", "p", "From the card"]]);
  expect(r).toMatchObject({ sent: true, bot: "Pepper", sentMessage: "From the card" });
  expect(r.receipt).toBeUndefined();
  expect(r._voiceos_glance).toBeUndefined();
});
test("card send refuses empty text and unknown bots without sending", async () => {
  expect((await call("grokbot_card_send", { bot: "Pepper", message: "   " })).isError).toBe(true);
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
  const r = await call("grokbot_card_send", { bot: "Homework crew", message: "From the card" });
  expect(writes).toEqual([["send", "g", "From the card"]]);
  expect(r).toMatchObject({ sent: true, group: "g", groupName: "Homework crew", sentMessage: "From the card" });
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
  const r = await call("grokbot_card_send", { bot: "Pepper", message: "Hello" });
  expect(r.isError).toBe(true);
  expect(r.sent).not.toBe(true);
  expect(r.receipt).toBeUndefined();
});

test("a deleted bot is rejected before its thread opens, even with previously prepared card data", async () => {
  const ready = await call("grokbot_prepare_message", { bot: "Pepper", message: "Hi" });
  agents = agents.filter(a => a.id !== "p");
  const r = await call("grokbot_send", ready.args);
  expect(r.isError).toBe(true);
  expect(writes).toEqual([]);
});
test("duplicate names and deleted group members never send", async () => {
  agents.push({ id: "p2", name: "Pepper" });
  expect((await call("grokbot_prepare_message", { bot: "Pepper" })).isError).toBe(true);
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
  const message = '</script><script>throw new Error("injected")</script> __VOICEOS_RFB__ $&';
  const r = await call("grokbot_send", { bot: "Pepper", message });
  expect(cardData(r).args.message).toBe(message);
  const scripts = [...r._voiceos_glance.blocks[0].html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  expect(scripts).toHaveLength(1);
  expect(() => new Function(scripts[0][1])).not.toThrow();
});
test("reading a thread gives the model the message text and no card by default", async () => {
  tail = [
    { kind: "message", role: "user", content: "What is my homework?", id: "1", timestampMs: 1_000 },
    { kind: "tool-call", content: "noise", id: "2" },
    { kind: "send-message", message: { type: "text", content: "Math: page 42, due Friday." }, id: "3", timestampMs: 2_000 },
    { kind: "message", role: "user", fromAgent: { id: "f", name: "Friday" }, content: "I can help too.", id: "4" },
  ];
  const r = await call("grokbot_thread", { bot: "Pepper" });
  expect(r._voiceos_glance).toBeUndefined();
  expect(r.thread).toEqual([
    { from: "user", text: "What is my homework?", at: new Date(1_000).toISOString() },
    { from: "Pepper", text: "Math: page 42, due Friday.", at: new Date(2_000).toISOString() },
    { from: "Friday", text: "I can help too." },
  ]);
  expect(r.truncated).toBe(false);
});
test("reading a thread shows the card only when the user asks to see it", async () => {
  const r = await call("grokbot_thread", { bot: "Pepper", show: true });
  expect(cardData(r).args.open).toEqual({ bot: "p" });
  expect(r.thread).toEqual([{ from: "user", text: "Earlier message" }]);
});
test("a long thread keeps the newest messages inside the size limit", async () => {
  tail = Array.from({ length: 6 }, (_, i) => ({ kind: "send-message", message: { content: `${i}:` + "x".repeat(4998) }, id: String(i) }));
  const r = await call("grokbot_thread", { bot: "Pepper" });
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
  // grokbot_send/grokbot_group now only OPEN a card (never send), and
  // grokbot_card_send is the only tool that ever sends — none of the three
  // carry a host confirmation dialog any more. grokbot_create is the sole
  // survivor: its card asks the user to review a brand-new bot before it exists.
  for (const name of ["grokbot_prepare_message", "grokbot_send", "grokbot_group", "grokbot_card_send"]) {
    expect(manifest.tools.find((t: any) => t.name === name).confirmation).toBeUndefined();
  }
  const create = manifest.tools.find((t: any) => t.name === "grokbot_create");
  expect(create.confirmation.schemaVersion).toBe(1);
  expect(create.confirmation.root.type).toBe("widget");
  // grokbot_send / grokbot_group are card-callable read-only opens.
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
  expect(r.groups).toEqual([{ name: "Homework crew", members: ["p", "f"] }]);
});
test("showing one bot opens its conversation on the roster card; a group opens in group mode", async () => {
  tailCursor = 8;
  const one = await call("grokbot_show", { bot: "Pepper" });
  expect(one.focus).toBe("Pepper");
  expect(cardData(one).args.open).toEqual({ bot: "p" });
  expect(cardData(one).data.threads.p[0]).toMatchObject({ id: "old", from: "me", text: "Earlier message" });
  expect(cardData(one).data.nextBeforeSeqs.p).toBe(8);
  expect(one._voiceos_glance.blocks[0].html).toContain("<title>Your Bots</title>");
  const group = await call("grokbot_show", { bot: "Homework crew" });
  expect(cardData(group).args.open).toEqual({ group: "g" });
  expect(cardData(group).data.threads.g[0]).toMatchObject({ id: "old" });
});
test("a pending request on an older gateway still marks its bot as needing you", async () => {
  tail = [{ kind: "send-message", id: "ask", message: { type: "widget", widget: { prompt: "Pick", options: [{ label: "A", value: "A" }] } } }];
  const r = await call("grokbot_show", {});
  expect(r.bots.find((b: any) => b.name === "Pepper").status).toBe("waiting for you");
  agents[0].awaitingUserResponse = false;
  expect((await call("grokbot_show", {})).bots.find((b: any) => b.name === "Pepper").status).toBe("idle");
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
  const r = await call("grokbot_thread", { bot: "Homework crew", show: true });
  expect(cardData(r).args.open).toEqual({ group: "g" });
});
test("the send confirmation context stays small when recent replies are huge", async () => {
  tail = [{ kind: "send-message", id: "big", message: { type: "text", content: "| a | b |\n|---|---|\n" + "| `x` | **y** |\n".repeat(3000) } }];
  const r = await call("grokbot_prepare_message", { bot: "Pepper", message: "Hi" });
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
  { kind: "send-message", id: "ask", author: { id: "t", name: "Titus" }, message: { type: "widget", widget: { prompt: "Which venue for the talk?", options: [{ label: "Hall A", value: "Hall A" }] } } },
  { kind: "notice", id: "note", text: "Titus finished a task" },
  { kind: "notice", id: "blank", text: "" },
  { kind: "user-attachment", id: "file", file_path: "/Users/arav/Private/Q3 report.pdf", file_name: "Q3 report.pdf" },
  { kind: "send-message", id: "shot", message: { type: "text", content: "", images: [{ url: "file:///home/box/a.png", alt: "Concept A" }] } },
  { kind: "send-message", id: "perm", message: { type: "permission-request", permission: { title: "Approve command" } } },
  { kind: "message", role: "user", fromAgent: { id: "f", name: "Friday" }, content: "From Friday", id: "fri" },
];
test("confirmation rows never draw an empty bubble or a nameless orb", async () => {
  tail = PENDING;
  for (const [args, key] of [[{ bot: "Titus", message: "Hall A" }, "t"], [{ group: "Homework crew", message: "Hi" }, "g"]] as const) {
    const r = await call("grokbot_prepare_message", args);
    const rows = confirmRowsOf(r.args.confirmationContext, key);
    expect(rows.map(i => i.id)).toEqual(["ask", "note", "file", "shot", "perm", "fri"]);
    for (const row of rows) {
      if (row.sys === undefined) expect(Boolean(row.text || row.html)).toBe(true);
      expect(Object.keys(row).every(k => ["id", "from", "bot", "sys", "t", "text", "html"].includes(k))).toBe(true);
    }
    expect(rows[0]).toMatchObject({ from: "bot", bot: "t", text: "Which venue for the talk?" });
    expect(rows[1]).toEqual({ id: "note", from: "bot", sys: "Titus finished a task" });
    expect(rows[2]).toMatchObject({ from: "me", text: "Q3 report.pdf" });
    expect(rows[3]).toMatchObject({ text: "Concept A" });
    expect(rows[4]).toMatchObject({ text: "Approve command" });
    expect(rows[5]).toMatchObject({ bot: "f", html: expect.stringContaining("From Friday") });
    expect(JSON.stringify(rows)).not.toContain("/Users/arav");
  }
});
test("a model-initiated send without preparation still shows the recipient's rows and whole roster", async () => {
  tail = [...EARLIER, { kind: "message", role: "user", fromAgent: { id: "f", name: "Friday" }, content: "From Friday", id: "fri" }];
  await handlers.get("grokbot_show")!({});
  const hook = await handlers.get("voiceos_hook_pre_tool_use")!({ payload_json: JSON.stringify({
    hookApiVersion: 1, event: "preToolUse", toolName: "grokbot_send", args: { bot: "Pepper", message: "Hi" },
  }) });
  const { updatedArgs } = JSON.parse(hook.content[0].text);
  expect(updatedArgs.recipientId).toBe("p");
  const context = JSON.parse(updatedArgs.confirmationContext);
  expect(context.bots.map((b: any) => b.id)).toEqual(["p", "f", "t"]);
  expect(context.threads.p.map((i: any) => i.id)).toEqual(["old", "fri"]);
});
test("a group named like a bot does not stop an approved open for that bot", async () => {
  agents.push({ id: "g2", name: "Pepper", isGroup: true, memberIds: ["f", "t"] });
  const r = await call("grokbot_send", { bot: "Pepper", message: "Hi" });
  expect(r).toMatchObject({ opened: true, sent: false, bot: "Pepper" });
  expect(writes).toEqual([]);
});
test("showing one bot opens its conversation even when its history cannot be read", async () => {
  tailFails = true;
  const r = await call("grokbot_show", { bot: "Pepper" });
  expect(r.isError).toBeFalsy();
  expect(r).toMatchObject({ focus: "Pepper", historyUnavailable: true });
  expect(cardData(r).args.open).toEqual({ bot: "p" });
  // showCard only bakes a conversation into `threads` when it has entries, so
  // an empty (failed-read) history for the focused bot leaves its key absent.
  expect(cardData(r).data.threads.p).toBeUndefined();
  tailFails = false;
  expect((await call("grokbot_show", { bot: "Pepper" })).historyUnavailable).toBeUndefined();
});

const clickReminder = (actionId: string, data?: Record<string, unknown>) =>
  requestHandlers.get("voiceos/reminders/action")!({
    method: "voiceos/reminders/action",
    params: { notificationId: "n1", actionId, ...(data ? { data } : {}) },
  });

test("reminder Open opens that bot's chat and Close just dismisses", async () => {
  expect(await clickReminder("open_chat", { botId: "p" })).toEqual({ ok: true });
  expect(openedChats).toEqual(["p"]);
  expect(await clickReminder("close")).toEqual({ ok: true });
  expect(openedChats).toEqual(["p"]);
});

test("an unknown reminder button fails instead of claiming success", async () => {
  await expect(clickReminder("delete_all")).rejects.toThrow("no longer available");
});

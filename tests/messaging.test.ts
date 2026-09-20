import { beforeEach, expect, mock, test } from "bun:test";
import * as actual from "../client.ts";

// Replace only external boundaries. These tests run the production handlers and cards.
const resolveReal = actual.resolveAgent;
const handlers = new Map<string, (args: any) => Promise<any>>();
const bots: actual.Agent[] = [
  { id: "p", name: "Pepper", avatarColor: "orange" },
  { id: "f", name: "Friday", avatarColor: "green" },
  { id: "t", name: "Titus", avatarColor: "blue" },
];
let agents: actual.Agent[], writes: any[], rejectSend: boolean;
let publishCreated = true;
const EARLIER: actual.TranscriptEntry[] = [{ kind: "message", role: "user", content: "Earlier message", id: "old" }];
let tail: actual.TranscriptEntry[] = EARLIER;
let desktopProbe: Awaited<ReturnType<typeof actual.agentScreen>>;
let computerWindows: Array<{ botId: string; botName: string; wsUrl: string }>;
mock.module("@modelcontextprotocol/sdk/server/mcp.js", () => ({ McpServer: class {
  server = { request: async () => ({ notificationId: "test" }) };
  registerTool(name: string, _schema: any, handler: any) { handlers.set(name, handler); }
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
  transcriptTail: async () => ({ entries: tail }),
  agentScreen: async () => desktopProbe,
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
    const response = await handlers.get(name)!(args);
    return { ...JSON.parse(response.content[0].text), isError: response.isError };
  } catch (error) { return { isError: true, error: String(error) }; }
};
const cardData = (r: any) => {
  const html = r._voiceos_glance.blocks[0].html;
  return JSON.parse(html.match(/const DEMO=(.*);/)[1]);
};
beforeEach(() => {
  agents = [...bots.map(a => ({ ...a })), { id: "g", name: "Homework crew", isGroup: true, memberIds: ["p", "f"] }];
  writes = []; rejectSend = false;
  publishCreated = true;
  tail = EARLIER;
  desktopProbe = { live: false, boxState: "absent" };
  computerWindows = [];
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

test("a live bot opens one native view-only computer window with plain JSON", async () => {
  const wsUrl = "wss://pod.cursorvm.com/websockify?token=5&network_token=secret";
  desktopProbe = { live: true, wsUrl, viewerUrl: "https://pod.cursorvm.com/vnc.html" };
  const r = await call("grokbot_open_computer_window", { bot: "Pepper" });
  expect(computerWindows).toEqual([{ botId: "p", botName: "Pepper", wsUrl }]);
  expect(r).toMatchObject({
    opened: true,
    bot: "Pepper",
    live: true,
    viewOnly: true,
    message: "Opened Pepper's computer in a view-only window.",
  });
  expect(r._voiceos_glance).toBeUndefined();
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
test("a successful lookup returns plain JSON with no glance, so the send confirmation can open", async () => {
  // A glance on this read-only step makes the notch present it as the turn's
  // result and park the confirmation that follows (bare "Pepper" header, no card).
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

test("confirmed voice send executes once and returns 1D without another draft", async () => {
  const r = await call("grokbot_send", { bot: "Pepper", message: "Draft" });
  expect(writes).toEqual([["send", "p", "Draft"]]);
  expect(r.sent).toBe(true);
  expect(r.composing).toBeUndefined();
  expect(r.receipt.html).toContain('<title>Message sent</title>');
});
test("arrow direct send returns the 1D receipt with the edited text", async () => {
  const r = await call("grokbot_send", { bot: "p", message: "Edited", via: "card" });
  expect(writes).toEqual([["send", "p", "Edited"]]);
  expect(r.sent).toBe(true);
  expect(r.receipt.html).toContain('<title>Message sent</title>');
  expect(cardData(r).args.message).toBe("Edited");
});
test("confirmed existing group sends once and returns its conversation", async () => {
  const r = await call("grokbot_group", { group: "Homework crew", message: "Team draft" });
  expect(writes).toEqual([["send", "g", "Team draft"]]);
  expect(r.sent).toBe(true);
  expect(r._voiceos_glance.blocks[0].html).toContain('<title>Sent to group</title>');
  expect(r.receipt.html).toContain('<title>Sent to group</title>');
  expect(cardData(r).args.group).toBe("g");
});
test("confirmed new group creates once and returns its conversation", async () => {
  const r = await call("grokbot_group", { members: ["p", "t"], groupName: "Research", message: "Draft" });
  expect(writes).toEqual([["create", "Research", ["p", "t"]], ["send", "new", "Draft"]]);
  expect(r.sent).toBe(true);
});
test("host string edits update members and group name", async () => {
  const r = await call("grokbot_group", { group: "g", members: "p,t", groupName: "Research", message: "Draft" });
  expect(writes).toEqual([["members", "g", ["p", "t"]], ["name", "g", "Research"], ["send", "g", "Draft"]]);
  expect(r.sent).toBe(true);
});
test("empty confirmed messages never write or open a second draft", async () => {
  for (const [tool, args] of [["grokbot_send", {bot:"Pepper"}], ["grokbot_group", {members:["p","t"]}]] as const) {
    const r = await call(tool, args);
    expect(r.isError).toBe(true);
    expect(r.composing).toBeUndefined();
  }
  expect(writes).toEqual([]);
});
test("group arrow persists edited members and name on the same group before send", async () => {
  const r = await call("grokbot_group", { group: "g", members: ["p", "t"], groupName: "Research", message: "Edited", via: "card" });
  expect(writes).toEqual([["members", "g", ["p", "t"]], ["name", "g", "Research"], ["send", "g", "Edited"]]);
  expect(r.sent).toBe(true);
  expect(cardData(r).data.groups[0]).toMatchObject({ id: "g", name: "Research", members: ["p", "t"] });
  expect(r._voiceos_glance.blocks[0].html).toContain('<title>Sent to group</title>');
});
test("first send creates once, then sends to the created group", async () => {
  const r = await call("grokbot_group", { members: ["p", "t"], groupName: "Research", message: "Start", via: "card" });
  expect(writes).toEqual([["create", "Research", ["p", "t"]], ["send", "new", "Start"]]);
  expect(r.sent).toBe(true);
});
test("unknown members cannot be silently omitted from the recipients", async () => {
  const r = await call("grokbot_group", { members: ["p", "t", "missing"], message: "Start", via: "card" });
  expect(r.isError).toBe(true);
  expect(writes).toEqual([]);
});
test("card send goes through grokbot_card_send once and returns the 1D receipt", async () => {
  const r = await call("grokbot_card_send", { bot: "Pepper", message: "From the card" });
  expect(writes).toEqual([["send", "p", "From the card"]]);
  expect(r.sent).toBe(true);
  expect(r.receipt.html).toContain('<title>Message sent</title>');
  expect(cardData(r).args.message).toBe("From the card");
});
test("card send refuses empty text and unknown bots without sending", async () => {
  expect((await call("grokbot_card_send", { bot: "Pepper", message: "   " })).isError).toBe(true);
  expect((await call("grokbot_card_send", { bot: "Nobody", message: "Hi" })).isError).toBe(true);
  expect(writes).toEqual([]);
});
test("card group send saves edits, creates on first send, and returns the group receipt", async () => {
  const edited = await call("grokbot_card_send", { group: "g", members: ["p", "t"], groupName: "Research", message: "Edited" });
  expect(writes).toEqual([["members", "g", ["p", "t"]], ["name", "g", "Research"], ["send", "g", "Edited"]]);
  expect(edited.receipt.html).toContain('<title>Sent to group</title>');
  writes = [];
  const created = await call("grokbot_card_send", { members: ["p", "f"], groupName: "Study", message: "Start" });
  expect(writes).toEqual([["create", "Study", ["p", "f"]], ["send", "new", "Start"]]);
  expect(created.sent).toBe(true);
  expect((await call("grokbot_card_send", { message: "no recipient" })).isError).toBe(true);
});
test("thread-card adapter sends only through the confirm-less card tool", async () => {
  const adapter = await Bun.file(new URL("../widgets/messaging-adapter.js", import.meta.url)).text();
  const show = await Bun.file(new URL("../widgets/show.html", import.meta.url)).text();
  for (const src of [adapter, show]) {
    expect(src).toContain("'grokbot_card_send'");
    expect(src).not.toMatch(/name: (isGroup \? )?'grokbot_(send|group)'/);
    expect(src).not.toContain("invoke('grokbot_send'");
  }
});
test("card send to a group sends once and returns the group receipt", async () => {
  const r = await call("grokbot_card_send", { bot: "Homework crew", message: "From the card" });
  expect(writes).toEqual([["send", "g", "From the card"]]);
  expect(r.sent).toBe(true);
  expect(r.group).toBe("g");
  expect(r.receipt.html).toContain('<title>Sent to group</title>');
  expect(cardData(r).args.group).toBe("g");
});
test("sent receipts carry a follow-up bar that sends through the confirm-less card tool", async () => {
  const one = (await call("grokbot_send", { bot: "Pepper", message: "First" })).receipt.html;
  const many = (await call("grokbot_group", { group: "g", message: "First" })).receipt.html;
  expect(one).toContain("invoke('grokbot_card_send',{bot:B.id,message:v})");
  expect(many).toContain("invoke('grokbot_card_send',{group:G.id,message:v})");
  for (const html of [one, many]) {
    expect(html).toContain('id="mmsg"');
    expect(html).toContain("offset-path");
    // Card iframes are sandboxed without allow-forms: a <form> submit never fires.
    expect(html).not.toContain("<form");
    // The receipt shows no bot replies, so it must not poll (polling mutes the reply pill).
    expect(html).not.toContain("grokbot_reply_check");
  }
});
test("a follow-up from the group receipt sends once and leaves members and name alone", async () => {
  const r = await call("grokbot_card_send", { group: "g", message: "One more thing" });
  expect(writes).toEqual([["send", "g", "One more thing"]]);
  expect(r.sent).toBe(true);
});
test("failed sends never produce a sent receipt", async () => {
  rejectSend = true;
  const r = await call("grokbot_send", { bot: "Pepper", message: "Hello", via: "card" });
  expect(r.isError).toBe(true);
  expect(r.sent).not.toBe(true);
  expect(r.receipt).toBeUndefined();
});

test("a deleted bot is rejected at send time even with previously prepared card data", async () => {
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
  const empty = await call("grokbot_group", { group: "g", members: [], message: "Hi", via: "card" });
  expect(empty.isError).toBe(true);
  expect(writes).toEqual([]);
  const one = await call("grokbot_group", { group: "g", members: ["p"], message: "Hi", via: "card" });
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
  expect(cardData(r).args.bot).toBeDefined();
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
  expect(manifest.tools.map((t: any) => t.name).sort()).toEqual([...handlers.keys()].sort());
  expect(manifest.tools.find((t: any) => t.name === "grokbot_prepare_message").confirmation).toBeUndefined();
  for (const name of ["grokbot_send", "grokbot_group"]) {
    const tool = manifest.tools.find((t: any) => t.name === name);
    expect(tool.confirmation.schemaVersion).toBe(1);
    expect(tool.confirmation.root.type).toBe("widget");
    expect(tool.confirmation.root.html).toContain('<title>Thread</title>');
    expect(tool.confirmation.root.html).toContain('voiceos:updateInput');
    expect(tool.confirmation.root.html).not.toContain('voiceos:invokeTool');
    expect(tool.confirmation.root.html.length).toBeLessThanOrEqual(60000);
    expect(tool.confirmation.root.confirmLabel).toBe("↑");
    expect(tool.uiCallable).toBe(true);
  }
  // The card's send tool: card-callable, but NO confirmation block — that is
  // the whole point (no host "Confirm action" dialog over the card).
  const cardSend = manifest.tools.find((t: any) => t.name === "grokbot_card_send");
  expect(cardSend.uiCallable).toBe(true);
  expect(cardSend.confirmation).toBeUndefined();
  expect(cardSend.inputSchema.required).toEqual(["message"]);
  expect(Object.keys(cardSend.inputSchema.properties).sort()).toEqual(["bot", "group", "groupName", "members", "message"]);
});

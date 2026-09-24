import { expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { intentErrors, resolveIntentSlots, matchIntentTemplate, INTENT_SLOT_VALUES_META_KEY, INTENT_REFRESH_NOTIFICATION_METHOD } from "./sdk/intents.ts";
import type { PreToolUseHookInput } from "./sdk/hooks.ts";
import { intents, IntentRoster, botIntentNames, resolveApprovedRecipient, registerIntentSupport } from "./intents.ts";
import type { Agent } from "./client.ts";
import { GROK_COLOR_HEX } from "./cards.ts";
import manifest from "./voiceos.integration.json";

const agents: Agent[] = [
  { id: "terry", name: "Terry", avatarColor: "magenta", avatarShape: "pebble" },
  { id: "seo", name: "SEO Master", avatarColor: "green", avatarShape: "hex" },
  { id: "group", name: "Blog Generation", isGroup: true, memberIds: ["terry", "seo"] },
];
const hook = (args: Record<string, unknown>): PreToolUseHookInput => ({
  hookApiVersion: 1, event: "preToolUse", toolName: "grokbot_send", args,
});

test("shipped show and send intents use the SDK contract and retain approval", () => {
  expect<unknown>(manifest.intents).toEqual(intents);
  expect(intentErrors(intents, manifest.tools)).toEqual([]);
  expect(manifest.tools.find(t => t.name === "grokbot_send")?.confirmation).toBeDefined();
  expect(manifest.hooks).toEqual({ preToolUse: { scope: "own" } });
  expect(matchIntentTemplate(intents[0], "show my Grok bots")).toEqual({});
  expect(matchIntentTemplate(intents[0], "Grok Bot show")).toEqual({});
  const resolved = resolveIntentSlots(intents[1], { properties: { bot: { type: "string" } } }, { bot: ["SEO Master"] })!;
  expect(matchIntentTemplate(resolved, "show Grok bot SEO Master")).toEqual({ bot: "SEO Master" });
  expect(matchIntentTemplate(resolved, "show Grok bot Missing")).toBeNull();
  expect(resolveIntentSlots(intents[2], {}, { bot: [] })).toBeUndefined();
});

test("live enums include individual names, excluding ambiguous names and oversized lists", () => {
  expect(botIntentNames(agents)).toEqual(["SEO Master", "Terry"]);
  expect(botIntentNames([...agents, { id: "duplicate", name: "terry" }])).toEqual(["SEO Master"]);
  expect(botIntentNames([{ id: "blank", name: " " }, { id: "long", name: "x".repeat(201) }])).toEqual([]);
  expect(botIntentNames(Array.from({ length: 31 }, (_, i) => ({ id: String(i), name: `Bot ${i}` })))).toEqual([]);
});

test("roster changes publish new choices once; outages clear old names", async () => {
  let current = agents;
  let reads = 0;
  let fail = false;
  const roster = new IntentRoster(async () => { reads++; if (fail) throw Error("offline"); return current; });
  const published: string[][] = [];
  roster.onChoices = names => published.push(names);
  await Promise.all([roster.refresh(), roster.refresh()]);
  expect(reads).toBe(1);
  await roster.refresh();
  expect(published).toEqual([["SEO Master", "Terry"]]);
  current = [{ id: "terry", name: "New Terry" }];
  await roster.refresh();
  expect(published.at(-1)).toEqual(["New Terry"]);
  fail = true;
  await expect(roster.refresh()).rejects.toThrow("offline");
  expect(published.at(-1)).toEqual([]);
  expect((await roster.beforeTool(hook({ bot: "New Terry" }))).decision).toBe("block");
});

test("preparation keeps the enum name, supplies native identity, and leaves approval to VoiceOS", async () => {
  let now = 1000;
  const roster = new IntentRoster(async () => agents, () => now);
  expect((await roster.beforeTool(hook({ bot: "Terry" }))).decision).toBe("block");
  await roster.refresh();
  const prepared = await roster.beforeTool(hook({ bot: "Terry", message: "Check the draft" }));
  expect(prepared.decision).toBeUndefined();
  expect(prepared.updatedArgs).toMatchObject({ bot: "Terry", recipientId: "terry", message: "Check the draft" });
  const context = JSON.parse(prepared.updatedArgs!.confirmationContext as string);
  // Every individual bot (rows from other bots resolve their names), no groups.
  expect(context.bots.map((b: { id: string }) => b.id)).toEqual(["terry", "seo"]);
  expect(context.groups).toEqual([]);
  // The card's own roster shape (cards.ts toBot), in Grok's palette.
  expect(context.bots[0]).toMatchObject({ id: "terry", name: "Terry", color: GROK_COLOR_HEX.magenta, shape: "pebble" });
  expect((await roster.beforeTool(hook({ bot: "Missing" }))).decision).toBe("block");
  expect((await roster.beforeTool(hook({ bot: "Blog Generation" }))).decision).toBe("block");
  expect(await roster.beforeTool({ ...hook({}), toolName: "grokbot_show" })).toEqual({});
  now += 90_001;
  expect((await roster.beforeTool(hook({ bot: "Terry" }))).decision).toBe("block");
});

const ctx = (r: { updatedArgs?: Record<string, unknown> }) => JSON.parse(r.updatedArgs!.confirmationContext as string);
const prepared = (threads: Record<string, unknown[]>) =>
  JSON.stringify({ bots: [{ id: "terry", name: "Terry" }, { id: "seo", name: "SEO Master" }], groups: [], threads });

test("a mangled or foreign prepared context never blocks the send; it only loses its rows", async () => {
  const roster = new IntentRoster(async () => agents);
  await roster.refresh();
  for (const confirmationContext of ['{"bots":[', "null", "oops", "[]", prepared({ seo: [{ id: "x", from: "bot", text: "hi", html: "<p>hi</p>" }] })]) {
    const r = await roster.beforeTool(hook({ bot: "Terry", message: "Hi", confirmationContext }));
    expect(r.decision).toBeUndefined();
    expect(r.updatedArgs!.recipientId).toBe("terry");
    expect(ctx(r).threads).toEqual({});
  }
});

test("copied rows are rebuilt: markup from their text, `from` one of two words", async () => {
  const roster = new IntentRoster(async () => agents);
  await roster.refresh();
  const evil = [
    { id: "1", from: 'bot"><img src=x onerror=alert(1)>', text: "**Done**", html: '<img src=x onerror="parent.postMessage(1)">' },
    { id: "2", from: "me", text: "Plan", t: "5m", junk: "<script>" },
  ];
  const r = await roster.beforeTool(hook({ bot: "Terry", message: "Hi", confirmationContext: prepared({ terry: evil }) }));
  const rows = ctx(r).threads.terry;
  expect(rows).toEqual([
    { id: "1", from: "bot", text: "**Done**", html: "<p><strong>Done</strong></p>\n" },
    { id: "2", from: "me", t: "5m", text: "Plan" },
  ]);
  expect(JSON.stringify(rows)).not.toContain("onerror");
  // The group confirmation gets the same treatment, and a roster from the live cache.
  const group = await roster.beforeTool({ ...hook({ group: "group", message: "Hi", confirmationContext: JSON.stringify({ bots: [{ id: "terry", name: "Terry", shape: 'x" onmouseover="alert(1)' }], groups: [], threads: { group: evil } }) }), toolName: "grokbot_group" });
  const g = ctx(group);
  expect(g.bots.map((b: { shape: string }) => b.shape)).toEqual(["pebble", "hex"]);
  expect(g.groups).toEqual([expect.objectContaining({ id: "group", members: ["terry", "seo"] })]);
  expect(g.threads.group[0]).toEqual({ id: "1", from: "bot", text: "**Done**", html: "<p><strong>Done</strong></p>\n" });
  expect(JSON.stringify(g)).not.toContain("onerror");
  // No context: the card's own frozen roster applies, untouched.
  expect(await roster.beforeTool({ ...hook({ group: "group", message: "Hi" }), toolName: "grokbot_group" })).toEqual({});
});

test("rows that mention another bot keep that bot's name, orb and color", async () => {
  const roster = new IntentRoster(async () => agents);
  await roster.refresh();
  const rows = [
    { id: "m", from: "bot", bot: "seo", text: "From SEO", html: "<p>From SEO</p>" },
    { id: "s", from: "bot", bot: "seo", sys: "Messaged" },
    { id: "n", from: "bot", sys: "Terry finished a task" },
  ];
  const r = await roster.beforeTool(hook({ bot: "Terry", message: "Hi", confirmationContext: prepared({ terry: rows }) }));
  const c = ctx(r);
  expect(c.bots.find((b: { id: string }) => b.id === "seo")).toMatchObject({ name: "SEO Master", color: GROK_COLOR_HEX.green, shape: "hex" });
  expect(c.threads.terry.map((i: { id: string }) => i.id)).toEqual(["m", "s", "n"]);
  expect(c.threads.terry[2]).toEqual({ id: "n", from: "bot", sys: "Terry finished a task" });
});

test("a send that skipped preparation reads the recipient's rows, but never waits long for them", async () => {
  const roster = new IntentRoster(async () => agents);
  await roster.refresh();
  const asked: string[] = [];
  roster.recentRows = async id => { asked.push(id); return [{ id: "r", from: "bot", text: "Recent", html: "<p>Recent</p>" }]; };
  const direct = await roster.beforeTool(hook({ bot: "Terry", message: "Hi" }));
  expect(asked).toEqual(["terry"]);
  expect(ctx(direct).threads.terry).toEqual([{ id: "r", from: "bot", text: "Recent", html: "<p>Recent</p>" }]);
  // Prepared rows are used as they are: no second read.
  await roster.beforeTool(hook({ bot: "Terry", message: "Hi", confirmationContext: prepared({ terry: [] }) }));
  expect(asked).toEqual(["terry"]);
  roster.recentRows = () => new Promise(() => {});
  const started = Date.now();
  const slow = await roster.beforeTool(hook({ bot: "Terry", message: "Hi" }));
  expect(Date.now() - started).toBeLessThan(1_500);
  expect(slow.updatedArgs).toMatchObject({ recipientId: "terry" });
  expect(ctx(slow).threads).toEqual({});
  roster.recentRows = async () => { throw new Error("gateway down"); };
  expect((await roster.beforeTool(hook({ bot: "Terry", message: "Hi" }))).updatedArgs).toMatchObject({ recipientId: "terry" });
});

test("approved name cannot redirect to a replacement bot or skip preparation", () => {
  expect(resolveApprovedRecipient("Terry", "terry", agents).id).toBe("terry");
  expect(resolveApprovedRecipient("terry", undefined, agents).id).toBe("terry");
  expect(() => resolveApprovedRecipient("Terry", undefined, agents)).toThrow("wasn't verified");
  expect(() => resolveApprovedRecipient("Terry", "terry", [{ id: "replacement", name: "Terry" }])).toThrow("changed");
  expect(() => resolveApprovedRecipient("Terry", "terry", [{ id: "terry", name: "Renamed" }])).toThrow("couldn't find");
  expect(() => resolveApprovedRecipient("Terry", "terry", [...agents, { id: "duplicate", name: "Terry" }])).toThrow("More than one");
  // A group may share a bot's name: the hook and the send both resolve individuals.
  expect(resolveApprovedRecipient("Terry", "terry", [...agents, { id: "g2", name: "Terry", isGroup: true }]).id).toBe("terry");
});

test("a bot sharing a group's name is published, verified and sent to", async () => {
  const withGroup = [...agents, { id: "g2", name: "Terry", isGroup: true }];
  const roster = new IntentRoster(async () => withGroup);
  await roster.refresh();
  expect(botIntentNames(withGroup)).toEqual(["SEO Master", "Terry"]);
  const r = await roster.beforeTool(hook({ bot: "Terry", message: "Hi" }));
  expect(r.updatedArgs!.recipientId).toBe("terry");
  expect(resolveApprovedRecipient("Terry", r.updatedArgs!.recipientId as string, withGroup).id).toBe("terry");
});

test("actual MCP tools/list metadata and refresh notification carry current enum choices", async () => {
  const server = new McpServer({ name: "grok-intent-test", version: "1" });
  const client = new Client({ name: "intent-test-host", version: "1" });
  let current = agents;
  const roster = new IntentRoster(async () => current);
  const tools = ["grokbot_show", "grokbot_send"].map(name => server.registerTool(name, {
    inputSchema: { bot: z.string().optional(), message: z.string().optional() },
    _meta: { [INTENT_SLOT_VALUES_META_KEY]: { bot: [] } },
  }, async () => { throw new Error("No message tools should execute in this test"); }));
  const support = registerIntentSupport(server, tools, roster, error => { throw error; });
  let changes = 0;
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => { changes++; });
  const [hostTransport, appTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(appTransport), client.connect(hostTransport)]);
    support.start();
    await roster.refresh();
    const listed = await client.listTools();
    for (const name of ["grokbot_show", "grokbot_send"]) {
      expect(listed.tools.find(t => t.name === name)?._meta?.[INTENT_SLOT_VALUES_META_KEY]).toEqual({ bot: ["SEO Master", "Terry"] });
    }
    const prepared = await client.callTool({ name: "voiceos_hook_pre_tool_use", arguments: { payload_json: JSON.stringify(hook({ bot: "Terry", message: "Review this" })) } });
    const args = JSON.parse((prepared.content as { text: string }[])[0].text).updatedArgs;
    expect(args).toMatchObject({ bot: "Terry", recipientId: "terry", message: "Review this" });
    const before = changes;
    current = [{ id: "sol", name: "Sol" }];
    await client.notification({ method: INTENT_REFRESH_NOTIFICATION_METHOD });
    for (let i = 0; i < 40 && changes === before; i++) await Bun.sleep(5);
    expect(changes).toBeGreaterThan(before);
    expect((await client.listTools()).tools.find(t => t.name === "grokbot_send")?._meta?.[INTENT_SLOT_VALUES_META_KEY]).toEqual({ bot: ["Sol"] });
  } finally {
    support.stop();
    await client.close();
    await server.close();
  }
});

test("upstream screen, chat and create shortcuts coexist with verified sends", () => {
  const byName = Object.fromEntries(intents.map(intent => [intent.name, intent]));
  expect(byName.view_screen.tool).toBe("view_bot_desktop_live");
  expect(byName.open_chat.fixedArgs).toEqual({ show: true });
  expect(byName.create_bot.tool).toBe("grokbot_create");
  expect(byName.send_message.tool).toBe("grokbot_send");
  expect(intents.some(intent => intent.tool === "grokbot_open_computer_window")).toBe(false);
  const create = manifest.tools.find(tool => tool.name === "grokbot_create");
  expect(create?.confirmation).toBeDefined();
});

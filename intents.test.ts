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
  expect(roster.beforeTool(hook({ bot: "New Terry" })).decision).toBe("block");
});

test("preparation keeps the enum name, supplies native identity, and leaves approval to VoiceOS", async () => {
  let now = 1000;
  const roster = new IntentRoster(async () => agents, () => now);
  expect(roster.beforeTool(hook({ bot: "Terry" })).decision).toBe("block");
  await roster.refresh();
  const prepared = roster.beforeTool(hook({ bot: "Terry", message: "Check the draft" }));
  expect(prepared.decision).toBeUndefined();
  expect(prepared.updatedArgs).toMatchObject({ bot: "Terry", recipientId: "terry", message: "Check the draft" });
  const context = JSON.parse(prepared.updatedArgs!.confirmationContext as string);
  expect(context.bots).toHaveLength(1);
  expect(context.bots[0]).toMatchObject({ id: "terry", name: "Terry", color: "#E02A88", shape: "pebble" });
  expect(roster.beforeTool(hook({ bot: "Missing" })).decision).toBe("block");
  expect(roster.beforeTool(hook({ bot: "Blog Generation" })).decision).toBe("block");
  expect(roster.beforeTool({ ...hook({}), toolName: "grokbot_show" })).toEqual({});
  now += 90_001;
  expect(roster.beforeTool(hook({ bot: "Terry" })).decision).toBe("block");
});

test("approved name cannot redirect to a replacement bot or skip preparation", () => {
  expect(resolveApprovedRecipient("Terry", "terry", agents).id).toBe("terry");
  expect(resolveApprovedRecipient("terry", undefined, agents).id).toBe("terry");
  expect(() => resolveApprovedRecipient("Terry", undefined, agents)).toThrow("wasn't verified");
  expect(() => resolveApprovedRecipient("Terry", "terry", [{ id: "replacement", name: "Terry" }])).toThrow("changed");
  expect(() => resolveApprovedRecipient("Terry", "terry", [{ id: "terry", name: "Renamed" }])).toThrow("couldn't find");
  expect(() => resolveApprovedRecipient("Terry", "terry", [...agents, { id: "duplicate", name: "Terry" }])).toThrow("More than one");
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

import { expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { intentErrors, resolveIntentSlots, matchIntentTemplate, INTENT_SLOT_VALUES_META_KEY, INTENT_REFRESH_NOTIFICATION_METHOD } from "./sdk/intents.ts";
import type { PreToolUseHookInput } from "./sdk/hooks.ts";
import { intents, IntentRoster, botIntentNames, botIntentLabels, resolveApprovedRecipient, registerIntentSupport, botForTask, namesABot } from "./intents.ts";
import { type Agent, IntegrationError, withoutWaking } from "./client.ts";
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

test("shipped show and send intents use the SDK contract; only create and mute ask first", () => {
  expect<unknown>(manifest.intents).toEqual(intents);
  expect(intentErrors(intents, manifest.tools)).toEqual([]);
  // grokbot_send / grokbot_group only open the card with a draft; the card's
  // send arrow sends. Create keeps its card and the hook forces it on; the
  // per-bot notification switch shows its own on/off card.
  expect(manifest.tools.filter(t => t.confirmation).map(t => t.name)).toEqual(["grokbot_create", "grokbot_notifications"]);
  expect(manifest.hooks).toEqual({ preToolUse: { scope: "own" }, transcript: {} });
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

test("send choices carry each bot's role and resolve back to that one bot", async () => {
  const team: Agent[] = [
    { id: "piper", name: "Piper", title: "EA", description: "Chief of Staff.\n Calendar and  handoffs." },
    { id: "finch", name: "F.I.N.C.H.", title: "School", description: "Assignments, tests, deadlines. ".repeat(10) },
    { id: "bare", name: "Bare" },
    { id: "g", name: "Piper — EA: Chief of Staff. Calendar and handoffs.", isGroup: true },
  ];
  const labels = botIntentLabels(team);
  expect(labels).toEqual(["Bare", expect.stringMatching(/^F\.I\.N\.C\.H\. — School: Assignments/), "Piper — EA: Chief of Staff. Calendar and handoffs."]);
  expect(labels.every(l => l.length <= 200)).toBe(true);
  expect(labels[1].endsWith("…")).toBe(true);
  // A label that reads as another bot's name would resolve to that bot: keep the plain name.
  const clashing = botIntentLabels([...team, { id: "clash", name: "Bee — x" }, { id: "bee", name: "Bee", description: "x" }]);
  expect(clashing).toContain("Bee");
  expect(clashing).toContain("Bee — x");
  const roster = new IntentRoster(async () => team);
  const published: { names: string[]; labels: string[] }[] = [];
  roster.onChoices = c => published.push(c);
  await roster.refresh();
  expect(published).toEqual([{ names: ["Bare", "F.I.N.C.H.", "Piper"], labels }]);
  for (const [label, id] of [[labels[2], "piper"], [labels[1], "finch"], ["Piper", "piper"]]) {
    const r = await roster.beforeTool(hook({ bot: label, message: "Hi" }));
    expect(r.updatedArgs).toMatchObject({ bot: label, recipientId: id });
    expect(resolveApprovedRecipient(label, id, team).id).toBe(id);
  }
});

test("roster changes publish new choices once; outages clear old names", async () => {
  let current = agents;
  let reads = 0;
  let fail = false;
  const roster = new IntentRoster(async () => { reads++; if (fail) throw Error("offline"); return current; });
  const published: string[][] = [];
  roster.onChoices = ({ names }) => published.push(names);
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

test("a stale or failed roster reloads before a send is judged, as after the Mac sleeps", async () => {
  let now = 1000;
  let reads = 0;
  let read: () => Promise<Agent[]> = async () => { throw new Error("Couldn't reach Grok Bot — is the Grok Bot app running?"); };
  const roster = new IntentRoster(() => { reads++; return read(); }, () => now);
  // The boot load failed (Wi-Fi not back yet): the send's hook tries again.
  await expect(roster.refresh()).rejects.toThrow("Couldn't reach");
  read = async () => agents;
  expect((await roster.beforeTool(hook({ bot: "Terry" }))).updatedArgs).toMatchObject({ recipientId: "terry" });
  expect(reads).toBe(2);
  // Timers stop while the Mac sleeps, so the cache is old on wake: reload it.
  now += 15 * 60_000;
  expect((await roster.beforeTool(hook({ bot: "Terry" }))).updatedArgs).toMatchObject({ recipientId: "terry" });
  expect(reads).toBe(3);
  // A fresh cache is used as it is.
  await roster.beforeTool(hook({ bot: "Terry" }));
  expect(reads).toBe(3);
  // Still unreachable: block, and say why.
  now += 15 * 60_000;
  read = async () => { throw new Error("Couldn't reach Grok Bot — is the Grok Bot app running?"); };
  expect(await roster.beforeTool(hook({ bot: "Terry" }))).toEqual({
    decision: "block", responseText: "Couldn't reach Grok Bot — is the Grok Bot app running?",
  });
  // A reload that hangs never eats the host's 2 s hook budget.
  read = () => new Promise(() => {});
  const started = Date.now();
  expect((await roster.beforeTool(hook({ bot: "Terry" }))).decision).toBe("block");
  expect(Date.now() - started).toBeLessThan(1_500);
});

test("a parked box keeps the bot names, and a send uses the last roster while the box wakes", async () => {
  let now = 1000;
  let read: () => Promise<Agent[]> = async () => agents;
  const roster = new IntentRoster(() => read(), () => now);
  const published: string[][] = [];
  roster.onChoices = ({ names }) => published.push(names);
  await roster.refresh();
  // The Grok Bot app parks the box: a background poll gets 417 ("parked").
  now += 15 * 60_000;
  read = async () => { throw new IntegrationError("parked", "Grok Bot's cloud computer is asleep."); };
  await expect(withoutWaking(() => roster.refresh())).rejects.toThrow("asleep");
  expect(published).toEqual([["SEO Master", "Terry"]]);
  // Waking takes ~3 s, past the hook's budget: the send pins from the last roster.
  let woke = 0;
  read = () => new Promise(done => setTimeout(() => { woke++; done(agents); }, 1_500));
  const started = Date.now();
  expect((await roster.beforeTool(hook({ bot: "Terry" }))).updatedArgs).toMatchObject({ recipientId: "terry" });
  expect(Date.now() - started).toBeLessThan(1_500);
  // A waking read never waits on a background one that cannot wake the box.
  read = () => new Promise(() => {});
  const quiet = withoutWaking(() => roster.refresh());
  read = async () => agents;
  await roster.refresh();
  void quiet;
});

test("preparation keeps the enum name, supplies native identity, and leaves approval to VoiceOS", async () => {
  let now = 1000;
  const roster = new IntentRoster(async () => agents, () => now);
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
  const support = registerIntentSupport(server, { named: [tools[0]], labeled: [tools[1]] }, roster, error => { throw error; });
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
    // A turn for Grok Bot that names no bot carries every bot's role for the model.
    const ctx = await client.callTool({ name: "voiceos_hook_transcript", arguments: { payload_json: JSON.stringify({ hookApiVersion: 1, event: "transcript", transcript: "Send this task to Grok Bot: plan the venue", source: "voice" }) } });
    expect(JSON.parse((ctx.content as { text: string }[])[0].text).additionalContext).toContain("- Terry");
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

test("create always asks first, even if the user turns its ask switch off", async () => {
  const roster = new IntentRoster(async () => agents);
  expect(await roster.beforeTool({ ...hook({ name: "Scout", description: "Research" }), toolName: "grokbot_create" })).toEqual({ requireConfirmation: true });
});

test("a Grok Bot turn gets each bot's role; other turns and an empty roster get nothing", async () => {
  const roster = new IntentRoster(async () => [
    { id: "j", name: "Jasper", title: "BISV Hacks EA", description: "Sponsorships, fundraising, and venue." },
    { id: "p", name: "Piper", title: "EA", description: "Chief of Staff." },
    { id: "g", name: "Crew", isGroup: true, memberIds: ["j", "p"] },
  ]);
  expect(roster.transcriptContext("Send a message to Grok Bot about BISV hacks")).toBeUndefined();
  await roster.refresh();
  const context = roster.transcriptContext("Send a message to Grok Bot talking about BISV hacks")!;
  expect(context).toContain("- Jasper — BISV Hacks EA: Sponsorships, fundraising, and venue.");
  expect(context).toContain("- Piper — EA: Chief of Staff.");
  expect(context).not.toContain("Crew");
  expect(context).toContain("default bot");
  for (const turn of ["Ask my bot about the venue", "Dispatch a task: research venues"]) expect(roster.transcriptContext(turn)).toBe(context);
  expect(roster.transcriptContext("What's the weather tomorrow?")).toBeUndefined();
});
test("the roster context stays inside the host's 2,000-character limit", async () => {
  const many: Agent[] = Array.from({ length: 30 }, (_, i) => ({ id: `b${i}`, name: `Bot ${i}`, title: "Role", description: "x".repeat(180) }));
  const roster = new IntentRoster(async () => many);
  await roster.refresh();
  expect(roster.transcriptContext("ask my bot")!.length).toBeLessThanOrEqual(2_000);
});

const crew: Agent[] = [
  { id: "hq", name: "Piper", title: "EA", description: "Chief of Staff. Calendar, prioritization, intern/hackathon/startup handoffs. School is owned by F.I.N.C.H." },
  { id: "hx", name: "Jasper", title: "Hackathon Hacks EA", description: "Personal EA for the hackathon: sponsorships, fundraising, and venue." },
  { id: "sc", name: "F.I.N.C.H.", title: "School", description: "School specialist. Assignments, tests, deadlines, and CSA practice. School is off Piper's plate." },
  { id: "db", name: "Demo", title: "Speech & Debate", description: "Public speaking and debating." },
];
test("a turn that names no bot goes to the bot whose role fits its words", () => {
  const pick = (t: string) => botForTask(t, crew)?.id;
  expect(pick("Can you ask Grok Bot if there's any CSA homework for today in school?")).toBe("sc");
  expect(pick("Dispatch a task to Grok Bot: research elite venues to host the hackathon")).toBe("hx");
  expect(pick("Ask my bot to find sponsors")).toBe("hx");
  expect(pick("Ask my bot what's on my calendar tomorrow")).toBe("hq");
  expect(pick("Ask Grok Bot to help me practice my debate speech")).toBe("db");
  // No topic, or a tie: no pick, so the model's choice stands.
  expect(pick("Ask Grok Bot how it's going")).toBeUndefined();
  expect(namesABot("Ask Jasper about sponsors", crew)).toBe(true);
  expect(namesABot("What did Finch's tutor say?", crew)).toBe(true);
  expect(namesABot("Ask my bot to demonstrate the demo flow", crew)).toBe(true);
  expect(namesABot("Ask my bot to demonstrate it", crew)).toBe(false);
});
test("the send hook moves a guessed bot to the role match only when the turn named no bot", async () => {
  let now = 1_000_000;
  const roster = new IntentRoster(async () => crew, () => now);
  await roster.refresh();
  roster.noteTurn("Send a message to Grok Bot about the hackathon venue");
  const moved = await roster.beforeTool(hook({ bot: "Piper", message: "Research venues." }));
  expect(moved.updatedArgs).toMatchObject({ bot: "Jasper", recipientId: "hx", message: "Research venues." });
  roster.noteTurn("Ask Piper about the hackathon venue");
  expect((await roster.beforeTool(hook({ bot: "Piper", message: "Venue?" }))).updatedArgs).toMatchObject({ bot: "Piper", recipientId: "hq" });
  // A stale turn (another request long ago) never moves a send.
  roster.noteTurn("Send a message to Grok Bot about the hackathon venue");
  now += 121_000;
  expect((await roster.beforeTool(hook({ bot: "Piper", message: "Hi" }))).updatedArgs).toMatchObject({ bot: "Piper", recipientId: "hq" });
});

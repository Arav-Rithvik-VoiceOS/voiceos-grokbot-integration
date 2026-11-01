import { expect, mock, test } from "bun:test";
import manifest from "../voiceos.integration.json";
import { SEND_DESCRIPTION, SEND_MODEL_DESCRIPTION } from "../messaging.ts";

// The user reads the manifest's short text. The model reads the longer routing
// text the server registers on each MCP tool. Capture what the server registers.
type ToolConfig = {title?:string; description?:string; inputSchema?: {files?: {safeParse(value:unknown):{success:boolean}}}};
const configs = new Map<string, ToolConfig>();
mock.module("@modelcontextprotocol/sdk/server/mcp.js", () => ({ McpServer: class {
  server = { request: async () => ({}), setNotificationHandler() {}, setRequestHandler() {} };
  registerTool(name: string, config: ToolConfig) { configs.set(name, config); return { update() {} }; }
  tool() {}
  sendToolListChanged() {}
  async connect() {}
} }));
await import("../server.src.ts");

const tools = manifest.tools as Array<{ name: string; title?: string; description: string; visibility?: string }>;
const visible = tools.filter(t => (t.visibility ?? "user") === "user");
const FOUR = ["view_bot_desktop_live", "grokbot_show", "grokbot_send", "grokbot_create"];

test("the user sees exactly four tools", () => {
  expect(visible.map(t => t.name).sort()).toEqual([...FOUR].sort());
  expect(visible.map(t => t.title).sort()).toEqual(["Create a bot", "Message a bot", "Show bots", "View a bot's live screen"]);
});

test("list, help and notifications are agent-only but the agent can still call them", () => {
  for (const name of ["grokbot_list", "grokbot_help", "grokbot_notifications"]) {
    expect(tools.find(t => t.name === name)?.visibility).toBe("agent");
    expect(configs.has(name)).toBe(true);
  }
});

test("user-visible descriptions are short, plain sentences", () => {
  for (const t of visible) {
    expect(t.description.length).toBeLessThanOrEqual(90);
    expect(t.description.split(/[.!?]\s/).length).toBeLessThanOrEqual(2);
    expect(t.description).not.toMatch(/use when/i);
  }
});

test("the model still gets routing text from the server for every user-visible tool", () => {
  for (const t of visible) {
    const registered = configs.get(t.name)!;
    expect(registered.title).toBe(t.title);
    expect(registered.description).toMatch(/Use when/);
    expect(registered.description!.length).toBeGreaterThan(t.description.length);
  }
  expect(configs.get("grokbot_send")!.description).toBe(SEND_MODEL_DESCRIPTION);
  expect(tools.find(t => t.name === "grokbot_send")!.description).toBe(SEND_DESCRIPTION);
});

test("agent-only tools keep their full routing text in the manifest", () => {
  for (const name of ["grokbot_list", "grokbot_help", "grokbot_notifications", "grokbot_thread", "grokbot_prepare_message", "grokbot_group"]) {
    expect(tools.find(t => t.name === name)!.description).toMatch(/Use when|Use for|Use FIRST|Use AFTER/);
  }
});

test.each(["grokbot_send", "grokbot_group"])("%s advertises the turn-file input in both its manifest and MCP schema", name => {
  const field=manifest.tools.find(tool=>tool.name===name)?.inputSchema?.properties as Record<string,{type?:string}>|undefined;
  expect(field?.files?.type).toBe("array");
  const runtime=configs.get(name)?.inputSchema?.files;
  expect(runtime?.safeParse(["attached_file_0"]).success).toBe(true);
  expect(runtime?.safeParse("attached_file_0").success).toBe(false);
});

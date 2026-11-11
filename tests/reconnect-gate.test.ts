import { expect, mock, test } from "bun:test";
import * as childProcess from "node:child_process";

// grokbot_reconnect restarts the Grok Bot app. The host cannot tell the Reconnect
// card's button from a model call, so the server refuses the tool until it has
// shown that card itself. This file loads server.src.ts with a fake MCP server
// and must run in its own process (bun run test), like tests/tool-surfaces.test.ts.

const handlers = new Map<string, (args: unknown) => Promise<{ content: Array<{ type: string; text: string }> }>>();
mock.module("@modelcontextprotocol/sdk/server/mcp.js", () => ({ McpServer: class {
  server = { request: async () => ({}), setNotificationHandler() {}, setRequestHandler() {} };
  registerTool(name: string, _config: unknown, handler: (args: unknown) => Promise<never>) { handlers.set(name, handler as never); return { update() {} }; }
  tool() {}
  sendToolListChanged() {}
  async connect() {}
} }));
// Any attempt to quit, find or open the app would reach here.
const spawned: string[] = [];
mock.module("node:child_process", () => ({
  ...childProcess,
  execFile: (file: string, _args: unknown, options: unknown, callback?: (error: Error | null, out: string, err: string) => void) => {
    spawned.push(file);
    (callback ?? (options as typeof callback))?.(Object.assign(new Error("fixture"), { code: 1 }), "", "");
    return {};
  },
}));
await import("../server.src.ts");

test("grokbot_reconnect does nothing until the server has shown a Reconnect card", async () => {
  const reconnect = handlers.get("grokbot_reconnect")!;
  expect(reconnect).toBeDefined();
  const body = JSON.parse((await reconnect({})).content[0].text);
  expect(body.ok).toBe(false);
  expect(body.message).toContain("Nothing to reconnect");
  // No quit, no process lookup, no relaunch. (The server's own Keychain warm-up may run.)
  expect(spawned.filter((file) => /osascript|pgrep|open$/.test(file))).toEqual([]);
});

import { expect, mock, test } from "bun:test";
import * as childProcess from "node:child_process";

// VOS-1672: with browser sign-in (always on Windows) there is no desktop app
// to restart, so a parked or moved cloud computer must never show the desktop
// Reconnect card or run osascript / open / pgrep. Each request already asks
// Grok Bot to wake the computer; the user is told to try again instead.
// Loads server.src.ts with a fake MCP server, so it runs in its own process.

const handlers = new Map<string, (args: unknown) => Promise<{ content: Array<{ type: string; text: string }> }>>();
mock.module("@modelcontextprotocol/sdk/server/mcp.js", () => ({ McpServer: class {
  server = { request: async () => ({}), setNotificationHandler() {}, setRequestHandler() {} };
  registerTool(name: string, _config: unknown, handler: (args: unknown) => Promise<never>) { handlers.set(name, handler as never); return { update() {} }; }
  tool() {}
  sendToolListChanged() {}
  async connect() {}
} }));
const spawned: string[] = [];
mock.module("node:child_process", () => ({
  ...childProcess,
  execFile: (file: string, _args: unknown, options: unknown, callback?: (error: Error | null, out: string, err: string) => void) => {
    spawned.push(file);
    (callback ?? (options as typeof callback))?.(Object.assign(new Error("fixture"), { code: 1 }), "", "");
    return {};
  },
}));
const browser = await import("../browserSession.ts");
mock.module("../browserSession.ts", () => ({ ...browser, browserSelected: () => true }));
const client = await import("../client.ts");
let failure: unknown;
mock.module("../client.ts", () => ({ ...client, listAgents: async () => { throw failure; } }));
await import("../server.src.ts");

for (const kind of ["reconnect", "parked"] as const) {
  test(`a ${kind} computer in browser mode says "try again", with no Reconnect card or desktop app`, async () => {
    failure = new client.IntegrationError(kind, "desktop wording");
    const out = await handlers.get("grokbot_list")!({});
    const body = JSON.parse(out.content[0].text);
    expect(body).toMatchObject({ ok: false, retry: true });
    expect(body.message).toContain("still starting");
    expect(body.needsReconnect).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain("grokbot_reconnect");
    expect(spawned.filter((file) => /osascript|pgrep|open$/.test(file))).toEqual([]);
  });
}

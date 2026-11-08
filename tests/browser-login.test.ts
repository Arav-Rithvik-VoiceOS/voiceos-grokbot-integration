import { afterAll, expect, mock, test } from "bun:test";
import * as cp from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const home = mkdtempSync(join(tmpdir(), "grok-login-test-"));
process.env.HOME = home;
process.env.LOCALAPPDATA = join(home, "Local");
const scope = (process.env.VOICEOS_GROKBOT_SESSION_SCOPE = "f".repeat(64));
const base =
  process.platform === "win32"
    ? join(home, "Local")
    : join(home, "Library", "Application Support");
const file = join(
  base,
  "VoiceOS",
  "GrokBot",
  "accounts",
  scope,
  "browser-session.json",
);
let opened: URL | undefined;
mock.module("node:child_process", () => ({
  ...cp,
  execFile(_exe: string, args: string[], cb: Function) {
    opened = new URL(args.at(-1)!);
    cb(null);
  },
}));
const savedFetch = globalThis.fetch;
globalThis.fetch = (async (url) => {
  const target = new URL(url);
  expect(target.origin).toBe("https://api2.cursor.sh");
  expect(target.pathname).toBe("/auth/poll");
  expect(target.searchParams.get("uuid")).toBe(
    opened?.searchParams.get("uuid"),
  );
  expect(target.searchParams.get("verifier")).toBeTruthy();
  return Response.json({
    accessToken: "fixture",
    refreshToken: "never-persist",
    selectedTeamId: 7,
  });
}) as typeof fetch;
afterAll(() => {
  globalThis.fetch = savedFetch;
  rmSync(home, { recursive: true, force: true });
});
test("connect opens provider PKCE sign-in and stores only this user's access session", async () => {
  const api = await import("../browserSession.ts");
  expect(api.browserSignedIn()).toBe(false);
  await api.openBrowserLogin();
  for (let i = 0; !existsSync(file) && i < 50; i++) await Bun.sleep(5);
  expect(opened?.origin).toBe("https://cursor.com");
  expect(opened?.pathname).toBe("/loginDeepControl");
  expect(opened?.searchParams.has("verifier")).toBe(false);
  expect(opened?.searchParams.has("challenge")).toBe(true);
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
    accessToken: "fixture",
    selectedTeamId: 7,
  });
  expect(existsSync(join(file, "..", "pending-login.json"))).toBe(false);
  if (process.platform !== "win32")
    expect(statSync(file).mode & 0o777).toBe(0o600);
});

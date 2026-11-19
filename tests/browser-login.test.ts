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
let openCount = 0;
let failToOpen = false;
let allowExchange: Promise<void> | undefined;
mock.module("node:child_process", () => ({
  ...cp,
  execFile(_exe: string, args: string[], cb: Function) {
    opened = new URL(args.at(-1)!);
    openCount++;
    cb(failToOpen ? new Error("open failed") : null);
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
  await allowExchange;
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

test("Settings can connect, check status, and disconnect this account", async () => {
  const api = await import("../browserSession.ts");
  const before = openCount;
  expect(await api.browserAccount("disconnect")).toEqual({ state: "signed_out" });
  expect(await api.browserAccount("status")).toEqual({ state: "signed_out" });
  expect(openCount).toBe(before);

  failToOpen = true;
  try {
    await expect(api.browserAccount("connect")).rejects.toThrow("Could not open the browser");
    expect(await api.browserAccount("status")).toEqual({ state: "signed_out" });
  } finally {
    failToOpen = false;
  }

  let release!: () => void;
  allowExchange = new Promise<void>((resolve) => { release = resolve; });
  try {
    const [first, second] = await Promise.all([api.browserAccount("connect"), api.browserAccount("connect")]);
    expect(first.state).toBe("pending");
    expect(second.state).toBe("pending");
    expect(await api.browserAccount("status")).toEqual({ state: "pending" });
    expect(openCount).toBe(before + 2); // one failed open, one successful open
    expect(await api.browserAccount("disconnect")).toEqual({ state: "signed_out" });
  } finally {
    release();
    allowExchange = undefined;
  }
  await Bun.sleep(10);
  expect(await api.browserAccount("status")).toEqual({ state: "signed_out" });
  expect(existsSync(file)).toBe(false);

  await api.browserAccount("connect");
  for (let i = 0; !existsSync(file) && i < 50; i++) await Bun.sleep(5);
  expect(await api.browserAccount("status")).toEqual({ state: "connected" });
  expect(await api.browserAccount("connect")).toEqual({ state: "connected" });
  expect(openCount).toBe(before + 3);
  expect(await api.browserAccount("disconnect")).toEqual({ state: "signed_out" });
  expect(existsSync(file)).toBe(false);
});

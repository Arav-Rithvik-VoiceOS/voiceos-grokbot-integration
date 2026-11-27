// VOS-1672: the Grok Bot sign-in lives in the app's OS keystore, never in a
// readable file, and the client version can change without a release.
import { afterAll, expect, mock, setSystemTime, test } from "bun:test";
import * as cp from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "grok-vault-test-"));
process.env.HOME = home;
process.env.LOCALAPPDATA = join(home, "Local");
const scope = (process.env.VOICEOS_GROKBOT_SESSION_SCOPE = "c".repeat(64));
const folder = join(
  process.platform === "win32" ? join(home, "Local") : join(home, "Library", "Application Support"),
  "VoiceOS", "GrokBot", "accounts", scope,
);
mkdirSync(folder, { recursive: true });
// A 1.0.0 install left its sign-in in a plain file.
writeFileSync(join(folder, "browser-session.json"), JSON.stringify({ accessToken: "legacy", selectedTeamId: 3 }));

let opened: URL | undefined;
mock.module("node:child_process", () => ({
  ...cp,
  execFile(_exe: string, args: string[], cb: Function) {
    opened = new URL(args.at(-1)!);
    cb(null);
  },
}));
const seen: { auth: string | null; version: string | null; path: string }[] = [];
let answer: () => Response = () => Response.json({ agents: [] });
const savedFetch = globalThis.fetch;
globalThis.fetch = (async (url, init) => {
  const target = new URL(String(url));
  if (target.pathname === "/auth/poll")
    return Response.json({ accessToken: "fresh", refreshToken: "never-kept", selectedTeamId: 9 });
  const headers = new Headers(init?.headers);
  seen.push({ auth: headers.get("authorization"), version: headers.get("x-cursor-client-version"), path: target.pathname });
  return answer();
}) as typeof fetch;
afterAll(() => {
  globalThis.fetch = savedFetch;
  rmSync(home, { recursive: true, force: true });
});

const stored = new Map<string, string>();
let available = true;
const writes: string[] = [];
const host = {
  get: async (key: "session" | "pending") => ({ available, value: available ? stored.get(key) ?? null : undefined }),
  set: async (key: "session" | "pending", value: string) => {
    writes.push(key);
    if (available) stored.set(key, value);
    return { available };
  },
  delete: async (key: "session" | "pending") => {
    stored.delete(key);
    return { available };
  },
  clientVersion: async () => "0.80.1",
};
const api = await import("../browserSession.ts");
const plainFiles = () => (existsSync(folder) ? readdirSync(folder).filter((f) => f.endsWith(".json")) : []);

test("tools wait for the vault, then a 1.0.0 plain-file sign-in moves into it", async () => {
  api.expectHostVault();
  let settled = false;
  const status = api.browserAccount("status").then((value) => ((settled = true), value));
  await Bun.sleep(5);
  expect(settled).toBe(false);
  await api.useHostVault(host);
  expect(await status).toEqual({ state: "connected" });
  expect(JSON.parse(stored.get("session")!)).toEqual({ accessToken: "legacy", selectedTeamId: 3 });
  expect(plainFiles()).toEqual([]);
});

test("calls use the keystore token and the version the app sends", async () => {
  await api.browserGateway(false).catch(() => {});
  expect(seen.at(-1)).toMatchObject({ auth: "Bearer legacy", version: "0.80.1" });
});

test("a new sign-in is kept only in the vault, without the refresh token", async () => {
  await api.browserAccount("disconnect");
  expect(stored.size).toBe(0);
  expect(await api.browserAccount("connect")).toEqual({ state: "pending" });
  expect(stored.has("pending")).toBe(true);
  expect(opened?.pathname).toBe("/loginDeepControl");
  for (let i = 0; !stored.has("session") && i < 100; i++) await Bun.sleep(5);
  expect(JSON.parse(stored.get("session")!)).toEqual({ accessToken: "fresh", selectedTeamId: 9 });
  expect(stored.get("session")).not.toContain("never-kept");
  expect(stored.has("pending")).toBe(false);
  expect(plainFiles()).toEqual([]);
});

test("a rejected client version says so instead of a generic failure", async () => {
  answer = () => new Response("client version too old, please update", { status: 426 });
  await expect(api.browserGateway(false)).rejects.toBeInstanceOf(api.ClientVersionRejected);
  answer = () => Response.json({ agents: [] });
  expect(api.isOutdatedClient(400, "Unsupported client version 0.78.5")).toBe(true);
  expect(api.isOutdatedClient(400, "This app version is outdated")).toBe(true);
  expect(api.isOutdatedClient(500, "internal error")).toBe(false);
  expect(api.isOutdatedClient(404, "bot not found")).toBe(false);
});

test("a version rejection in a 400 reply body shows the clear message on roster and send", async () => {
  const outdated = () => new Response(JSON.stringify({ code: "failed_precondition", message: "Client version outdated" }), { status: 400 });
  answer = outdated;
  await expect(api.browserRoster()).rejects.toBeInstanceOf(api.ClientVersionRejected);
  // Only the send is refused: no "Delivery is unknown", and the text can be sent again.
  let sends = 0;
  const savedFetch = globalThis.fetch;
  globalThis.fetch = (async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith("/ListGrokBotAgents")) return Response.json({ agents: [{ agentId: "b1", name: "Scout", sessionId: "s1" }] });
    if (path.endsWith("/SendGrokBotUserMessage")) return (sends++, outdated());
    return savedFetch(url, init);
  }) as typeof fetch;
  try {
    await expect(api.browserSend("b1", "hello there", [])).rejects.toBeInstanceOf(api.ClientVersionRejected);
    await expect(api.browserSend("b1", "hello there", [])).rejects.toBeInstanceOf(api.ClientVersionRejected);
    expect(sends).toBe(2);
  } finally {
    globalThis.fetch = savedFetch;
    answer = () => Response.json({ agents: [] });
  }
});

test("a 401 signs out in the vault, not by writing a file", async () => {
  answer = () => Response.json({ code: "unauthenticated" }, { status: 401 });
  await expect(api.browserGateway(false)).rejects.toBeInstanceOf(api.BrowserLoginRequired);
  for (let i = 0; stored.has("session") && i < 50; i++) await Bun.sleep(5);
  expect(stored.has("session")).toBe(false);
  expect(api.browserSignedIn()).toBe(false);
  expect(plainFiles()).toEqual([]);
  answer = () => Response.json({ agents: [] });
});

test("without an OS keystore the sign-in stays in memory only", async () => {
  available = false;
  stored.clear();
  writes.length = 0;
  api.expectHostVault();
  await api.useHostVault(host);
  expect(await api.browserAccount("connect")).toEqual({ state: "pending" });
  for (let i = 0; !api.browserSignedIn() && i < 100; i++) await Bun.sleep(5);
  expect(api.browserSignedIn()).toBe(true);
  expect(stored.size).toBe(0);
  expect(plainFiles()).toEqual([]);
});

const failing = (code: number) => {
  const fail = async () => { throw Object.assign(new Error("vault failed"), { code }); };
  return { get: fail, set: fail, delete: fail, clientVersion: async () => null };
};

// -32001 timeout, -32600 the app refused (moved app, VoiceOS login not ready),
// -32601 an app with no vault at all.
for (const code of [-32001, -32600, -32601])
  test(`a vault error (${code}) keeps the sign-in in memory, never in a plain file`, async () => {
    // The previous vault failed on purpose, so this sign-out can report it.
    await api.browserAccount("disconnect").catch(() => {});
    api.expectHostVault();
    await api.useHostVault(failing(code));
    expect(await api.browserAccount("connect")).toEqual({ state: "pending" });
    for (let i = 0; !api.browserSignedIn() && i < 100; i++) await Bun.sleep(5);
    expect(api.browserSignedIn()).toBe(true);
    expect(plainFiles()).toEqual([]);
  });

test("an old plain-file sign-in is still read when the vault fails", async () => {
  await api.browserAccount("disconnect").catch(() => {});
  writeFileSync(join(folder, "browser-session.json"), JSON.stringify({ accessToken: "old" }));
  api.expectHostVault();
  await api.useHostVault(failing(-32600));
  expect(api.browserSignedIn()).toBe(true);
  // Signing out deletes it, so the old token never comes back after a restart.
  // The vault refused, so it may still hold a copy: the sign-out says so.
  await expect(api.browserAccount("disconnect")).rejects.toThrow("Couldn't sign out");
  expect(plainFiles()).toEqual([]);
});

/** A real keystore that fails its first `failures` calls (a startup race). */
function flaky(failures: number) {
  const keystore = new Map<string, string>();
  const step = async <T>(work: () => T) => {
    if (failures-- > 0) throw Object.assign(new Error("VoiceOS login not ready"), { code: -32600 });
    return work();
  };
  return {
    keystore,
    get: (key: "session" | "pending") => step(() => ({ available: true, value: keystore.get(key) ?? null })),
    set: (key: "session" | "pending", value: string) => step(() => (keystore.set(key, value), { available: true })),
    delete: (key: "session" | "pending") => step(() => (keystore.delete(key), { available: true })),
    clientVersion: async () => null,
  };
}

test("after a startup vault error, a sign-out still deletes the token from the keystore", async () => {
  const host = flaky(2); // both startup reads fail
  host.keystore.set("session", JSON.stringify({ accessToken: "revoked" }));
  api.expectHostVault();
  await api.useHostVault(host);
  await api.browserAccount("disconnect");
  expect(host.keystore.has("session")).toBe(false);
  expect(plainFiles()).toEqual([]);
});

test("after a startup vault error, the keystore is tried again a minute later", async () => {
  const host = flaky(2);
  host.keystore.set("session", JSON.stringify({ accessToken: "kept" }));
  api.expectHostVault();
  await api.useHostVault(host);
  expect(api.browserSignedIn()).toBe(false);
  setSystemTime(new Date(Date.now() + 61_000));
  try {
    expect(await api.browserAccount("status")).toEqual({ state: "connected" });
  } finally {
    setSystemTime();
  }
  expect(plainFiles()).toEqual([]);
});

test("a sign-out the keystore missed is saved at the next retry", async () => {
  const host = flaky(0);
  host.keystore.set("session", JSON.stringify({ accessToken: "revoked" }));
  api.expectHostVault();
  await api.useHostVault(host);
  expect(api.browserSignedIn()).toBe(true);
  (host as any).delete = async () => { throw new Error("locked"); };
  await expect(api.browserAccount("disconnect")).rejects.toThrow("Couldn't sign out");
  expect(host.keystore.has("session")).toBe(true);
  (host as any).delete = async (key: string) => (host.keystore.delete(key), { available: true });
  setSystemTime(new Date(Date.now() + 61_000));
  try {
    expect(await api.browserAccount("status")).toEqual({ state: "signed_out" });
  } finally {
    setSystemTime();
  }
  expect(host.keystore.has("session")).toBe(false);
});

test("a broken old token file does not crash startup or sign anyone in", async () => {
  writeFileSync(join(folder, "browser-session.json"), "{ not json");
  api.expectHostVault();
  await api.useHostVault(flaky(2));
  expect(api.browserSignedIn()).toBe(false);
  expect(await api.browserAccount("status")).toEqual({ state: "signed_out" });
  rmSync(join(folder, "browser-session.json"), { force: true });
});

test("a sign-out that cannot delete the half-finished browser login says so (VOS-1672 review)", async () => {
  const keystore = new Map([["pending", JSON.stringify({ uuid: "u", expiresAt: Date.now() + 600_000 })]]);
  let deletes = 0;
  const locked = {
    get: async (key: "session" | "pending") => ({ available: true, value: keystore.get(key) ?? null }),
    set: async (key: "session" | "pending", value: string) => (keystore.set(key, value), { available: true }),
    delete: async (key: "session" | "pending") => {
      if (key === "pending") { deletes++; throw Object.assign(new Error("EPERM"), { code: -32603 }); }
      keystore.delete(key);
      return { available: true };
    },
    clientVersion: async () => null,
  };
  api.expectHostVault();
  await api.useHostVault(locked);
  await expect(api.browserAccount("disconnect")).rejects.toThrow("Couldn't sign out");
  expect(deletes).toBe(2);
  expect(keystore.has("pending")).toBe(true);
  locked.delete = async (key) => (keystore.delete(key), { available: true });
  expect(await api.browserAccount("disconnect")).toEqual({ state: "signed_out" });
  expect(keystore.has("pending")).toBe(false);
});

test("a sign-out that cannot delete the keystore copy says so, so the app does not sign back in", async () => {
  const keystore = new Map([["session", JSON.stringify({ accessToken: "kept" })]]);
  let deletes = 0;
  const locked = {
    get: async (key: "session" | "pending") => ({ available: true, value: keystore.get(key) ?? null }),
    set: async (key: "session" | "pending", value: string) => (keystore.set(key, value), { available: true }),
    delete: async (key: "session" | "pending") => {
      if (key === "session") { deletes++; throw Object.assign(new Error("EBUSY"), { code: -32603 }); }
      keystore.delete(key);
      return { available: true };
    },
    clientVersion: async () => null,
  };
  api.expectHostVault();
  await api.useHostVault(locked);
  await expect(api.browserAccount("disconnect")).rejects.toThrow("Couldn't sign out");
  expect(deletes).toBe(2);
  // A second try that works reports signed out.
  locked.delete = async (key) => (keystore.delete(key), { available: true });
  expect(await api.browserAccount("disconnect")).toEqual({ state: "signed_out" });
  expect(keystore.has("session")).toBe(false);
});

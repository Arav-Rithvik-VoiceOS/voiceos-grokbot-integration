/** Process-isolated real transport with fake session files, Keychain and HTTP. */
import { mock } from "bun:test";
import * as fs from "node:fs";
import * as childProcess from "node:child_process";
import { createCipheriv, pbkdf2Sync } from "node:crypto";

const scenario = process.argv[2];
const cipher = createCipheriv("aes-128-cbc", pbkdf2Sync("fixture-key", "saltysalt", 1003, 16, "sha1"), Buffer.alloc(16, 0x20));
const plain = scenario === "bad-plaintext" ? '{"token":"DO_NOT_LOG_SECRET",invalid}' : JSON.stringify({ baseUrl: "https://gateway.example.invalid", token: "fixture-token" });
const encrypted = Buffer.concat([Buffer.from("v10"), cipher.update(plain), cipher.final()]).toString("base64");
const descriptor = JSON.stringify({ entries: { fixture: { savedAtMs: 1, encrypted } } });
const existing = new Set(["legacy", "signed-out-stale", "keychain-denied", "keychain-missing", "keychain-waits", "signout-during-keychain", "bad-plaintext", "wake-headers", "curl-wake-headers", "auth-rotation", "parked-response"]);
let opens = 0, keychainReads = 0, descriptorReads = 0, now = 0, eventLoopResponsive = false, signedOutDuringPrompt = false;
const requests: Array<{ url: string; wake: boolean }> = [];
const curls: string[][] = [];
const realRead = fs.readFileSync;
const missing = (code = "ENOENT") => Object.assign(new Error("fixture unavailable"), { code });
mock.module("node:fs", () => ({
  ...fs,
  existsSync: (path: any) => String(path).endsWith("/Grok Bot/gateway-descriptor.json") && existing.has(scenario),
  readFileSync: (path: any, ...args: any[]) => {
    const name = String(path);
    if (name.endsWith("/Grok Bot/desktop-status.json")) {
      if (["unknown", "legacy"].includes(scenario)) throw missing();
      if (scenario === "status-unreadable") throw missing("EACCES");
      if (scenario === "status-malformed") return "invalid json";
      if (scenario === "status-version") return JSON.stringify({ version: 2, signedIn: false });
      return JSON.stringify({ version: 1, signedIn: !scenario.startsWith("signed-out") && !signedOutDuringPrompt });
    }
    if (name.endsWith("/Grok Bot/gateway-descriptor.json")) {
      descriptorReads++;
      if (existing.has(scenario)) return descriptor;
      if (["restored", "concurrent-background"].includes(scenario) && opens > 0 && now >= 200) return descriptor;
      throw missing(scenario === "unreadable" ? "EACCES" : "ENOENT");
    }
    return (realRead as any)(path, ...args);
  },
}));
mock.module("node:child_process", () => ({
  ...childProcess,
  execFile: (file: string, args: string[], options: any, callback?: Function) => {
    const done = callback ?? options;
    if (file === "/usr/bin/open") { opens++; queueMicrotask(() => done(null, "", "")); return {}; }
    if (file === "/usr/bin/security") {
      keychainReads++;
      const code = scenario === "keychain-denied" ? 128 : scenario === "keychain-missing" ? 44 : undefined;
      const error = code ? Object.assign(new Error("DO_NOT_LOG_SECRET"), { code, stdout: "DO_NOT_LOG_SECRET" }) : null;
      const finish = () => done(error, error ? "" : "fixture-key", "");
      if (scenario === "signout-during-keychain") setTimeout(() => { signedOutDuringPrompt = true; finish(); }, 10);
      else if (scenario === "keychain-waits") setTimeout(() => { eventLoopResponsive = true; finish(); }, 10);
      else queueMicrotask(finish);
      return {};
    }
    if (file === "/usr/bin/curl") {
      curls.push(args);
      queueMicrotask(() => done(null, "[]\n200", ""));
      return {};
    }
    throw Error(`Unexpected subprocess: ${file}`);
  },
}));
// Advance only recovery polling, proving the production deadline without a
// five-second wall-clock delay or launching the user's real app.
Date.now = () => now;
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = ((callback: Function, ms: number, ...args: any[]) => {
  if (ms === 100) { now += ms; return realSetTimeout(() => callback(...args), 0); }
  return realSetTimeout(callback as any, ms, ...args);
}) as typeof setTimeout;
globalThis.fetch = (async (url: string, init?: RequestInit) => {
  if (url !== "https://gateway.example.invalid/api/listAgents") throw Error("Unexpected network request");
  requests.push({ url, wake: new Headers(init?.headers).has("x-anyrun-hibernation-lower-bound-s") });
  if (scenario === "curl-wake-headers") throw new TypeError("Network fixture");
  if (scenario === "auth-rotation" && requests.length === 1) return Response.json({}, { status: 401 });
  if (scenario === "parked-response") return Response.json({}, { status: 417 });
  return Response.json([{ id: "fixture", name: "Fixture" }]);
}) as typeof fetch;

const { gateway, withoutWaking, grokBotSignIn } = await import("../../client.ts");
const signedIn = grokBotSignIn() ?? null;
const call = () => gateway("listAgents").catch((error) => ({ error: { kind: error.kind, message: error.message } }));
let results: unknown[];
if (scenario === "background") results = [await withoutWaking(call)];
else if (scenario === "concurrent-background") results = await Promise.all([call(), withoutWaking(call), call()]);
else if (["wake-headers", "curl-wake-headers"].includes(scenario)) results = await Promise.all([call(), withoutWaking(call)]);
else if (scenario === "auth-rotation") results = [await call()];
else results = await Promise.all([call(), call(), call()]);
console.log(JSON.stringify({ signedIn, results, opens, keychainReads, descriptorReads, requests, curls, eventLoopResponsive, elapsed: now }));

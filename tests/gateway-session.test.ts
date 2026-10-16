import { expect, test } from "bun:test";

const fixture = new URL("./fixtures/gateway-session.fixture.ts", import.meta.url).pathname;
function run(scenario: string) {
  const child = Bun.spawnSync([process.execPath, fixture, scenario], { stdout: "pipe", stderr: "pipe", timeout: 10_000 });
  expect(child.exitCode, child.stderr.toString()).toBe(0);
  return { ...JSON.parse(child.stdout.toString().trim()), stderr: child.stderr.toString() };
}

test("concurrent user requests recover one missing route without losing sign-in state", () => {
  const out = run("restored");
  expect(out.signedIn).toBe(true);
  expect(out.opens).toBe(1);
  expect(out.keychainReads).toBe(1);
  expect(out.requests).toHaveLength(3);
  expect(out.results.every((result: unknown) => Array.isArray(result))).toBe(true);
});

test("a signed-in app without a restored route reports one bounded connection failure", () => {
  const out = run("missing");
  expect(out.signedIn).toBe(true);
  expect(out.opens).toBe(1);
  expect(out.elapsed).toBe(5_000);
  expect(out.keychainReads).toBe(0);
  expect(out.requests).toEqual([]);
  for (const result of out.results) {
    expect(result.error.kind).toBe("session_unavailable");
    expect(result.error.message).toContain("local connection");
    expect(result.error.message).not.toMatch(/signed (?:in|out)|log(?:ged)? ?in/i);
  }
});

test("background refresh never launches a signed-in but parked app", () => {
  const out = run("background");
  expect(out.results[0].error.kind).toBe("parked");
  expect(out.opens).toBe(0);
  expect(out.elapsed).toBe(0);
  expect(out.keychainReads).toBe(0);
  expect(out.requests).toEqual([]);
});

test("background reads neither join foreground recovery nor inherit its wake permission", () => {
  const out = run("concurrent-background");
  expect(out.results[1].error.kind).toBe("parked");
  expect(Array.isArray(out.results[0])).toBe(true);
  expect(Array.isArray(out.results[2])).toBe(true);
  expect(out.opens).toBe(1);
  expect(out.requests).toHaveLength(2);
});

test("only explicit signed-out status produces a sign-in setup error, even with a stale route", () => {
  for (const scenario of ["signed-out", "signed-out-stale"]) {
    const out = run(scenario);
    expect(out.signedIn).toBe(false);
    expect(out.results[0].error).toMatchObject({ kind: "setup" });
    expect(out.results[0].error.message).toContain("signed out");
    expect(out.opens).toBe(0);
    expect(out.elapsed).toBe(0);
    expect(out.requests).toEqual([]);
  }
});

test("unknown or unreadable status never invents a logout", () => {
  for (const scenario of ["unknown", "status-unreadable", "status-malformed", "status-version"]) {
    const out = run(scenario);
    expect(out.signedIn).toBeNull();
    expect(out.results[0].error.kind).toBe("session_unavailable");
    expect(out.results[0].error.message).not.toContain("sign in");
    expect(out.keychainReads).toBe(0);
    expect(out.requests).toEqual([]);
  }
});

test("a denied route read fails immediately without opening the app or claiming logout", () => {
  const out = run("unreadable");
  expect(out.results[0].error.kind).toBe("session_unavailable");
  expect(out.opens).toBe(0);
  expect(out.elapsed).toBe(0);
});

test("older Grok Bot versions remain signed in through an available descriptor", () => {
  const out = run("legacy");
  expect(out.signedIn).toBe(true);
  expect(out.opens).toBe(0);
  expect(out.requests).toHaveLength(3);
});

test("Keychain denial or absence is a session error and never logs captured secrets", () => {
  for (const scenario of ["keychain-denied", "keychain-missing"]) {
    const out = run(scenario);
    expect(out.keychainReads).toBe(1);
    expect(out.requests).toEqual([]);
    expect(out.results[0].error.kind).toBe("session_unavailable");
    expect(out.stderr).not.toContain("DO_NOT_LOG_SECRET");
    if (scenario === "keychain-denied") expect(out.results[0].error.message).toContain("Keychain access");
  }
});

test("waiting for Keychain keeps the event loop available and shares one read", () => {
  const out = run("keychain-waits");
  expect(out.eventLoopResponsive).toBe(true);
  expect(out.keychainReads).toBe(1);
  expect(out.requests).toHaveLength(3);
});

test("signing out during a Keychain prompt prevents use of the previous session", () => {
  const out = run("signout-during-keychain");
  expect(out.signedIn).toBe(true);
  expect(out.keychainReads).toBe(1);
  expect(out.requests).toEqual([]);
  expect(out.results.every((result: any) => result.error.kind === "setup")).toBe(true);
});

test("invalid decrypted session data never appears in diagnostics", () => {
  const out = run("bad-plaintext");
  expect(out.results[0].error.kind).toBe("not_connected");
  expect(out.requests).toEqual([]);
  expect(out.stderr).not.toContain("DO_NOT_LOG_SECRET");
});

test("foreground and background HTTP requests keep separate wake headers", () => {
  const out = run("wake-headers");
  expect(out.requests.map((request: any) => request.wake)).toEqual([true, false]);
});

test("read fallback preserves wake policy independently for concurrent requests", () => {
  const out = run("curl-wake-headers");
  expect(out.requests).toHaveLength(2);
  expect(out.curls).toHaveLength(2);
  expect(out.curls.map((args: string[]) => args.some((arg) => arg.startsWith("x-anyrun-hibernation-lower-bound-s:")))).toEqual([true, false]);
});

test("a rejected session still refreshes credentials once for a read", () => {
  const out = run("auth-rotation");
  expect(out.keychainReads).toBe(2);
  expect(out.requests).toHaveLength(2);
  expect(Array.isArray(out.results[0])).toBe(true);
});

test("a sleeping gateway is classified as parked instead of signed out", () => {
  const out = run("parked-response");
  expect(out.results[0].error.kind).toBe("parked");
  expect(out.signedIn).toBe(true);
});

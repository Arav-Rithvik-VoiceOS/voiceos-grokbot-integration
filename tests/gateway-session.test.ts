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

test("a signed-in app without a restored route or a saved copy asks for one reconnect", () => {
  const out = run("missing");
  expect(out.signedIn).toBe(true);
  expect(out.opens).toBe(1);
  expect(out.elapsed).toBe(5_000);
  expect(out.keychainReads).toBe(0);
  expect(out.requests).toEqual([]);
  for (const result of out.results) {
    expect(result.error.kind).toBe("reconnect");
    expect(result.error.message).toContain("reconnect");
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
  // The route file is read again; the unchanging Keychain key is not.
  expect(out.descriptorReads).toBe(2);
  expect(out.keychainReads).toBe(1);
  expect(out.requests).toHaveLength(2);
  expect(Array.isArray(out.results[0])).toBe(true);
});

test("a box that stays asleep after a user's wake request asks for one reconnect, never a sign-in", () => {
  const out = run("parked-response");
  expect(out.requests.map((request: any) => request.wake)).toEqual([true, true, true]);
  expect(out.results[0].error.kind).toBe("reconnect");
  expect(out.results[0].error.message).not.toMatch(/signed (?:in|out)|log(?:ged)? ?in/i);
  expect(out.signedIn).toBe(true);
});

test("a removed route file reuses the remembered route so a user request can wake the computer", () => {
  const out = run("remembered");
  expect(out.results.every((result: unknown) => Array.isArray(result))).toBe(true);
  expect(out.requests.map((request: any) => request.wake)).toEqual([true, true]);
  expect(out.opens).toBe(0);
  expect(out.keychainReads).toBe(1);
});

test("a rejected remembered route is forgotten, on disk too, and asks for one reconnect", () => {
  const out = run("remembered-rejected");
  expect(out.requests).toHaveLength(2);
  expect(out.opens).toBe(1);
  expect(out.results[1].error.kind).toBe("reconnect");
  expect(out.copyPresent).toBe(false);
});

test("an unreachable remembered route waits the wake time, then is forgotten and asks for one reconnect", () => {
  const out = run("remembered-dead");
  expect(out.requests).toHaveLength(2);
  expect(out.curls).toHaveLength(1);
  // A route the app removed means its box is asleep: give the wake 45 s, not 8.
  expect(out.curls[0]).toContain("--max-time");
  expect(out.curls[0][out.curls[0].indexOf("--max-time") + 1]).toBe("45");
  expect(out.opens).toBe(1);
  expect(out.results[1].error.kind).toBe("reconnect");
});

test("background reads never use the remembered route to wake a sleeping computer", () => {
  const out = run("remembered-background");
  expect(out.requests).toHaveLength(1);
  expect(out.results[1].error.kind).toBe("parked");
  expect(out.opens).toBe(0);
});

test("the Keychain is read once per process, not on every creds refresh", () => {
  const out = run("keychain-once");
  expect(out.descriptorReads).toBe(2);
  expect(out.keychainReads).toBe(1);
  expect(out.requests).toHaveLength(2);
});

test("an unanswered Keychain prompt fails the request with guidance instead of hanging", () => {
  const out = run("keychain-timeout");
  expect(out.keychainReads).toBe(1);
  expect(out.requests).toEqual([]);
  expect(out.results[0].error.kind).toBe("session_unavailable");
  expect(out.results[0].error.message).toContain("Keychain popup");
});

test("relaunching the Grok Bot app does not lose the remembered route", () => {
  // The app rewrites desktop-status.json on EVERY launch, not only on sign-in,
  // so its modified time says nothing about the account. The route stays tied
  // to the account label the app wrote into its file instead.
  const out = run("remembered-app-relaunch");
  expect(out.results.every((result: unknown) => Array.isArray(result))).toBe(true);
  expect(out.requests).toHaveLength(2);
  expect(out.opens).toBe(0);
});

test("a remembered route older than the app's own 7-day route life is forgotten", () => {
  const out = run("remembered-expired");
  expect(out.requests).toHaveLength(1);
  expect(out.opens).toBe(1);
  expect(out.results[1].error.kind).toBe("reconnect");
  expect(out.copyPresent).toBe(false);
});

test("a decrypted route is saved to disk as the app wrote it: locked, labelled, never in plain text", () => {
  const out = run("copy-written");
  expect(out.results.every((result: unknown) => Array.isArray(result))).toBe(true);
  // Three concurrent calls share one read, so one write.
  expect(out.copyWrites).toHaveLength(1);
  const copy = JSON.parse(out.copyWrites[0]);
  expect(copy).toMatchObject({ version: 1, account: "fixture", savedAtMs: 1 });
  expect(typeof copy.encrypted).toBe("string");
  expect(out.copyWrites[0]).not.toContain("fixture-token");
  expect(out.copyWrites[0]).not.toContain("gateway.example.invalid");
});

test("a fresh process with only the saved copy wakes the computer without opening the app", () => {
  // VoiceOS restarted after the app parked its box and removed the route file:
  // Maksim's case (VOS-1608). Before this, every request failed here.
  const out = run("copy-restart");
  expect(Array.isArray(out.results[0])).toBe(true);
  expect(out.requests.map((request: any) => request.wake)).toEqual([true]);
  expect(out.opens).toBe(0);
  expect(out.elapsed).toBe(0);
  expect(out.keychainReads).toBe(1);
  expect(out.copyPresent).toBe(true);
});

test("a background read never uses the saved copy to wake the computer", () => {
  const out = run("copy-restart-background");
  expect(out.requests).toEqual([]);
  expect(out.results[0].error.kind).toBe("parked");
  expect(out.opens).toBe(0);
  expect(out.copyPresent).toBe(true);
});

test("a saved copy past the app's 7-day route life is deleted, not used", () => {
  const out = run("copy-restart-expired");
  expect(out.requests).toEqual([]);
  expect(out.results[0].error.kind).toBe("reconnect");
  expect(out.copyPresent).toBe(false);
});

test("a saved copy is deleted when the app says it is signed out", () => {
  const out = run("copy-restart-signed-out");
  expect(out.requests).toEqual([]);
  expect(out.results[0].error.kind).toBe("setup");
  expect(out.copyPresent).toBe(false);
});

test("a saved copy the gateway rejects is deleted and asks for one reconnect", () => {
  const out = run("copy-restart-rejected");
  expect(out.requests).toHaveLength(1);
  expect(out.results[0].error.kind).toBe("reconnect");
  expect(out.copyPresent).toBe(false);
});

test("a new Safe Storage key after a reinstall is read again without failing the request", () => {
  const out = run("keychain-rotated");
  expect(out.results.every((result: unknown) => Array.isArray(result))).toBe(true);
  expect(out.keychainReads).toBe(2);
  expect(out.requests).toHaveLength(2);
});

// Grok Bot health check (VOS-1672). Grok Bot has no public API, so Cursor can
// change or block the calls we copy at any time. This runs the integration's
// real code path with a TEST account and says whether it still works, so we
// hear about a break before users do.
//
//   GROKBOT_HEALTH_TOKEN=<test account access token> bun scripts/health-check.ts
//
// It tests the version users get: the PostHog flag "grokbot-client-version"
// for this platform. Set POSTHOG_API_KEY (the project token; POSTHOG_HOST is
// optional) so it can read the flag. Without the flag it tests the built-in
// version and says so.
// Optional: GROKBOT_HEALTH_TEAM_ID, GROKBOT_HEALTH_VERSION (try a new client
// version before you set it in the flag).
// Exit codes: 0 ok, 1 broken, 2 Grok Bot rejected the client version,
// 3 the token expired (sign the test account in again).
// Run it on Mac and on Windows: each presents its own platform headers.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const token = process.env.GROKBOT_HEALTH_TOKEN;
if (!token) {
  console.error("Set GROKBOT_HEALTH_TOKEN to a test account's Grok Bot access token.");
  process.exit(1);
}

// A throwaway home: this never reads or changes a real VoiceOS sign-in.
const home = mkdtempSync(join(tmpdir(), "grokbot-health-"));
process.env.HOME = home;
process.env.LOCALAPPDATA = join(home, "Local");
const scope = (process.env.VOICEOS_GROKBOT_SESSION_SCOPE = "0".repeat(64));
const folder = join(
  process.platform === "win32" ? join(home, "Local") : join(home, "Library", "Application Support"),
  "VoiceOS", "GrokBot", "accounts", scope,
);
mkdirSync(folder, { recursive: true, mode: 0o700 });
const teamId = process.env.GROKBOT_HEALTH_TEAM_ID;
writeFileSync(
  join(folder, "browser-session.json"),
  JSON.stringify({ accessToken: token, ...(teamId ? { selectedTeamId: Number(teamId) } : {}) }),
  { mode: 0o600 },
);

const browser = await import("../browserSession.ts");
const { flagClientVersion } = await import("./flagVersion.ts");
const posthogKey = process.env.POSTHOG_API_KEY ?? process.env.VITE_POSTHOG_API_KEY;
let flagVersion: string | undefined;
if (!process.env.GROKBOT_HEALTH_VERSION && posthogKey) {
  try {
    flagVersion = await flagClientVersion({
      apiKey: posthogKey,
      host: process.env.POSTHOG_HOST ?? process.env.VITE_POSTHOG_HOST,
      platform: process.platform,
    });
  } catch (error) {
    console.error(`Could not read the "grokbot-client-version" flag: ${(error as Error).message}`);
    process.exit(1);
  }
}
const version = process.env.GROKBOT_HEALTH_VERSION ?? flagVersion ?? browser.DEFAULT_CLIENT_VERSION;
const versionSource = process.env.GROKBOT_HEALTH_VERSION ? "GROKBOT_HEALTH_VERSION" : flagVersion ? "flag" : "built-in";
if (versionSource === "built-in")
  console.error(posthogKey
    ? "The flag has no version for this platform: testing the built-in version, as users get."
    : "POSTHOG_API_KEY is not set: testing the built-in version, NOT the flag version users may get.");
if (versionSource !== "built-in")
  await browser.useHostVault({
    // Memory only: the token is already in the throwaway file above.
    get: async () => ({ available: false }),
    set: async () => ({ available: false }),
    delete: async () => ({ available: false }),
    clientVersion: async () => version,
  });

type Check = { name: string; ok: boolean; ms: number; detail?: string };
const checks: Check[] = [];
async function check(name: string, run: () => Promise<string | undefined>) {
  const start = Date.now();
  try {
    checks.push({ name, ok: true, ms: Date.now() - start, detail: await run() });
  } catch (error) {
    checks.push({ name, ok: false, ms: Date.now() - start, detail: (error as Error).name + ": " + (error as Error).message });
    return error;
  }
}

let code = 0;
const failed = (error: unknown) => {
  if (error instanceof browser.ClientVersionRejected) code = Math.max(code, 2);
  else if (error instanceof browser.BrowserLoginRequired) code = Math.max(code, 3);
  else if (error) code = Math.max(code, 1);
};
failed(await check("roster", async () => `${(await browser.browserRoster()).agents.length} bots`));
// Does not wake a sleeping computer: only checks that Grok Bot still answers.
failed(await check("computer route", async () => {
  try {
    const route = await browser.browserGateway(false);
    return new URL(route.baseUrl).hostname.endsWith(".cursorvm.com") ? "awake" : "unexpected host";
  } catch (error) {
    // A sleeping computer is normal; Grok Bot still answered the call.
    if (String((error as Error).message).includes("did not provide a running computer")) return "asleep";
    throw error;
  }
}));

rmSync(home, { recursive: true, force: true });
console.log(JSON.stringify({ ok: code === 0, code, platform: process.platform, version, versionSource, checks }, null, 2));
process.exit(code);

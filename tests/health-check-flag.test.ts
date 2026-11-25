// VOS-1672: the health check tests the flag's client version, not the built-in one.
import { expect, test } from "bun:test";
import { flagClientVersion } from "../scripts/flagVersion.ts";

const answer = (body: unknown, status = 200) =>
  (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
const flag = (payload: unknown, enabled = true) => ({ flags: { "grokbot-client-version": { enabled, metadata: { payload } } } });

test("reads this platform's version from the flag payload", async () => {
  const fetchImpl = answer(flag(JSON.stringify({ darwin: "0.80.1", win32: "0.81.0" })));
  expect(await flagClientVersion({ apiKey: "k", platform: "darwin", fetchImpl })).toBe("0.80.1");
  expect(await flagClientVersion({ apiKey: "k", platform: "win32", fetchImpl })).toBe("0.81.0");
});

test("no version when the flag is off, missing, or malformed", async () => {
  expect(await flagClientVersion({ apiKey: "k", platform: "darwin", fetchImpl: answer(flag('{"darwin":"0.80.1"}', false)) })).toBeUndefined();
  expect(await flagClientVersion({ apiKey: "k", platform: "darwin", fetchImpl: answer({ flags: {} }) })).toBeUndefined();
  expect(await flagClientVersion({ apiKey: "k", platform: "darwin", fetchImpl: answer(flag("not json")) })).toBeUndefined();
  expect(await flagClientVersion({ apiKey: "k", platform: "darwin", fetchImpl: answer(flag({ darwin: "latest" })) })).toBeUndefined();
});

test("a PostHog error is an error, never a silent fallback", async () => {
  await expect(flagClientVersion({ apiKey: "k", platform: "darwin", fetchImpl: answer({}, 401) })).rejects.toThrow("401");
});

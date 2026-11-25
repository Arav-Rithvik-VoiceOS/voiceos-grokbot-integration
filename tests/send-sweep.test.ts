// VOS-1672: old send records are pruned per generation, and again while the
// app keeps running, so text sent often ("ok") does not pile up forever.
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "grok-sweep-test-"));
process.env.HOME = home;
process.env.LOCALAPPDATA = join(home, "Local");
process.env.VOICEOS_GROKBOT_SESSION_SCOPE = "d".repeat(64);
const { sweepSends } = await import("../browserSession.ts");
afterAll(() => rmSync(home, { recursive: true, force: true }));

const DAY = 24 * 60 * 60_000;
const root = join(home, "sends");
const at = (dir: string, file: string, when: number) => {
  mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, dir, file), "{}");
  utimesSync(join(root, dir, file), when / 1000, when / 1000);
};

test("prunes old generations of a text sent often, keeps the newest, and sweeps again later", () => {
  const now = Date.now();
  // "ok" sent 30 times over 30 days: the folder itself is always recent.
  for (let g = 1; g <= 30; g++) {
    at("ok", `${g}.claim`, now - (31 - g) * DAY);
    at("ok", `${g}.settled`, now - (31 - g) * DAY);
  }
  at("stale", "1.claim", now - 9 * DAY);
  at("stale", "1.settled", now - 9 * DAY);
  sweepSends(root, now);
  const kept = readdirSync(join(root, "ok"));
  expect(kept.every((f) => Number(f.split(".")[0]) >= 24)).toBe(true);
  expect(kept).toContain("30.claim");
  expect(existsSync(join(root, "stale"))).toBe(false);

  // A long-running app sweeps again a few hours later, not only at start.
  at("later", "1.claim", now - 8 * DAY);
  sweepSends(root, now + 60_000);
  expect(existsSync(join(root, "later"))).toBe(true);
  sweepSends(root, now + 7 * 60 * 60_000);
  expect(existsSync(join(root, "later"))).toBe(false);
});

test("the newest generation stays even when it is old, while newer files exist", () => {
  const now = Date.now() + 30 * DAY;
  at("mixed", "5.claim", now - 10 * DAY);
  at("mixed", "4.settled", now - 10 * DAY);
  at("mixed", "5.settled", now - 1 * DAY);
  sweepSends(root, now);
  expect(readdirSync(join(root, "mixed")).sort()).toEqual(["5.claim", "5.settled"]);
});

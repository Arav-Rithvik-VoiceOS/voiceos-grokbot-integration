/**
 * Bot avatars: every Grok Bot shape draws with the app's own outline, and a bot
 * that wears a picture shows the picture (shrunk to a small data: URI) with its
 * shape as the fallback.
 *
 * The picture tests run the real transport (client.ts → gateway → sips) against
 * a fake signed-in session in a temp HOME and a fake gateway (global fetch), so
 * this file must set HOME before client.ts loads. `bun run test` gives every
 * test file its own process.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createCipheriv, pbkdf2Sync } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "grokbot-avatars-"));
const support = join(home, "Library/Application Support/Grok Bot");
mkdirSync(support, { recursive: true });
const cipher = createCipheriv("aes-128-cbc", pbkdf2Sync("fixture-key", "saltysalt", 1003, 16, "sha1"), Buffer.alloc(16, 0x20));
const route = JSON.stringify({ baseUrl: "https://gateway.example.invalid", token: "fixture-token" });
const encrypted = Buffer.concat([Buffer.from("v10"), cipher.update(route), cipher.final()]).toString("base64");
writeFileSync(join(support, "gateway-descriptor.json"), JSON.stringify({ entries: { fixture: { savedAtMs: 1, encrypted } } }));
writeFileSync(join(support, "desktop-status.json"), JSON.stringify({ version: 1, signedIn: true }));
const security = join(home, "security");
writeFileSync(security, "#!/bin/sh\necho fixture-key\n");
chmodSync(security, 0o755);
process.env.HOME = home;
process.env.GROKBOT_SECURITY_BIN = security;

// The fake gateway: listAgents serves `roster`; getAgentAvatar answers with `avatarReply`.
let roster: Record<string, unknown>[] = [];
let avatarCalls: string[] = [];
let avatarReply: (id: string) => Response = () => Response.json({ dataUrl: null, version: null });
globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
  const command = String(url).replace("https://gateway.example.invalid/api/", "");
  const body = JSON.parse(String(init?.body ?? "{}"));
  if (command === "listAgents") return Response.json(roster);
  if (command === "getAgentAvatar") {
    avatarCalls.push(body.id);
    return avatarReply(body.id);
  }
  throw new Error(`unexpected gateway command ${command}`);
}) as typeof fetch;

const { listAgents, shrinkAvatar, resetAvatarCache, AVATAR_IMAGE_MAX_CHARS } = await import("../client.ts");
const cards = await import("../cards.ts");
const { GROK_ALL_SHAPE_IDS, SHAPE_ART, avatarCss } = await import("../avatarShapes.ts");
type Agent = import("../client.ts").Agent;

// ── Test pictures, made from the repo's own icon with sips ───────────────────
const scratch = mkdtempSync(join(tmpdir(), "grokbot-avatar-pics-"));
const sips = (...args: string[]) => execFileSync("/usr/bin/sips", args, { encoding: "utf8" });
const dataUrl = (path: string, mime: string) => `data:${mime};base64,${readFileSync(path).toString("base64")}`;
const ICON = join(import.meta.dir, "../icon.png"); // 240×240, with transparency
sips("-s", "format", "jpeg", ICON, "--out", join(scratch, "opaque.jpg"));
sips("-c", "120", "240", ICON, "--out", join(scratch, "wide.png"));
const PNG_PICTURE = dataUrl(ICON, "image/png");
const JPEG_PICTURE = dataUrl(join(scratch, "opaque.jpg"), "image/jpeg");
const WIDE_PICTURE = dataUrl(join(scratch, "wide.png"), "image/png");
/** Pixel size and format of a data: URI, read back with sips. */
function measure(uri: string) {
  const file = join(scratch, `m-${Math.random().toString(36).slice(2)}`);
  writeFileSync(file, Buffer.from(uri.slice(uri.indexOf(",") + 1), "base64"));
  const info = sips("-g", "pixelWidth", "-g", "pixelHeight", "-g", "format", file);
  return { width: Number(/pixelWidth: (\d+)/.exec(info)?.[1]), height: Number(/pixelHeight: (\d+)/.exec(info)?.[1]), format: /format: (\w+)/.exec(info)?.[1] };
}

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
});

const htmlOf = (card: { _voiceos_glance: { blocks: { html: string }[] } }) => card._voiceos_glance.blocks[0].html;
const demo = (html: string) => JSON.parse(html.match(/^const DEMO=(.*);$/m)![1]);

// ── Shapes ───────────────────────────────────────────────────────────────────

describe("avatar shapes", () => {
  test("every shape Grok Bot can draw has the app's outline and eye spots", () => {
    expect(GROK_ALL_SHAPE_IDS).toHaveLength(25);
    expect(Object.keys(SHAPE_ART).sort()).toEqual([...GROK_ALL_SHAPE_IDS].sort());
    for (const shape of GROK_ALL_SHAPE_IDS) {
      const { poly, eyes } = SHAPE_ART[shape];
      const points = poly.split(",").map((p) => p.trim().split(" ").map((v) => parseFloat(v)));
      expect(points.length).toBeGreaterThanOrEqual(20);
      for (const [x, y] of points) {
        expect(x).toBeGreaterThan(-1); expect(x).toBeLessThan(101);
        expect(y).toBeGreaterThan(-1); expect(y).toBeLessThan(101);
      }
      expect(eyes).toHaveLength(7);
      expect(eyes.every(Number.isFinite)).toBe(true);
      const css = avatarCss([shape]);
      expect(css).toContain(`.shapes button.${shape}{clip-path:polygon(${poly})}`);
      // blob's eyes are every avatar's default; every other shape moves them.
      expect(css).toContain(shape === "blob" ? ".av .eyes{translate:" : `.av.${shape} .eyes{translate:${eyes[0]}% ${eyes[1]}%;rotate:${eyes[2]}deg;scale:${eyes[3]}}`);
    }
  });

  test("the 0.71 picker shapes are all drawable, including the 7 new ones", () => {
    for (const shape of cards.GROK_PICKER_SHAPE_IDS) expect(GROK_ALL_SHAPE_IDS).toContain(shape);
    for (const shape of ["square", "sparkle", "clover", "flower", "heart", "house", "star"])
      expect(cards.GROK_PICKER_SHAPE_IDS).toContain(shape as never);
  });

  test("a bot keeps the shape it picked, for every shape (no nearest-shape fallback)", () => {
    for (const shape of GROK_ALL_SHAPE_IDS)
      expect(cards.toBot({ id: "x", name: "X", avatarShape: shape }).shape).toBe(shape);
    // Jerome picked the new star (it used to fall to the id-derived default).
    expect(cards.toBot({ id: "jerome", name: "Jerome", avatarShape: "star", avatarColor: "red" })).toMatchObject({ shape: "star", color: "#FF263C" });
  });

  test("a bot with no shape (null or \"\") gets Grok's id-derived default from the old 8", () => {
    const old8 = ["blob", "pebble", "squircle", "tablet", "wedge", "hex", "cloud", "teardrop"];
    for (const id of ["a", "b", "jerome-jr", "9f4c0e1a-0000-4000-8000-000000000000"]) {
      const none = cards.toBot({ id, name: "X", avatarShape: null }).shape;
      expect(old8).toContain(none);
      expect(cards.toBot({ id, name: "X", avatarShape: "" }).shape).toBe(none);
      expect(cards.toBot({ id, name: "X", avatarShape: "not-a-shape" }).shape).toBe(none);
    }
  });

  test("spoken and stale-card shapes map onto real Grok ids", () => {
    expect(cards.normalizeShapeId("star")).toBe("star");
    expect(cards.normalizeShapeId(" Square ")).toBe("square");
    expect(cards.normalizeShapeId("home")).toBe("house");
    expect(cards.normalizeShapeId("circle")).toBe("blob");
    expect(cards.normalizeShapeId("sq")).toBe("squircle");
    expect(cards.normalizeShapeId("bean")).toBe("bean");
    expect(cards.normalizeShapeId("zigzag")).toBeUndefined();
    expect(cards.normalizeShapeId("")).toBeUndefined();
  });

  test("the show card carries only the shapes its bots use, plus the blob fallback", () => {
    const html = htmlOf(cards.showCard([
      { id: "j", name: "Jerome", avatarShape: "star" },
      { id: "h", name: "Hart", avatarShape: "heart" },
    ]));
    expect(html).toContain(".av.star,.shapes button.star{clip-path:polygon(");
    expect(html).toContain(".av.heart,.shapes button.heart{clip-path:polygon(");
    expect(html).toContain(".av[data-state],.av.blob,.shapes button.blob{clip-path:polygon(");
    expect(html).not.toContain(".av.clover,");
    expect(html).not.toContain(".av.pebble,");
    // The eyes follow the shape and keep their moods: the tilt is a variable.
    expect(html).toContain(".av.star .eyes{translate:");
    expect(html).toContain("transform:rotate(var(--et,12deg))");
    expect(html).not.toMatch(/__VOICEOS_[A-Z]+__/);
  });

  test("the guide carries its crew's shapes and the user's bots' shapes", () => {
    const html = htmlOf(cards.guideCard({}, [{ id: "j", name: "Jerome", avatarShape: "star" }]));
    for (const shape of ["blob", "pebble", "squircle", "tablet", "wedge", "hex", "cloud", "teardrop", "star"])
      expect(html).toContain(`.av.${shape},.shapes button.${shape}{clip-path`);
    expect(html).not.toContain(".av.house,");
  });
});

// ── Pictures in cards ────────────────────────────────────────────────────────

describe("bot pictures in cards", () => {
  const PIC = "data:image/png;base64,iVBORw0KGgo=";
  const agents: Agent[] = [
    { id: "p", name: "Piper", avatarShape: "star", avatarVersion: "1", avatarImage: PIC },
    { id: "q", name: "Quinn", avatarShape: "heart" },
    { id: "g", name: "Team", isGroup: true, memberIds: ["p", "q"], avatarImage: PIC },
  ];

  test("the show card bakes pictures in their own map, never in the roster", () => {
    const data = demo(htmlOf(cards.showCard(agents))).data;
    expect(data.avatars).toEqual({ p: PIC });
    expect(JSON.stringify(data.bots)).not.toContain("data:image");
    expect(data.bots.find((b: { id: string }) => b.id === "p").shape).toBe("star"); // the fallback stays
  });

  test("confirmation contexts and bot entries never carry a picture", () => {
    expect(cards.confirmationContext(agents, {})).not.toContain("data:image");
    expect(JSON.stringify(cards.toBot(agents[0]))).not.toContain("data:image");
  });

  test("only safe raster data: URIs are used", () => {
    const bad: Agent[] = [
      { id: "a", name: "A", avatarImage: "https://example.com/a.png" },
      { id: "b", name: "B", avatarImage: "data:image/svg+xml;base64,PHN2Zz4=" },
      { id: "c", name: "C", avatarImage: 'data:image/png;base64,AAAA"><script>' },
      { id: "d", name: "D", avatarImage: "javascript:alert(1)" },
    ];
    expect(cards.avatarMap(bad)).toEqual({});
  });

  test("pictures share one budget, and the opened bot's picture goes first", () => {
    const big = `data:image/png;base64,${"A".repeat(30_000)}`;
    const many: Agent[] = Array.from({ length: 6 }, (_, i) => ({ id: `b${i}`, name: `Bot ${i}`, avatarImage: big }));
    const map = cards.avatarMap(many, "b5");
    expect(Object.keys(map)[0]).toBe("b5");
    expect(Object.values(map).join("").length).toBeLessThanOrEqual(cards.AVATARS_MAX_CHARS);
    expect(Object.keys(map).length).toBe(Math.floor(cards.AVATARS_MAX_CHARS / big.length));
  });

  test("the show widget draws a picture over the shape, and only the shape without one", () => {
    const html = htmlOf(cards.showCard(agents));
    const line = (name: string) => html.match(new RegExp(`^const ${name}=.*$`, "m"))![0];
    const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
    const av = new Function("esc", "EYES", "D", `${line("avImg")}\n${line("av")}\nreturn av;`)(esc, "<eyes>", { avatars: { p: PIC } });
    const withPicture = av({ id: "p", shape: "star", color: "#FF263C", status: "idle" });
    expect(withPicture).toContain('class="av star  photo"');
    expect(withPicture).toContain(`<img class="pic" alt="" src="${PIC}">`);
    expect(withPicture).toContain("<eyes>"); // the shape's eyes stay underneath for the fallback
    const without = av({ id: "q", shape: "heart", color: "#FF309B", status: "idle" });
    expect(without).toBe('<span class="av heart " data-state="idle" style="--c:#FF309B"><eyes></span>');
    // A picture that fails to load uncovers the shape (the card's error handler drops `photo`).
    expect(html).toContain(".av.photo[data-state]{clip-path:none;border-radius:50%");
    expect(html).toMatch(/addEventListener\('error',e=>\{const t=e\.target;if\(!t\|\|!t\.classList\|\|!t\.classList\.contains\('pic'\)\)return;/);
  });

  test("the guide's cast carries a bot's picture", () => {
    const html = htmlOf(cards.guideCard({}, [agents[0], agents[1]]));
    const cast = demo(html).data.bots;
    expect(cast[0]).toEqual({ name: "Piper", color: cast[0].color, shape: "star", img: PIC });
    expect(cast[1].img).toBeUndefined();
  });
});

// ── Pictures from Grok Bot (real transport, fake gateway) ────────────────────

describe("bot pictures from the gateway", () => {
  const reset = () => { resetAvatarCache(); avatarCalls = []; };

  test("an inline picture becomes a 72px PNG data URI without another gateway call", async () => {
    reset();
    roster = [{ id: "p", name: "Piper", avatarVersion: "v1", avatarDataUrl: PNG_PICTURE }];
    const [piper] = await listAgents();
    expect(piper.avatarImage).toStartWith("data:image/png;base64,");
    expect(piper.avatarImage!.length).toBeLessThanOrEqual(AVATAR_IMAGE_MAX_CHARS);
    expect(measure(piper.avatarImage!)).toMatchObject({ width: 72, height: 72, format: "png" });
    expect(avatarCalls).toEqual([]);
  });

  test("a versioned picture comes from getAgentAvatar once per version", async () => {
    reset();
    avatarReply = () => Response.json({ dataUrl: JPEG_PICTURE, version: "v2" });
    roster = [{ id: "j", name: "Jerome", avatarShape: "star", avatarVersion: "v2", avatarDataUrl: null }];
    const [first] = await listAgents();
    expect(first.avatarImage).toStartWith("data:image/jpeg;base64,");
    expect(measure(first.avatarImage!)).toMatchObject({ width: 72, height: 72, format: "jpeg" });
    const [again] = await listAgents();
    expect(again.avatarImage).toBe(first.avatarImage);
    expect(avatarCalls).toEqual(["j"]);
    roster = [{ ...roster[0], avatarVersion: "v3" }];
    await listAgents();
    expect(avatarCalls).toEqual(["j", "j"]);
  });

  test("a wide picture is cropped to its middle square", async () => {
    expect(measure((await shrinkAvatar(WIDE_PICTURE))!)).toMatchObject({ width: 72, height: 72 });
  });

  test("bots without a picture, and groups, keep their shape and cost no call", async () => {
    reset();
    roster = [
      { id: "a", name: "Plain", avatarShape: "house", avatarVersion: null, avatarDataUrl: null },
      { id: "b", name: "Blank", avatarVersion: "", avatarDataUrl: "" },
      { id: "g", name: "Team", isGroup: true, avatarVersion: "v1" },
    ];
    const agents = await listAgents();
    expect(agents.map((a) => a.avatarImage)).toEqual([undefined, undefined, undefined]);
    expect(avatarCalls).toEqual([]);
    expect(cards.toBot(agents[0]).shape).toBe("house");
  });

  test("a picture that cannot be used falls back to the shape, and never fails the roster", async () => {
    for (const reply of [
      () => Response.json({ dataUrl: "https://cdn.example.invalid/a.png?X-Amz-Signature=secret", version: "v1" }),
      () => Response.json({ dataUrl: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=", version: "v1" }),
      () => Response.json({ dataUrl: "data:image/png;base64,bm90IGEgcGljdHVyZQ==", version: "v1" }),
      () => Response.json({ dataUrl: null, version: null }),
      () => Response.json({ error: "boom" }, { status: 500 }),
    ]) {
      reset();
      avatarReply = reply;
      roster = [{ id: "x", name: "Xavier", avatarShape: "clover", avatarVersion: "v1" }];
      const [x] = await listAgents();
      expect(x.avatarImage).toBeUndefined();
      expect(cards.toBot(x).shape).toBe("clover");
    }
  });
});

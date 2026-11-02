import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { orderRoster, rosterSections, rosterData, showCard, UNASSIGNED_SECTION, GROK_ALL_SHAPE_IDS } from "../cards.ts";
import { base32, readSidebarPrefs, type Agent } from "../client.ts";

// The Grok Bot sidebar (0.78.1): pinned rows first in pin order, then the rest
// by their newest moment; sections keep that order inside them, "Unassigned"
// collects the rest and only shows when it has rows.
const bot = (id: string, at: number, extra: Partial<Agent> = {}): Agent => ({ id, name: id.toUpperCase(), lastActivityAt: at, ...extra });

describe("roster order", () => {
  test("pinned first in pin order, then newest activity first", () => {
    const agents = [bot("a", 10), bot("b", 30), bot("c", 20), bot("d", 40)];
    expect(orderRoster(agents, ["c", "a"]).map((a) => a.id)).toEqual(["c", "a", "d", "b"]);
  });
  test("a pin for a bot that no longer exists is ignored", () => {
    expect(orderRoster([bot("a", 1)], ["ghost", "a"]).map((a) => a.id)).toEqual(["a"]);
  });
  test("the newer of updatedAt and lastActivityAt counts, like the app", () => {
    const agents = [bot("spoke", 50), bot("renamed", 10, { updatedAt: 60 })];
    expect(orderRoster(agents).map((a) => a.id)).toEqual(["renamed", "spoke"]);
  });
  test("no timestamps: the gateway's own order stays", () => {
    const agents = [bot("x", 0), bot("y", 0), bot("z", 0)];
    expect(orderRoster(agents).map((a) => a.id)).toEqual(["x", "y", "z"]);
  });
  test("groups sort with the bots and get their place back in the card", () => {
    const agents = [bot("a", 10), bot("g", 30, { isGroup: true, memberIds: ["a"] }), bot("b", 20)];
    const { card, order } = rosterData(agents, { pinnedIds: [], sections: [] });
    expect(order).toEqual(["g", "b", "a"]);
    expect(card.groups[0]).toMatchObject({ id: "g", ix: 0, shape: expect.any(String), color: expect.stringMatching(/^#/) });
    expect(card.bots.map((b) => b.id)).toEqual(["b", "a"]);
  });
});

describe("roster sections", () => {
  const agents = [bot("a", 10), bot("b", 30), bot("c", 20), bot("d", 40), bot("e", 5)];
  const prefs = { pinnedIds: ["b"], sections: [
    { id: "s1", name: "School", agentIds: ["a", "b", "c"] },
    { id: "s2", name: "Work", agentIds: [], isCollapsed: true },
  ] };
  test("each section lists its unpinned rows in roster order; Unassigned takes the rest", () => {
    const sections = rosterSections(orderRoster(agents, prefs.pinnedIds), prefs);
    expect(sections).toEqual([
      { id: "s1", name: "School", ids: ["c", "a"] },
      { id: "s2", name: "Work", ids: [], collapsed: true },
      { id: UNASSIGNED_SECTION, name: "Unassigned", ids: ["d", "e"] },
    ]);
  });
  test("no sections means a flat list; Unassigned is dropped when empty", () => {
    expect(rosterSections(agents, { pinnedIds: [], sections: [] })).toEqual([]);
    const all = { pinnedIds: [], sections: [{ id: "s", name: "All", agentIds: ["a", "b", "c", "d", "e"] }] };
    expect(rosterSections(orderRoster(agents), all).map((s) => s.id)).toEqual(["s"]);
  });
  test("the card carries pins, sections, the Main Bot and per-row flags", () => {
    const { card } = rosterData([...agents, bot("u", 1, { hasUnread: true })], { ...prefs, mainId: "d" });
    expect(card.pinned).toEqual(["b"]);
    expect(card.mainId).toBe("d");
    expect(card.bots.find((b) => b.id === "b")).toMatchObject({ pinned: true });
    expect(card.bots.find((b) => b.id === "d")).toMatchObject({ main: true });
    expect(card.bots.find((b) => b.id === "u")).toMatchObject({ unread: true });
    expect("pinned" in card.bots.find((b) => b.id === "a")!).toBe(false);
    const html = showCard(agents, undefined, {}, {}, undefined, { ...prefs, mainId: "d" })._voiceos_glance.blocks[0].html;
    const data = JSON.parse(html.match(/^const DEMO=(.*);$/m)![1]).data;
    expect(data.sections.map((s: { id: string }) => s.id)).toEqual(["s1", "s2", UNASSIGNED_SECTION]);
    expect(data.pinned).toEqual(["b"]);
    expect(data.bots.map((b: { id: string }) => b.id)).toEqual(["b", "d", "c", "a", "e"]);
  });
});

describe("roster card markup", () => {
  test("a star-shaped bot keeps its 36px orb: the Main Bot badge class is never a shape id", () => {
    const star: Agent = { id: "s", name: "Starry", avatarShape: "star", avatarColor: "red", avatarVersion: "v1", avatarImage: "data:image/png;base64,iVBORw0KGgo=" };
    const html = showCard([star], undefined, {}, {}, undefined, { pinnedIds: [], sections: [], mainId: "s" })._voiceos_glance.blocks[0].html;
    expect(html).toContain('class="mb"');
    for (const shape of GROK_ALL_SHAPE_IDS) expect(html).not.toMatch(new RegExp(`\\.orb(\\.[a-z]+)? \\.${shape}[\\s{,]`));
  });
});

describe("sidebar prefs from the app's caches", () => {
  const slot = "auth0|user_01TEST";
  const key = (k: string) => base32(`sand.client.slice.${k}`);
  const dir = mkdtempSync(join(tmpdir(), "grokbot-prefs-"));
  const blob = (k: string, value: unknown) => writeFileSync(join(dir, `${key(k)}.blob`), JSON.stringify({ schemaVersion: 1, value }));
  test("base32 names match the app's files", () => {
    // The app's own name for the account slot slice (seen on disk, 0.78.1).
    expect(base32("sand.client.slice.client-meta.account-slot")).toBe("onqw4zbomnwgszlooqxhg3djmnss4y3mnfsw45bnnvsxiyjomfrwg33vnz2c243mn52a");
  });
  test("pins, sections and folded sections come from the slot's slices", () => {
    blob("client-meta.account-slot", slot);
    const scope = `account.${encodeURIComponent(slot)}.`;
    blob(`${scope}ui-agent-refs`, { pinnedAgentIds: ["p1", "p2", 7], collapsedSectionIds: ["s2"] });
    blob(`${scope}sidebar.last-sections`, { sections: [{ id: "s1", name: "School", agentIds: ["a"], isCollapsed: false }, { id: "s2", name: "Work", agentIds: ["b"] }, { bad: true }] });
    expect(readSidebarPrefs({ dir, settings: join(dir, "none.json") })).toEqual({
      pinnedIds: ["p1", "p2"],
      sections: [{ id: "s1", name: "School", agentIds: ["a"] }, { id: "s2", name: "Work", agentIds: ["b"], isCollapsed: true }],
    });
  });
  test("an older app's settings file is the fallback; nothing readable means nothing pinned", () => {
    const old = mkdtempSync(join(tmpdir(), "grokbot-prefs-old-"));
    const settings = join(old, "settings.json");
    writeFileSync(settings, JSON.stringify({ pinnedAgentIds: ["z"], sidebarSections: [{ id: "s", name: "S", agentIds: ["z"], isCollapsed: true }] }));
    expect(readSidebarPrefs({ dir: join(old, "missing"), settings })).toEqual({ pinnedIds: ["z"], sections: [{ id: "s", name: "S", agentIds: ["z"], isCollapsed: true }] });
    mkdirSync(join(old, "empty"));
    expect(readSidebarPrefs({ dir: join(old, "empty"), settings: join(old, "nope.json") })).toEqual({ pinnedIds: [], sections: [] });
    rmSync(old, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  });
});

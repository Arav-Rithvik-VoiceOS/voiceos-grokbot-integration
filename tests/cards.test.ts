import { describe, expect, test } from "bun:test";
import { toCardItem, toCardThread, toThread as threadItems, boundThread, type CardItem } from "../conversation.ts";
import { conversationSnapshot, conversationEntry, conversationTransport } from "../conversationService.ts";
import {
  renderCard, showCard, connectCard, glanceChars,
  relTime, toThread, toBot, MAX_GLANCE_CHARS, confirmationContext, CONFIRMATION_CONTEXT_CHARS,
} from "../cards.ts";
import {
  LIVE_CHAT_JS, LIVE_CHAT_CSS, MARKDOWN_CSS,
  COMPOSER_KIT_JS, COMPOSER_KIT_CSS, SHOW_ADAPTER, SHOW_CSS, MARK_DATA_URI, WIDGETS,
} from "../assets.generated.ts";
import type { Agent, TranscriptEntry } from "../client.ts";

const MAX_GLANCE = MAX_GLANCE_CHARS;
const htmlOf = (card: { _voiceos_glance: { blocks: { html: string }[] } }) => card._voiceos_glance.blocks[0].html;
const demo = (html: string) => JSON.parse(html.match(/^const DEMO=(.*);$/m)![1]);
const scripts = (html: string) => [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);

const PRIVATE = ["file://", "/Users/arav", "/home/box"];
const picture: TranscriptEntry = {
  id: "picture",
  kind: "send-message",
  author: { id: "p", name: "Pepper" },
  timestampMs: Date.now() - 5 * 60_000,
  message: {
    type: "text",
    content: "Two concepts",
    images: [
      { url: "file:///home/box/agent-data/a.png", alt: "Concept A" },
      { url: "/Users/arav/Pictures/b.png", alt: "Concept B" },
    ],
  },
};
const upload: TranscriptEntry = {
  id: "upload",
  kind: "user-attachment",
  file_path: "/Users/arav/Private/report.pdf",
  file_name: "report.pdf",
};
const answered: TranscriptEntry = {
  id: "answered",
  kind: "send-message",
  respondedValue: "Ship it",
  message: {
    type: "widget",
    widget: { prompt: "Ship?", options: [{ label: "Ship it", value: "Ship it" }] },
  },
};
const approval: TranscriptEntry = {
  id: "approval",
  kind: "send-message",
  message: { type: "permission-request", permission: { title: "Approve command" } },
};
const huge = (id: string, size = 20_000): TranscriptEntry => ({
  id,
  kind: "send-message",
  timestampMs: Date.now() - 60_000,
  message: { type: "text", content: `# ${id}\n\n` + '"quoted" plain words here '.repeat(size / 26) },
});
// A rendered-size item without the markdown cost, for roster-scale tests.
const bigItem = (id: string, size = 20_000): CardItem => {
  const text = '"quoted" plain words here '.repeat(size / 26);
  return { id, from: "bot", text, html: `<p>${text}</p>`, timestampMs: Date.now() - 60_000 };
};
const short = (i: number): TranscriptEntry => ({
  id: `short-${i}`,
  kind: "message",
  role: "user",
  content: `Message ${i}: ` + "a reasonably ordinary sentence ".repeat(8),
});
const roster = (n: number): Agent[] => Array.from({ length: n }, (_, i) => ({ id: `b${i}`, name: `Bot ${i}`, avatarShape: "hex" }));
// Realistic worst case: UUID ids, long names and titles, full previews, every shape.
const SHAPES = ["blob", "pebble", "squircle", "tablet", "wedge", "hex", "cloud", "teardrop"];
const bigRoster = (n: number): Agent[] => Array.from({ length: n }, (_, i) => ({
  id: `${String(i).padStart(8, "0")}-1f2e-4d3c-8b7a-0123456789ab`, name: `Research and outreach assistant ${i}`,
  title: "Executive assistant for the research team", avatarShape: SHAPES[i % 8], avatarColor: "violet",
  lastMessagePreview: "Here is the summary of everything I found about the quarterly numbers and the draft ".repeat(3),
  lastActivityAt: Date.now() - 3_600_000,
}));

describe("card items", () => {
  test("never carry a media path, and keep every field the live chat renders", () => {
    const items = toCardThread([picture, upload, answered, approval]);
    const json = JSON.stringify(items);
    for (const secret of PRIVATE) expect(json).not.toContain(secret);
    expect(items[0]).toMatchObject({ id: "picture", from: "bot", bot: "p", sender: "Pepper", timestampMs: picture.timestampMs });
    // index = the position in entryMedia(entry), which grokbot_card_image resolves.
    expect(items[0].media).toEqual([
      { kind: "image", name: "Concept A", index: 0 },
      { kind: "image", name: "Concept B", index: 1 },
    ]);
    expect(items[0].html).toContain("Two concepts");
    expect(items[1]).toMatchObject({ from: "me", media: [{ kind: "file", name: "report.pdf", index: 0 }] });
    expect(items[2]).toMatchObject({ state: "resolved", answer: "Ship it", choice: { prompt: "Ship?" } });
    expect(items[3]).toMatchObject({ state: "pending", request: { title: "Approve command" } });
    for (const item of items) {
      expect("t" in item).toBe(false);
      expect(toCardItem(item)).toEqual(item);
    }
  });
  test("deferred previews stay card items with their version", () => {
    const [preview] = boundThread(threadItems([huge("big", 60_000)]), 4_000);
    expect(preview.deferred?.version).toMatch(/^[0-9a-f]{24}$/);
    expect(preview.text!.length).toBeLessThanOrEqual(160);
    expect(toCardItem(preview)).toEqual(preview);
  });
  test("cards bake a relative-time label; nothing else does", () => {
    const [baked] = toThread([picture]);
    expect(baked.t).toBe(relTime(picture.timestampMs));
    expect(baked.t).toBe("5m");
    expect(toThread([upload])[0].t).toBeUndefined();
  });
});

describe("snapshot and entry reader", () => {
  const entries = [huge("huge", 60_000), { ...picture, id: "small" }];
  const transport = {
    ...conversationTransport,
    listAgents: async () => [{ id: "sam", name: "Sam" }],
    transcriptTail: async () => ({ entries, nextBeforeSeq: 77 }),
  };
  test("a snapshot's deferred version is the version the entry reader serves", async () => {
    const snap = await conversationSnapshot("sam", undefined, transport);
    expect(snap.nextBeforeSeq).toBe(77);
    for (const item of snap.thread) expect("t" in item).toBe(false);
    for (const secret of PRIVATE) expect(JSON.stringify(snap.thread)).not.toContain(secret);
    const stub = snap.thread.find((i) => i.id === "huge")!;
    expect(stub.deferred).toBeDefined();
    let offset = 0, joined = "", reads = 0;
    for (;;) {
      const part = await conversationEntry("sam", "huge", offset, stub.deferred!.version, transport);
      expect(part.version).toBe(stub.deferred!.version);
      expect(part.offset).toBe(offset);
      joined += part.chunk;
      reads++;
      if (part.nextOffset === null) break;
      offset = part.nextOffset;
    }
    expect(reads).toBeGreaterThan(1);
    expect(JSON.parse(joined)).toEqual(toCardThread([entries[0]])[0]);
  });
  test("the entry reader serves a card item: no media path, no time label", async () => {
    const part = await conversationEntry("sam", "small", 0, undefined, transport);
    const item = JSON.parse(part.chunk);
    expect(item.media).toEqual([
      { kind: "image", name: "Concept A", index: 0 },
      { kind: "image", name: "Concept B", index: 1 },
    ]);
    for (const secret of PRIVATE) expect(part.chunk).not.toContain(secret);
    expect("t" in item).toBe(false);
  });
});

describe("baked cards stay under the glance cap", () => {
  test("the show card shrinks, then drops, prefetched panes; the roster always stays", () => {
    const agents = roster(30);
    const threads = Object.fromEntries(agents.map((a) => [a.id, Array.from({ length: 6 }, (_, i) => bigItem(`${a.id}-${i}`))]));
    const seqs = Object.fromEntries(agents.map((a) => [a.id, 11]));
    const card = showCard(agents, undefined, threads, seqs);
    expect(glanceChars(card)).toBeLessThanOrEqual(MAX_GLANCE);
    const data = demo(htmlOf(card)).data;
    expect(data.bots).toHaveLength(30);
    // A pane that lost its history also loses its cursor (it would skip messages).
    for (const id of Object.keys(data.nextBeforeSeqs)) expect(data.threads[id]).toBeDefined();
  });
  test("an ordinary roster opens every chat pane prefetched", () => {
    const agents = roster(12);
    const threads = Object.fromEntries(agents.map((a) => [a.id, toCardThread(Array.from({ length: 6 }, (_, i) => ({ ...short(i), id: `${a.id}-${i}` })))]));
    const data = demo(htmlOf(showCard(agents, undefined, threads))).data;
    for (const a of agents) expect(data.threads[a.id]).toHaveLength(6);
    for (const a of agents) expect(data.threads[a.id].every((i: { deferred?: unknown }) => !i.deferred)).toBe(true);
  });
  for (const n of [60, 100, 200]) {
    test(`${n} long-named bots: the show card stays under the cap and keeps history`, () => {
      const agents = bigRoster(n);
      const entries = Array.from({ length: 30 }, (_, i) => short(i));
      const threads = Object.fromEntries(agents.map((a) => [a.id, toCardThread(entries.slice(0, 6))]));
      const show = showCard(agents, undefined, threads);
      expect(glanceChars(show)).toBeLessThanOrEqual(MAX_GLANCE);
      expect(demo(htmlOf(show)).data.bots).toHaveLength(n);
      // Every roster row is one ellipsized line.
      for (const b of demo(htmlOf(show)).data.bots) expect(b.task.length).toBeLessThanOrEqual(120);
    });
  }
  test("a roster too big for any history degrades to a slim roster, never an over-cap card", () => {
    const agents = bigRoster(1_000);
    const show = showCard(agents, undefined, { [agents[0].id]: toCardThread([short(1)]) });
    expect(glanceChars(show)).toBeLessThanOrEqual(MAX_GLANCE);
    expect(demo(htmlOf(show)).data.bots).toHaveLength(1_000);
  });
  test("small prefetched panes are kept whole with their cursors and time labels", () => {
    const agents = roster(4);
    const threads = { b0: toCardThread([picture]), b1: [] };
    const data = demo(htmlOf(showCard(agents, undefined, threads, { b0: 3, b1: 4 }))).data;
    expect(data.threads.b0[0]).toMatchObject({ id: "picture", t: "5m" });
    expect(data.threads.b1).toBeUndefined();
    expect(data.nextBeforeSeqs).toEqual({ b0: 3 });
  });
  test("a huge opened conversation fits the cap and keeps its history ahead of other bots", () => {
    const agents = roster(3);
    const entries = Array.from({ length: 30 }, (_, i) => huge(`h${i}`));
    const threads = {
      b0: toCardThread(entries),
      b1: [bigItem("b1-0")],
      b2: [bigItem("b2-0")],
    };
    const card = showCard(agents, undefined, threads, { b0: 42 }, { open: { bot: "b0" } });
    expect(glanceChars(card)).toBeLessThanOrEqual(MAX_GLANCE);
    const data = demo(htmlOf(card)).data;
    expect(data.threads.b0.map((i: { id: string }) => i.id)).toEqual(entries.map((e) => e.id));
    expect(data.threads.b0.some((i: { deferred?: unknown }) => i.deferred)).toBe(true);
    expect(data.nextBeforeSeqs.b0).toBe(42);
  });
  test("the opened conversation is baked first, ahead of roster order", () => {
    const agents = roster(4); // b0, b1, b2, b3
    const threads = {
      b2: [bigItem("b2-0")],
      b0: [bigItem("b0-0")],
      b1: [bigItem("b1-0")],
    };
    const card = showCard(agents, undefined, threads, {}, { open: { bot: "b2" } });
    const data = demo(htmlOf(card)).data;
    expect(Object.keys(data.threads)[0]).toBe("b2");
  });
});

describe("renderCard asset injection", () => {
  test("a confirmation context over budget keeps the bots it draws whole", () => {
    const agents = bigRoster(400);
    const keep = agents[5].id;
    const rows = { [agents[0].id]: [{ id: "r", from: "bot" as const, bot: keep, text: "Hi" }] };
    const send = JSON.parse(confirmationContext(agents, rows, [agents[0].id], true));
    expect(JSON.stringify(send).length).toBeLessThanOrEqual(CONFIRMATION_CONTEXT_CHARS);
    expect(send.bots.map((b: { id: string }) => b.id)).toEqual([agents[0].id, keep]);
    expect(send.bots[0]).toMatchObject({ ...toBot(agents[0]), task: "" });
    // A group confirmation adds members from the whole roster: nobody drops out.
    const group = JSON.parse(confirmationContext([...agents.slice(0, 200), { id: "g", name: "Crew", isGroup: true, memberIds: [agents[1].id] }], { g: [] }, []));
    expect(group.bots).toHaveLength(200);
    expect(group.bots[1].label).toBe("Executive assistant for the research team");
    expect(group.groups[0]).toMatchObject({ id: "g", last: "" });
  });
  test("the show card appends the live chat glue in its own scope after its data", () => {
    const html = htmlOf(showCard(roster(3), undefined, { b0: toCardThread([picture]) }));
    const [script, ...rest] = scripts(html);
    expect(rest).toHaveLength(0);
    expect(script.endsWith(`\n(()=>{\n${LIVE_CHAT_JS}\n${COMPOSER_KIT_JS}\n${SHOW_ADAPTER}\n})();\n`)).toBe(true);
    expect(html).toContain(`<style>${MARKDOWN_CSS}\n${LIVE_CHAT_CSS}\n${COMPOSER_KIT_CSS}\n${SHOW_CSS}</style>\n<script>`);
    expect(demo(html).data.threads.b0[0].id).toBe("picture");
    expect(html).not.toContain("__VOICEOS_DEMO__");
    expect(() => new Function(script)).not.toThrow();
  });
  test("open.bot bakes args.open and the pane's draft message", () => {
    const html = htmlOf(showCard(roster(3), undefined, {}, {}, { open: { bot: "b0" }, message: "Hi" }));
    const baked = demo(html);
    expect(baked.args.open).toEqual({ bot: "b0" });
    expect(baked.args.message).toBe("Hi");
  });
  test("open.members bakes the args but focuses no single conversation", () => {
    const agents = roster(3);
    // Same-size threads on both bots: if either were "focused" it would get a much
    // larger budget and stay whole while the other truncates. Neither should here.
    const threads = { b0: [bigItem("b0-huge")], b1: [bigItem("b1-huge")] };
    const html = htmlOf(showCard(agents, undefined, threads, {}, { open: { members: ["b0", "b1"] } }));
    const baked = demo(html);
    expect(baked.args.open).toEqual({ members: ["b0", "b1"] });
    expect(baked.args.message).toBeUndefined();
    expect(!!baked.data.threads.b0[0].deferred).toBe(!!baked.data.threads.b1[0].deferred);
  });
  test("other cards carry none of it", () => {
    for (const html of [htmlOf(connectCard()), renderCard("create", { data: {}, args: {} })])
      for (const marker of ["const LiveChat", "const ComposerKit"]) expect(html).not.toContain(marker);
  });
  test("the logo is embedded once per card, however many marks it draws", () => {
    const cards = [showCard(roster(2)), connectCard()];
    for (const html of cards.map(htmlOf)) {
      expect(html.split(MARK_DATA_URI).length - 1).toBe(1);
      expect(html).not.toContain('class="mark"><i></i>');
    }
  });
  test("stripped template comments are real comments, never \"/*\" inside a string", () => {
    for (const name of ["show", "screen"]) {
      const src = WIDGETS[name];
      for (const m of src.matchAll(/\/\*[\s\S]*?\*\//g)) {
        const before = src.slice(src.lastIndexOf("\n", m.index!) + 1, m.index);
        expect((before.match(/'/g) ?? []).length % 2, `${name}: ${m[0].slice(0, 40)}`).toBe(0);
        expect((before.match(/"/g) ?? []).length % 2, `${name}: ${m[0].slice(0, 40)}`).toBe(0);
      }
    }
  });
  test("injected assets cannot close their own script or style element", () => {
    for (const js of [LIVE_CHAT_JS, COMPOSER_KIT_JS, SHOW_ADAPTER]) expect(js).not.toMatch(/<\/script/i);
    for (const css of [LIVE_CHAT_CSS, COMPOSER_KIT_CSS, MARKDOWN_CSS, SHOW_CSS]) expect(css).not.toMatch(/<\/style/i);
  });
  test("transcript text cannot end the payload script of a live card", () => {
    const hostile: TranscriptEntry = { id: "x", kind: "message", content: '</script><script>parent.postMessage("pwn")</script> $& __VOICEOS_DEMO__' };
    for (const card of [showCard(roster(1), undefined, { b0: toCardThread([hostile]) }), showCard(roster(1), undefined, { b0: toCardThread([hostile]) }, {}, { open: { bot: "b0" } })]) {
      const html = htmlOf(card);
      expect(scripts(html)).toHaveLength(1);
      expect(() => new Function(scripts(html)[0])).not.toThrow();
      expect(JSON.stringify(demo(html))).toContain("__VOICEOS_DEMO__");
    }
  });
});

import { describe, expect, test } from "bun:test";
import { toCardItem, toCardThread, toThread as threadItems, boundThread, type CardItem } from "../conversation.ts";
import { conversationSnapshot, conversationEntry, conversationTransport } from "../conversationService.ts";
import {
  renderCard, threadCard, groupThreadCard, groupComposeCard, showCard, sentCard, sentGroupCard, connectCard, glanceChars,
  pinnedConfirmationAdapter, relTime, toThread,
} from "../cards.ts";
import {
  MESSAGING_ADAPTER, MESSAGING_CSS, LIVE_CHAT_JS, LIVE_CHAT_CSS, MARKDOWN_CSS,
  COMPOSER_KIT_JS, COMPOSER_KIT_CSS, SHOW_ADAPTER, MARK_DATA_URI, WIDGETS,
} from "../assets.generated.ts";
import type { Agent, TranscriptEntry } from "../client.ts";

const MAX_GLANCE = 96_000;
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
  test("a 1:1 thread of huge messages defers them and keeps its older-messages cursor", () => {
    const entries = Array.from({ length: 30 }, (_, i) => huge(`h${i}`));
    const card = threadCard({ id: "b0", name: "Bot 0" }, entries, "", roster(3), 42);
    expect(glanceChars(card)).toBeLessThanOrEqual(MAX_GLANCE);
    const data = demo(htmlOf(card)).data;
    expect(data.thread.map((i: { id: string }) => i.id)).toEqual(entries.map((e) => e.id));
    expect(data.thread.some((i: { deferred?: unknown }) => i.deferred)).toBe(true);
    expect(data.nextBeforeSeq).toBe(42);
    expect(data.thread[0].t).toBe("1m");
    // A 30-bot roster leaves less room: still under the cap, newest kept.
    const crowded = threadCard({ id: "b0", name: "Bot 0" }, entries, "", roster(30), 42);
    expect(glanceChars(crowded)).toBeLessThanOrEqual(MAX_GLANCE);
    expect(demo(htmlOf(crowded)).data.thread.at(-1).id).toBe("h29");
  });
  test("too many short messages keep the newest and drop the stale cursor", () => {
    const entries = Array.from({ length: 900 }, (_, i) => short(i));
    const card = threadCard({ id: "b0", name: "Bot 0" }, entries, "", roster(3), 42);
    expect(glanceChars(card)).toBeLessThanOrEqual(MAX_GLANCE);
    const data = demo(htmlOf(card)).data;
    expect(data.thread.length).toBeGreaterThan(0);
    expect(data.thread.length).toBeLessThan(entries.length);
    expect(data.thread.at(-1).id).toBe("short-899");
    expect(data.nextBeforeSeq).toBeUndefined();
  });
  test("an ordinary thread is baked whole", () => {
    const entries = Array.from({ length: 10 }, (_, i) => short(i));
    const data = demo(htmlOf(threadCard({ id: "b0", name: "Bot 0" }, entries, "", roster(3), 9))).data;
    expect(data.thread).toHaveLength(10);
    expect(data.thread.every((i: { deferred?: unknown }) => !i.deferred)).toBe(true);
    expect(data.nextBeforeSeq).toBe(9);
  });
  test("an existing group thread of huge messages fits", () => {
    const entries = Array.from({ length: 30 }, (_, i) => huge(`g${i}`));
    const card = groupThreadCard(roster(20), { id: "g", name: "Crew", members: ["b0", "b1"] }, entries, "", 5);
    expect(glanceChars(card)).toBeLessThanOrEqual(MAX_GLANCE);
    const data = demo(htmlOf(card)).data;
    expect(data.groups[0].thread).toHaveLength(30);
    expect(data.nextBeforeSeq).toBe(5);
    expect(demo(htmlOf(card)).args.group).toBe("g");
  });
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
  test("small prefetched panes are kept whole with their cursors and time labels", () => {
    const agents = roster(4);
    const threads = { b0: toCardThread([picture]), b1: [] };
    const data = demo(htmlOf(showCard(agents, undefined, threads, { b0: 3, b1: 4 }))).data;
    expect(data.threads.b0[0]).toMatchObject({ id: "picture", t: "5m" });
    expect(data.threads.b1).toBeUndefined();
    expect(data.nextBeforeSeqs).toEqual({ b0: 3 });
  });
});

describe("renderCard asset injection", () => {
  test("the thread card carries the live chat and composer kit inside its one script", () => {
    const html = htmlOf(threadCard({ id: "b0", name: "Bot 0" }, [picture]));
    const [script, ...rest] = scripts(html);
    expect(rest).toHaveLength(0);
    expect(script.endsWith(`\n${LIVE_CHAT_JS}\n${COMPOSER_KIT_JS}\n${MESSAGING_ADAPTER}\n})();\n`)).toBe(true);
    expect(script.startsWith("\n(()=>{\n")).toBe(true);
    expect(html).toContain(`<style>${MESSAGING_CSS}\n${MARKDOWN_CSS}\n${LIVE_CHAT_CSS}\n${COMPOSER_KIT_CSS}</style>\n<script>`);
    expect(() => new Function(script)).not.toThrow();
  });
  test("a confirmation keeps its adapter (recipient-pinned) and gains only the markdown CSS", () => {
    const html = renderCard("thread", { data: { confirmation: true, tool: "grokbot_send", bots: [], groups: [], threads: {}, me: "" }, args: {} });
    const [script] = scripts(html);
    expect(script).toContain(pinnedConfirmationAdapter());
    expect(html).toContain(`<style>${MESSAGING_CSS}\n${MARKDOWN_CSS}</style>\n<script>`);
    for (const marker of ["const LiveChat", "const ComposerKit", "voiceos:invokeTool"]) expect(html).not.toContain(marker);
    if (MESSAGING_ADAPTER) expect(html).not.toContain(MESSAGING_ADAPTER);
    // A frozen confirmation has an empty sample roster; its live bots arrive
    // over init, so every avatar shape must survive.
    expect(html).toContain(".av.teardrop");
    expect(() => new Function(script)).not.toThrow();
  });
  test("sent receipts are unchanged: the messaging adapter and its CSS only", () => {
    for (const card of [sentCard({ id: "b0", name: "Bot 0" }, "Hello $& $'"), sentGroupCard(roster(2), { id: "g", name: "Crew", members: ["b0", "b1"] }, "Hello")]) {
      const html = htmlOf(card);
      const [script, ...rest] = scripts(html);
      expect(rest).toHaveLength(0);
      expect(script.endsWith(`\n${MESSAGING_ADAPTER}\n})();\n`)).toBe(true);
      expect(html).toContain(`<style>${MESSAGING_CSS}</style>\n<script>`);
      for (const marker of ["const LiveChat", "const ComposerKit"]) expect(html).not.toContain(marker);
      expect(demo(html).args.message).toStartWith("Hello");
    }
    expect(demo(htmlOf(sentCard({ id: "b0", name: "Bot 0" }, "Hello $& $'"))).args.message).toBe("Hello $& $'");
  });
  test("the show card appends the live chat glue in its own scope after its data", () => {
    const html = htmlOf(showCard(roster(3), undefined, { b0: toCardThread([picture]) }));
    const [script, ...rest] = scripts(html);
    expect(rest).toHaveLength(0);
    expect(script.endsWith(`\n(()=>{\n${LIVE_CHAT_JS}\n${COMPOSER_KIT_JS}\n${SHOW_ADAPTER}\n})();\n`)).toBe(true);
    expect(html).toContain(`<style>${MARKDOWN_CSS}\n${LIVE_CHAT_CSS}\n${COMPOSER_KIT_CSS}</style>\n<script>`);
    expect(demo(html).data.threads.b0[0].id).toBe("picture");
    expect(html).not.toContain("__VOICEOS_DEMO__");
    if (MESSAGING_ADAPTER) expect(html).not.toContain(MESSAGING_ADAPTER);
    expect(() => new Function(script)).not.toThrow();
  });
  test("the new-group compose mode keeps the plain adapter; an existing group gets the live chat", () => {
    const newGroup = htmlOf(groupComposeCard(roster(3), ["b0", "b1"], "Crew"));
    const [script, ...rest] = scripts(newGroup);
    expect(rest).toHaveLength(0);
    expect(script.endsWith(`\n${MESSAGING_ADAPTER}\n})();\n`)).toBe(true);
    expect(newGroup).toContain(`<style>${MESSAGING_CSS}</style>\n<script>`);
    for (const marker of ["const LiveChat", "const ComposerKit"]) expect(newGroup).not.toContain(marker);
    expect(() => new Function(script)).not.toThrow();
    const existing = htmlOf(groupThreadCard(roster(3), { id: "g", name: "Crew", members: ["b0", "b1"] }, [picture]));
    expect(scripts(existing)[0].endsWith(`\n${LIVE_CHAT_JS}\n${COMPOSER_KIT_JS}\n${MESSAGING_ADAPTER}\n})();\n`)).toBe(true);
  });
  test("other cards carry none of it", () => {
    for (const html of [htmlOf(connectCard()), renderCard("create", { data: {}, args: {} })])
      for (const marker of ["const LiveChat", "const ComposerKit"]) expect(html).not.toContain(marker);
  });
  test("the logo is embedded once per card, however many marks it draws", () => {
    const cards = [threadCard({ id: "b0", name: "Bot 0" }, []), showCard(roster(2)), sentCard({ id: "b0", name: "Bot 0" }, "Hi"), connectCard()];
    for (const html of cards.map(htmlOf)) {
      expect(html.split(MARK_DATA_URI).length - 1).toBe(1);
      expect(html).not.toContain('class="mark"><i></i>');
    }
    expect(htmlOf(cards[0]).match(/class="voiceos-mk"/g)).toHaveLength(3);
  });
  test("stripped template comments are real comments, never \"/*\" inside a string", () => {
    for (const name of ["thread", "show", "screen"]) {
      const src = WIDGETS[name];
      for (const m of src.matchAll(/\/\*[\s\S]*?\*\//g)) {
        const before = src.slice(src.lastIndexOf("\n", m.index!) + 1, m.index);
        expect((before.match(/'/g) ?? []).length % 2, `${name}: ${m[0].slice(0, 40)}`).toBe(0);
        expect((before.match(/"/g) ?? []).length % 2, `${name}: ${m[0].slice(0, 40)}`).toBe(0);
      }
    }
  });
  test("injected assets cannot close their own script or style element", () => {
    for (const js of [LIVE_CHAT_JS, COMPOSER_KIT_JS, SHOW_ADAPTER, MESSAGING_ADAPTER]) expect(js).not.toMatch(/<\/script/i);
    for (const css of [LIVE_CHAT_CSS, COMPOSER_KIT_CSS, MARKDOWN_CSS, MESSAGING_CSS]) expect(css).not.toMatch(/<\/style/i);
  });
  test("transcript text cannot end the payload script of a live card", () => {
    const hostile: TranscriptEntry = { id: "x", kind: "message", content: '</script><script>parent.postMessage("pwn")</script> $& __VOICEOS_DEMO__' };
    for (const card of [threadCard({ id: "b0", name: "Bot 0" }, [hostile]), showCard(roster(1), undefined, { b0: toCardThread([hostile]) })]) {
      const html = htmlOf(card);
      expect(scripts(html)).toHaveLength(1);
      expect(() => new Function(scripts(html)[0])).not.toThrow();
      expect(JSON.stringify(demo(html))).toContain("__VOICEOS_DEMO__");
    }
  });
});

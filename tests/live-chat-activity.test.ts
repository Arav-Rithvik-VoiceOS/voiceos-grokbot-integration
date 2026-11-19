// VOS-1672: the chat's working row (the bot's face and "Finding today's date" /
// "Typing…" under the last message) and Grok Bot style timestamps.
import { afterAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Window } from "happy-dom";

const win = new Window();
const saved = new Map<string, PropertyDescriptor | undefined>();
for (const key of ["window", "document", "location", "localStorage", "requestAnimationFrame", "parent", "addEventListener"] as const) {
  saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  const value = key === "window" ? win : key === "parent" ? win : key === "addEventListener" ? win.addEventListener.bind(win)
    : key === "requestAnimationFrame" ? (f: () => void) => setTimeout(f, 0) : (win as any)[key];
  Object.defineProperty(globalThis, key, { configurable: true, value });
}
afterAll(() => {
  for (const [key, d] of saved) d ? Object.defineProperty(globalThis, key, d) : Reflect.deleteProperty(globalThis, key);
  win.happyDOM.abort();
});
const LiveChat = new Function(readFileSync(join(import.meta.dir, "../widgets/live-chat.js"), "utf8") + ";return LiveChat")();

let snapshot: any = { bots: [], groups: [], thread: [] };
function mountChat(target: Record<string, unknown> = { id: "scout" }, items: any[] = []) {
  const list = win.document.createElement("div");
  win.document.body.append(list);
  const seenTimes: (string | undefined)[] = [];
  const bridge = { canInvoke: true, count: 0, refreshes: 0, onReady: () => () => {}, call: async () => JSON.parse(JSON.stringify(snapshot)) };
  const chat = LiveChat.mount({
    bridge, list: list as any, target, items,
    renderItem: (m: any) => { seenTimes.push(m.t); return '<div class="bubble">' + m.text + "</div>"; },
    renderActivity: (s: string, t: string) => '<span class="lc-act-t">' + (t || s) + "</span>",
    updateActivity: (row: any, s: string, t: string) => { row.querySelector(".lc-act-t").textContent = t || s; },
  });
  const row = () => list.querySelector(".lc-act");
  return { chat, list, row, seenTimes };
}

test("a working bot shows its face and what it is doing under the last message", async () => {
  const { chat, list, row } = mountChat();
  snapshot = { bots: [{ id: "scout", status: "working", activity: "Finding today's date" }], groups: [], thread: [{ id: "m1", from: "me", text: "what is the day", timestampMs: Date.now() }] };
  await chat.refresh();
  expect(row()?.textContent).toBe("Finding today's date");
  expect(list.lastElementChild).toBe(row());
  // Composing the reply: "Typing…" on the same row (no second face).
  snapshot.bots = [{ id: "scout", status: "thinking" }];
  await chat.refresh();
  expect(list.querySelectorAll(".lc-act")).toHaveLength(1);
  expect(row()?.textContent).toBe("typing");
  // The reply lands and the bot is idle: the row fades out, then leaves.
  snapshot.bots = [{ id: "scout", status: "idle" }];
  snapshot.thread.push({ id: "m2", from: "bot", text: "Saturday", timestampMs: Date.now() });
  await chat.refresh();
  expect(row()?.classList.contains("lc-act-out")).toBe(true);
  await Bun.sleep(320);
  expect(row()).toBeNull();
  chat.destroy();
});

test("a send shows the row at once, and it waits for the reply even before Grok Bot reports work", async () => {
  const { chat, row } = mountChat();
  snapshot = { bots: [{ id: "scout", status: "idle" }], groups: [], thread: [] };
  chat.addLocal("hello");
  expect(row()?.textContent).toBe("working");
  await chat.refresh();
  expect(row()?.classList.contains("lc-act-out")).toBe(false);
  snapshot.thread = [{ id: "r1", from: "bot", text: "hi", timestampMs: Date.now() + 1000 }];
  await chat.refresh();
  expect(row()?.classList.contains("lc-act-out")).toBe(true);
  chat.destroy();
});

test("group chats never show a working row", async () => {
  const { chat, row } = mountChat({ id: "room", isGroup: true });
  snapshot = { bots: [{ id: "room", status: "working" }], groups: [], thread: [] };
  chat.addLocal("hello all");
  await chat.refresh();
  expect(row()).toBeNull();
  chat.destroy();
});

test("times show only at the start, after a 15-minute gap, or on a new day", async () => {
  const at = (min: number) => Date.now() - min * 60_000;
  const { chat, seenTimes } = mountChat({ id: "scout" }, [
    { id: "a", from: "bot", text: "a", timestampMs: at(300) },
    { id: "b", from: "me", text: "b", timestampMs: at(299) },
    { id: "c", from: "bot", text: "c", timestampMs: at(5) },
    { id: "d", from: "me", text: "d", timestampMs: at(4) },
  ]);
  const shown = seenTimes.slice(-4);
  expect(shown[1]).toBeUndefined();
  expect(shown[3]).toBeUndefined();
  for (const t of [shown[0], shown[2]]) expect(t).toMatch(/^(Today|Yesterday) \d{1,2}:\d{2}/);
  expect(seenTimes.some((t) => t === "now" || /^\d+m$/.test(String(t)))).toBe(false);
  chat.destroy();
});

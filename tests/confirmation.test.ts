import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { pinnedConfirmationAdapter, renderCard } from "../cards.ts";

const source = readFileSync(new URL("../widgets/confirmation-adapter.js", import.meta.url), "utf8");
function payload(data: any, args: any) {
  return runInNewContext(source + "\nconfirmationPayload(data, args)", {
    boot() {}, stage() {}, wireComposer() {}, addEventListener() {}, data, args,
  });
}
const old = { tool: "grokbot_send", bots: [{ id: "p", name: "Pepper" }], groups: [], threads: {} };
test("unknown confirmation recipients produce an error, never a fabricated bot", () => {
  const r = payload(old, { bot: "James" });
  expect(r.error).toBeTruthy();
  expect(r.data.bots).toEqual(old.bots);
});
test("confirmation uses the live lookup roster even when the frozen roster is old", () => {
  const r = payload(old, { bot: "j", confirmationContext: JSON.stringify({ bots: [{ id: "j", name: "James" }], groups: [], threads: {} }) });
  expect(r.error).toBeUndefined();
  expect(r.args.bot).toBe("j");
  expect(r.data.bots).toEqual([{ id: "j", name: "James" }]);
});
test("unknown groups and members cannot turn into a new group draft", () => {
  for (const args of [{ group: "James" }, { members: ["p", "James"] }]) {
    expect(payload({ ...old, tool: "grokbot_group" }, args).error).toBeTruthy();
  }
});
test("malformed live data and partial names fail closed", () => {
  for (const args of [{ bot: "Pep" }, { bot: "p", confirmationContext: "oops" }, { bot: "p", confirmationContext: '{"bots":[null],"groups":[]}' }]) {
    expect(payload(old, args).error).toBeTruthy();
  }
});
test("unknown recipient initialization renders an error instead of booting a thread", () => {
  let listener: any;
  let boots = 0;
  let children: any[] = [];
  const edits: any[] = [];
  const parent = { postMessage: (m: any) => edits.push(m) };
  runInNewContext(source, {
    boot() { boots++; }, stage() {}, wireComposer() {}, DEMO: { data: old },
    addEventListener(_name: string, fn: any) { listener = fn; }, parent, report() {},
    document: { documentElement: { classList: { add() {} } },
      createElement() { return { setAttribute() {}, style: {} }; },
      body: { replaceChildren(...nodes: any[]) { children = nodes; } } },
  });
  listener({ source: parent, data: { type: "voiceos:init", args: { bot: "James", message: "Hello" } }, stopImmediatePropagation() {} });
  expect(boots).toBe(0);
  expect(children[0].textContent).toContain("could not be found");
  expect(edits).toEqual([{ type: "voiceos:updateInput", key: "message", value: "" }]);
});

// A fast intent approves the bot NAME its enum offered; the host re-validates
// the edited args against that enum, so the card must not stage an ID over it.
function bootPinned(tool: string, args: any) {
  let listener: any;
  const edits: any[] = [];
  const parent = { postMessage: (m: any) => edits.push(m) };
  runInNewContext(pinnedConfirmationAdapter(source), {
    boot() {}, stage() {}, wireComposer() {}, report() {}, parent, inited: false,
    DEMO: { data: { tool, bots: [], groups: [], threads: {} } },
    addEventListener(_name: string, fn: any) { listener = fn; },
    document: { documentElement: { classList: { add() {} } }, querySelector() { return null; } },
  });
  listener({ source: parent, data: { type: "voiceos:init", args }, stopImmediatePropagation() {} });
  return edits;
}
const live = JSON.stringify({ bots: [{ id: "p", name: "Pepper" }], groups: [{ id: "g", name: "Crew", members: ["p"] }], threads: {} });
test("a send confirmation keeps staging the recipient name the intent approved", () => {
  expect(bootPinned("grokbot_send", { bot: "Pepper", message: "Hi", confirmationContext: live }))
    .toEqual([{ type: "voiceos:updateInput", key: "bot", value: "Pepper" }]);
});
test("group confirmations still stage resolved IDs", () => {
  expect(bootPinned("grokbot_group", { group: "Crew", message: "Hi", confirmationContext: live }))
    .toEqual([
      { type: "voiceos:updateInput", key: "group", value: "g" },
      { type: "voiceos:updateInput", key: "members", value: "p" },
      { type: "voiceos:updateInput", key: "groupName", value: "Crew" },
    ]);
});
test("the recipient pin is applied to the rendered confirmation, and a moved anchor fails the build", () => {
  const html = renderCard("thread", { data: { confirmation: true, tool: "grokbot_send", bots: [], groups: [], threads: {} } });
  expect(html).toContain("let confirmationBotRef;");
  expect(html).toContain("if (key === 'bot' && typeof confirmationBotRef === 'string') value = confirmationBotRef;");
  expect(html).toContain("if (DEMO.data.tool === 'grokbot_send') confirmationBotRef = event.data.args?.bot;");
  expect(() => pinnedConfirmationAdapter(source.replace("confirmationBooted = true;", "confirmationBooted=true;"))).toThrow("anchors");
  expect(() => pinnedConfirmationAdapter(source.replace("stage = function(key, value) {", "stage = (key, value) => {"))).toThrow("anchors");
});
test("the manifest's frozen confirmations are what cards.ts renders today (run `bun run freeze-confirms`)", async () => {
  // VoiceOS reads confirmation cards from the manifest, never from the server.
  const manifest = await Bun.file(new URL("../voiceos.integration.json", import.meta.url)).json();
  for (const tool of ["grokbot_send", "grokbot_group"]) {
    const frozen = manifest.tools.find((t: any) => t.name === tool).confirmation.root.html;
    expect(frozen).toBe(renderCard("thread", { data: { confirmation: true, tool, bots: [], groups: [], threads: {}, me: "" }, args: {} }));
  }
});

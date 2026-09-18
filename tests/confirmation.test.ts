import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

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

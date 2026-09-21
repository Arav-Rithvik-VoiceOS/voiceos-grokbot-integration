/** Exercise the shipped manifest, including bots absent from its frozen roster. */
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { toBot, renderCard } from "../cards.ts";
import { avatarShapes } from "../avatarShapes.generated.ts";
import manifest from "../voiceos.integration.json";
import { IntentRoster } from "../intents.ts";

const terry = toBot({
  id: "c21ab4dd-fde0-46bc-95ff-90c164cef98f",
  name: "Terry",
});
const bots = [terry, ...Object.keys(avatarShapes).map(shape => toBot({
  id: shape, name: shape, avatarShape: shape, avatarColor: "yellow",
}))];
const group = { id: "group", name: "Avatar group", members: bots.map(b => b.id) };
const roster = new IntentRoster(async () => bots.map(b => ({
  id: b.id, name: b.name, avatarColor: b.color, avatarShape: b.shape,
})));
await roster.refresh();
const pages = new Map<string, string>();
for (const route of ["grokbot_send", "grokbot_group", "grokbot_send-fast"]) {
  const name = route.replace("-fast", "");
  const tool = manifest.tools.find(t => t.name === name)!;
  const html = tool.confirmation!.root.html!;
  // A source-only renderer fix is insufficient: the frozen manifest must match.
  assert.equal(html, renderCard("thread", JSON.parse(html.match(/^const DEMO=(.*);$/m)![1])));
  assert.ok(html.length <= 131072);
  let args: Record<string, unknown> = {
    ...(name === "grokbot_send" ? { bot: "Terry" } : { group: group.id }),
    message: "Please review this draft.",
    confirmationContext: JSON.stringify({
      bots, groups: [group],
      threads: { [terry.id]: [{ from: "bot", text: "Ready when you are." }] },
    }),
  };
  if (route.endsWith("-fast")) {
    args = roster.beforeTool({ hookApiVersion: 1, event: "preToolUse", toolName: name,
      args: { bot: "Terry", message: "Please review this draft." },
    }).updatedArgs!;
    assert.equal(args.recipientId, terry.id);
  }
  pages.set(`/${route}`, `${html}<style>html{background:#18191a}</style><script>
window.calls=[];window.errors=[];
addEventListener('error',event=>errors.push(event.message));
addEventListener('message',event=>calls.push(event.data));
addEventListener('load',()=>window.postMessage({type:'voiceos:init',args:${JSON.stringify(args).replace(/</g, "\\u003c")},theme:{mode:'dark'}},'*'));
</script>`);
}
const server = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  fetch: request => new Response(pages.get(new URL(request.url).pathname) ?? "Not found", {
    headers: { "Content-Type": "text/html" },
  }),
});
const session = `grok-confirmations-${Date.now()}`;
const dir = process.env.CONFIRMATION_CHECK_WORK_DIR ?? "/tmp/grok-confirmations";
await mkdir(dir, { recursive: true });
async function browser(...args: string[]) {
  const child = Bun.spawn(["agent-browser", "--session", session, "--json", ...args], {
    stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  if (code) throw Error(stderr || stdout);
  const response = JSON.parse(stdout);
  if (!response.success) throw Error(JSON.stringify(response));
  return response.data;
}
async function ui(code: string) { return (await browser("eval", code)).result; }
try {
  await browser("open", `http://127.0.0.1:${server.port}/grokbot_send`);
  await browser("set", "viewport", "430", "410");
  await browser("snapshot", "-i");
  const direct = await ui(`(()=>{const a=document.querySelector('#hd .av'),p=a.querySelector('path');return {
    name:document.querySelector('#hd .t2').textContent,
    fill:p?.getAttribute('fill'),path:p?.getAttribute('d'),background:getComputedStyle(a).backgroundColor,
    legacyEyes:a.querySelectorAll('.eyes').length,draft:document.querySelector('#msg').value,
    stagedBot:calls.find(c=>c.type==='voiceos:updateInput'&&c.key==='bot')?.value,
    sendHidden:document.querySelector('.send').hidden,errors
  };})()`);
  assert.deepEqual(direct, {
    name: "Terry", fill: "#E02A88", path: avatarShapes.pebble.path,
    background: "rgba(0, 0, 0, 0)", legacyEyes: 0,
    draft: "Please review this draft.", stagedBot: "Terry", sendHidden: true, errors: [],
  });
  await browser("screenshot", join(dir, "terry.png"));
  await browser("fill", "#msg", "Edited draft");
  await browser("press", "Enter");
  assert.equal(await ui("document.querySelector('#msg').value"), "Edited draft");
  assert.equal(await ui("calls.filter(c=>c.type==='voiceos:updateInput'&&c.key==='message').at(-1)?.value"), "Edited draft");
  assert.equal(await ui("calls.some(c=>c.type==='voiceos:invokeTool')"), false);

  await browser("open", `http://127.0.0.1:${server.port}/grokbot_send-fast`);
  await browser("snapshot", "-i");
  assert.equal(await ui("document.querySelector('#hd .t2').textContent"), "Terry");
  assert.equal(await ui("document.querySelector('#hd path').getAttribute('d')"), avatarShapes.pebble.path);
  assert.equal(await ui("calls.find(c=>c.type==='voiceos:updateInput'&&c.key==='bot').value"), "Terry");
  assert.equal(await ui("document.querySelector('#msg').value"), "Please review this draft.");
  assert.equal(await ui("calls.some(c=>c.type==='voiceos:invokeTool')"), false);
  assert.deepEqual(await ui("errors"), []);
  await browser("screenshot", join(dir, "fast-send.png"));

  await browser("open", `http://127.0.0.1:${server.port}/grokbot_group`);
  await browser("snapshot", "-i");
  await browser("click", "#stack");
  await browser("snapshot", "-i");
  const shapes = await ui("[...document.querySelectorAll('#mlist .mrow')].map(row=>({name:row.querySelector('.t2').textContent,path:row.querySelector('path')?.getAttribute('d'),background:getComputedStyle(row.querySelector('.av')).backgroundColor}))");
  assert.equal(shapes.length, bots.length);
  for (const bot of bots) assert.deepEqual(shapes.find((s: { name: string }) => s.name === bot.name), {
    name: bot.name, path: avatarShapes[bot.shape as keyof typeof avatarShapes].path,
    background: "rgba(0, 0, 0, 0)",
  });
  assert.equal(await ui("calls.some(c=>c.type==='voiceos:invokeTool')"), false);
  assert.deepEqual(await ui("errors"), []);
  await browser("screenshot", join(dir, "group-members.png"));
  console.log(JSON.stringify({ ok: true, nativeShapes: Object.keys(avatarShapes).length, screenshots: dir }));
} finally {
  await browser("close");
  server.stop(true);
}

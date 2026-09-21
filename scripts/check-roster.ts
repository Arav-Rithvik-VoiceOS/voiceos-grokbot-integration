/** Browser regression for native avatars, group navigation, and live roster markers. */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { showCard, toBot, toGroup } from "../cards.ts";
import type { Agent } from "../client.ts";

const bots: Agent[] = [
  { id: "c21ab4dd-fde0-46bc-95ff-90c164cef98f", name: "Terry" },
  { id: "sol", name: "Sol", avatarColor: "black", avatarShape: "cloud" },
  {
    id: "picasso",
    name: "Picasso",
    avatarColor: "yellow",
    avatarShape: "teardrop",
  },
  {
    id: "seo",
    name: "SEO Master",
    avatarColor: "green",
    avatarShape: "hex",
    isRunning: true,
    awaitingUserResponse: null,
    hasUnread: true,
  },
];
const group: Agent = {
  id: "group",
  name: "Blog Generation",
  isGroup: true,
  memberIds: ["picasso", "seo"],
};
const cases = Object.fromEntries(
  ["working", "waiting", "idle"].map((state) => [
    state,
    {
      bots: bots.map((b) =>
        toBot(
          b.id === "seo"
            ? {
                ...b,
                isRunning: state === "working",
                hasUnread: state === "working",
                awaitingUserResponse:
                  state === "waiting" ? { kind: "widget" } : null,
              }
            : b,
        ),
      ),
      groups: [toGroup(group)],
    },
  ]),
);
const fixture = `<script>
window.rosterCase='working';window.calls=[];
const cases=${JSON.stringify(cases).replace(/</g, "\\u003c")};
addEventListener('message',event=>{const m=event.data;if(m?.type!=='voiceos:invokeTool')return;calls.push(m);
 let result={ok:true,attachments:[]};
 if(m.name==='grokbot_card_snapshot')result={ok:true,...cases[window.rosterCase],thread:m.args.bot==='group'?[{id:'g1',from:'bot',sender:'Picasso',text:'Group conversation is ready.'},{id:'g2',from:'bot',sys:'Messaged',bot:'seo',sender:'SEO Master'}]:[]};
 window.postMessage({type:'voiceos:toolResult',requestId:m.requestId,status:'completed',result},'*');
});
addEventListener('load',()=>window.postMessage({type:'voiceos:init',capabilities:{invokeTool:true}},'*'));
</script>`;
const html = showCard([...bots, group])._voiceos_glance.blocks[0].html.replace(
  '<script type="application/json"',
  `${fixture}<script type="application/json"`,
);
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: () => new Response(html, { headers: { "Content-Type": "text/html" } }),
});
const session = `grok-roster-${Date.now()}`;
const dir =
  process.env.ROSTER_CHECK_WORK_DIR ??
  (await mkdtemp(join(tmpdir(), "grok-roster-check-")));
await mkdir(dir, { recursive: true });
async function browser(...args: string[]) {
  const child = Bun.spawn(
    ["agent-browser", "--session", session, "--json", ...args],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code) throw Error(stderr || stdout);
  const response = JSON.parse(stdout);
  if (!response.success) throw Error(JSON.stringify(response));
  return response.data;
}
async function ui(code: string) {
  return (await browser("eval", code)).result;
}
async function waitFor(expression: string) {
  for (let i = 0; i < 40; i++) {
    if (await ui(expression)) return;
    await Bun.sleep(100);
  }
  throw Error(`UI did not settle: ${expression}`);
}
try {
  await browser("open", `http://127.0.0.1:${server.port}`);
  await browser("set", "viewport", "430", "410");
  await browser("snapshot", "-i");
  await waitFor(
    "window.calls.some(c=>c.name==='grokbot_card_snapshot'&&!c.args.bot)",
  );
  const initial = await ui(`(()=>{
    const row=id=>document.querySelector('[data-bot="'+id+'"]');
    return {rows:document.querySelectorAll('.bot-row').length,terry:row('${bots[0].id}').querySelector('path').getAttribute('fill'),sol:row('sol').querySelector('path').getAttribute('fill'),groupIcons:row('group').querySelectorAll('.group-avatar>.avatar').length,working:row('seo').querySelectorAll('.working-dot').length,unread:row('seo').querySelectorAll('.status-marker.unread').length,idleMarkers:row('sol').querySelectorAll('.working-dot,.status-marker').length};
  })()`);
  assert.deepEqual(initial, {
    rows: 5,
    terry: "#E02A88",
    sol: "#FFFFFF",
    groupIcons: 2,
    working: 1,
    unread: 1,
    idleMarkers: 0,
  });
  await browser("screenshot", join(dir, "roster.png"));

  await ui(
    "window.rosterCase='waiting';document.dispatchEvent(new Event('visibilitychange'))",
  );
  await waitFor(
    "!!document.querySelector('[data-bot=seo] .status-marker.attention')",
  );
  assert.equal(
    await ui(
      "document.querySelectorAll('[data-bot=seo] .working-dot,[data-bot=seo] .status-marker.unread').length",
    ),
    0,
  );
  await ui(
    "window.rosterCase='idle';document.dispatchEvent(new Event('visibilitychange'))",
  );
  await waitFor("!document.querySelector('[data-bot=seo] .status-marker')");

  // Open the native viewer from the live conversation and preserve its draft.
  await browser("click", '[data-bot="seo"]');
  await browser("snapshot", "-i");
  await waitFor("!!document.querySelector('[data-computer]')");
  await browser("fill", "#message", "Keep my bot draft");
  await browser("click", '[data-computer]');
  await waitFor("window.calls.some(c=>c.name==='grokbot_open_computer_window'&&c.args.bot==='seo')");
  assert.equal(await ui("document.querySelector('#message').value"), "Keep my bot draft");
  await browser("screenshot", join(dir, "computer-button.png"));
  await browser("click", '[data-back]');
  await browser("snapshot", "-i");
  await browser("click", '[data-bot="group"]');
  await browser("snapshot", "-i");
  await waitFor(
    "document.querySelector('.messages').textContent.includes('Group conversation is ready.')",
  );
  assert.equal(
    await ui("document.querySelector('.header .name').textContent"),
    "Blog Generation",
  );
  assert.equal(
    await ui(
      "document.querySelectorAll('.header .group-avatar>.avatar').length",
    ),
    2,
  );
  await ui(
    "document.querySelector('#message').value='Keep my group draft';document.querySelector('#message').dispatchEvent(new Event('input'))",
  );
  await ui("document.dispatchEvent(new Event('visibilitychange'))");
  assert.equal(
    await ui("document.querySelector('#message').value"),
    "Keep my group draft",
  );
  assert.equal(await ui("!!document.querySelector('[data-computer]')"), false);
  const centerOffset = await ui(
    "(()=>{const row=document.querySelector('.system'),range=document.createRange();range.selectNodeContents(row);const a=range.getBoundingClientRect(),b=row.getBoundingClientRect();return Math.abs((a.left+a.right-b.left-b.right)/2);})()",
  );
  assert.ok(
    centerOffset < 1,
    `Inter-bot receipt is off center by ${centerOffset}px`,
  );
  await browser("screenshot", join(dir, "group.png"));
  await browser("set", "viewport", "320", "270");
  assert.equal(
    await ui(
      "document.documentElement.scrollWidth<=innerWidth&&document.documentElement.scrollHeight<=innerHeight&&document.querySelector('.composer').getBoundingClientRect().bottom<=innerHeight",
    ),
    true,
  );
  await browser("click", "[data-back]");
  await browser("snapshot", "-i");
  await waitFor("!document.querySelector('.list').hidden");
  await browser("scrollintoview", '[data-bot="group"]');
  await browser("snapshot", "-i");
  await browser("click", '[data-bot="group"]');
  await waitFor(
    "document.querySelector('.list').hidden && document.querySelector('.header .name')?.textContent==='Blog Generation'",
  );
  assert.equal(
    await ui("document.querySelector('#message').value"),
    "Keep my group draft",
  );
  assert.equal(
    await ui("window.calls.some(c=>/send|action|teach/.test(c.name))"),
    false,
  );
  console.log(
    JSON.stringify({ ok: true, initial, centerOffset, screenshots: dir }),
  );
} catch (error) {
  console.error(
    await ui(
      "({header:document.querySelector('.header').textContent,listHidden:document.querySelector('.list').hidden,draft:document.querySelector('#message').value,calls:window.calls.map(c=>({name:c.name,args:c.args}))})",
    ),
  );
  await browser("screenshot", join(dir, "failure.png"));
  throw error;
} finally {
  await browser("close");
  server.stop(true);
  if (!process.env.ROSTER_CHECK_WORK_DIR)
    await rm(dir, { recursive: true, force: true });
}

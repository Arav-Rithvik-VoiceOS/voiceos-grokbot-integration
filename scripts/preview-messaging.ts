/** Local sandbox harness. Simulates host results; never calls Grok Bot. */
import { renderCard, toBot, toThread, threadCard, groupComposeCard, groupThreadCard, sentCard, sentGroupCard } from "../cards.ts";
import type { Agent, TranscriptEntry } from "../client.ts";
const bots: Agent[] = [
  { id: "pepper", name: "Pepper", title: "EA", avatarColor: "orange", isRunning: true },
  { id: "friday", name: "Friday", title: "School", avatarColor: "green", avatarShape: "hex" },
  { id: "jerome", name: "Jerome", title: "BISV Hacks", avatarColor: "red" },
  { id: "titus", name: "Titus", title: "Research", avatarColor: "blue", avatarShape: "tablet" },
];
const history: TranscriptEntry[] = [
  { kind: "message", role: "user", content: "What should we work on first?" },
  { kind: "message", role: "assistant", content: "Start with **CSA 1.7**, then check the remaining deadlines.", fromAgent: { id: "pepper" } },
];
const group = { id: "g1", name: "Homework crew", members: ["pepper", "friday"] };
const many = [...bots, ...Array.from({ length: 30 }, (_, i) => ({ id: `extra-${i}`, name: `Extra bot ${i} with a very long name`, title: "Research", avatarColor: "blue" }))];
const cardHtml = (card: ReturnType<typeof threadCard>) => card._voiceos_glance.blocks[0].html;
const escape = (s: string) => JSON.stringify(s).replace(/</g, '\\u003c');
const manifest = await Bun.file(new URL('../voiceos.integration.json', import.meta.url)).json();
const sendConfirmation = manifest.tools.find((t: any) => t.name === 'grokbot_send').confirmation.root;
const frozenBots = JSON.parse(sendConfirmation.html.match(/const DEMO=(.*);/)[1]).data.bots;
function confirmationPreview(mode: string) {
  const isGroup = mode !== 'direct';
  const tool = isGroup ? 'grokbot_group' : 'grokbot_send';
  const args = !isGroup ? {bot:'Pepper',message:'Reply pong.'}
    : mode === 'group' ? {group:group.name,message:'Review our work.'}
    : {members:['Jerome','Titus'],groupName:'',message:'Split the research.'};
  const html = !isGroup ? sendConfirmation.html : renderCard('thread', {data:{confirmation:true,tool,
    bots:many.map(toBot),groups:[group],threads:{g1:toThread(history)}}});
  return `<!doctype html><meta charset="utf-8"><title>Manifest confirmation QA</title>
<style>body{font:14px system-ui;background:#252529;color:#eee;padding:24px}a{color:#b6ccff;margin-right:14px}.card{width:400px;background:#0c0c0d;border-radius:26px;overflow:hidden;margin:20px 0}iframe{display:block;width:100%;height:360px;border:0}.overlay{position:sticky;bottom:0;height:0;z-index:3;display:flex;justify-content:flex-end;pointer-events:none}.anchor{transform:translateY(-40px);margin-right:12px;pointer-events:auto}#approve{height:30px;padding:0 18px;font-size:13px;font-weight:600;letter-spacing:.01em;color:rgba(255,255,255,.96);background:rgba(17,18,21,.85);border:1px solid rgba(255,255,255,.22);border-radius:999px;box-shadow:0 3px 12px rgba(0,0,0,.32);cursor:pointer}pre{white-space:pre-wrap}</style>
<nav><a href="/confirm?mode=direct">Manifest direct</a><a href="/confirm?mode=group">Existing group fixture</a><a href="/confirm?mode=new">New group fixture</a></nav>
<p>Confirmation host simulation. Direct HTML comes from the generated manifest. No real sends.</p>
<div class="card"><iframe title="Thread confirmation" sandbox="allow-scripts"></iframe><div class="overlay"><div class="anchor"><button id="approve" aria-label="Send">↑</button></div></div></div><pre id="events"></pre>
<script>
const frame=document.querySelector('iframe'),events=document.querySelector('#events'),args=${JSON.stringify(args)},edits={};
let sent=false;
const init=()=>frame.contentWindow.postMessage({type:'voiceos:init',args,data:{},theme:{mode:'dark'}},'*');
frame.onload=init;
addEventListener('message',e=>{if(e.source!==frame.contentWindow)return;const m=e.data;
if(m.type==='voiceos:resize')frame.style.height=Math.min(420,Math.max(60,m.height))+'px';
if(m.type==='voiceos:updateInput'&&typeof m.value==='string'){edits[m.key]=m.value;events.textContent=JSON.stringify({args,edits},null,2);}
});
document.querySelector('#approve').onclick=async()=>{if(sent)return;sent=true;
const finalArgs={...args,...edits};if(typeof finalArgs.members==='string')finalArgs.members=finalArgs.members.split(',').filter(Boolean);
events.textContent=JSON.stringify({name:${JSON.stringify(tool)},args:finalArgs},null,2);
const result=await fetch('/receipt',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:${JSON.stringify(tool)},args:finalArgs})}).then(r=>r.json());
document.querySelector('.overlay').remove();frame.onload=null;frame.srcdoc=result.receipt.html;
};
frame.srcdoc=${escape(html)};
</script>`;
}
const server = Bun.serve({ hostname: "127.0.0.1", port: 4175, async fetch(req) {
  const url = new URL(req.url);
  if(url.pathname === '/confirm') return new Response(confirmationPreview(url.searchParams.get('mode') || 'direct'), {headers:{'Content-Type':'text/html'}});
  if (url.pathname === "/receipt" && req.method === "POST") {
    const { name, args } = await req.json();
    const card = name === "grokbot_group"
      ? sentGroupCard(many, { id: args.group || "new-group", name: args.groupName || "New group", members: args.members }, args.message)
      : sentCard(bots.find(b => b.id === args.bot) || frozenBots.find((b: any) => b.id === args.bot || b.name === args.bot), args.message);
    return Response.json({ sent: true, receipt: card._voiceos_glance.blocks[0] });
  }
  const mode = url.searchParams.get("mode") || "direct";
  const card = mode === "new" ? groupComposeCard(bots, ["jerome", "titus"], "", "Split the research and check in by 9.")
    : mode === "stress" ? groupThreadCard(many, { ...group, name: "A very long group name that must fit inside the frame", members: many.slice(0, 8).map(b => b.id) }, Array.from({length: 24}, () => history).flat(), "A long draft")
    : mode === "group" ? groupThreadCard(bots, group, history, "Both of you: CSA first, then Zinn.")
    : threadCard(bots[0], history, "CSA 1.7 first, then Zinn. Ping me when submitted.");
  const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:;">`;
  const html = cardHtml(card).replace('<meta charset="utf-8" />', '<meta charset="utf-8" />' + csp);
  return new Response(`<!doctype html><meta charset="utf-8"><title>Messaging card QA</title>
<style>body{font:14px system-ui;background:#252529;color:#eee;padding:24px}a{color:#b6ccff;margin-right:14px}iframe{display:block;width:400px;height:420px;background:#0c0c0d;border:0;border-radius:26px;margin:22px 0}pre{white-space:pre-wrap;max-width:650px}label{margin-right:18px}</style>
<nav><a href="/?mode=direct">1F Direct</a><a href="/?mode=group">1G Existing group</a><a href="/?mode=new">1J New group</a><a href="/?mode=stress">Long lists</a></nav>
<p>Local simulation — no messages leave this preview.</p>
<label><input type="checkbox" id="fail">Simulate failed send</label><label><input type="checkbox" id="light">Light theme</label><label><input type="checkbox" id="unavailable">Disable host sending</label>
<iframe title="Messaging card" sandbox="allow-scripts"></iframe><pre id="events">No sends yet.</pre>
<script>
const frame=document.querySelector('iframe'),events=document.querySelector('#events');
const init=()=>frame.contentWindow.postMessage({type:'voiceos:init',data:{},capabilities:{invokeTool:!document.querySelector('#unavailable').checked},theme:{mode:document.querySelector('#light').checked?'light':'dark'}},'*');
frame.addEventListener('load',init);document.querySelector('#light').onchange=()=>{frame.style.background=document.querySelector('#light').checked?'#f4f4f6':'#0c0c0d';init()};document.querySelector('#unavailable').onchange=init;
addEventListener('message',async e=>{if(e.source!==frame.contentWindow)return;const m=e.data;
if(m.type==='voiceos:resize'){frame.style.height=Math.min(420,Math.max(60,m.height))+'px';return;}
if(m.type!=='voiceos:invokeTool')return;
events.textContent=JSON.stringify(m,null,2);
if(document.querySelector('#fail').checked){frame.contentWindow.postMessage({type:'voiceos:toolResult',requestId:m.requestId,status:'failed',error:'Simulated failure'},'*');return;}
const body=await fetch('/receipt',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(m)}).then(r=>r.json());
frame.contentWindow.postMessage({type:'voiceos:toolResult',requestId:m.requestId,status:'completed',result:{content:[{type:'text',text:JSON.stringify(body)}]}},'*');});
frame.srcdoc=${escape(html)};
</script>`, { headers: { "Content-Type": "text/html" } });
} });
console.log(`Messaging preview: ${server.url}`);

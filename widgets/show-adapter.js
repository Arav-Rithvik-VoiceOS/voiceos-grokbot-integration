/* Show-card glue: the chat pane (openChat) gets the live conversation, the + menu (1:1) and
   Open computer. Runs in its own IIFE after show.html's script, whose top-level functions
   (openChat, wireComposer, swapTo, render, …) it wraps by reassignment. */
const lcBridge=LiveChat.bridge({canInvoke:CAN_INVOKE}),lcDrafts=new Map();
let lcPane=null,lcGroup=null;
// show.html's own init listener runs first and sets CAN_INVOKE; mirror it (tools become ready on a later init).
addEventListener('message',e=>{const m=e.data;if(e.source===parent&&m&&m.type==='voiceos:init')lcBridge.canInvoke=CAN_INVOKE});
// Group rows open the pane with only a name; remember which row it was.
document.addEventListener('click',e=>{const r=e.target.closest&&e.target.closest('.row[data-group]');if(r)lcGroup=r.dataset.group},true);

// The host often sends {} as init data; fall back to the baked roster (as the thread adapter does).
const lcBoot=boot;
boot=function(data,args,mode){lcBoot(data&&Array.isArray(data.bots)?data:DEMO.data,args,mode)};
const lcOpen=openChat;
openChat=function(b){lcClose();lcOpen(b);lcMount(b)};
// The host allows one pending action per card: the card's own send waits its turn behind the live chat's calls.
const lcInv=invoke;invoke=(n,a)=>lcBridge.queue(()=>lcInv(n,a));
// The receipt replaces this document on the same Window: stop timers and queued calls first, and tell it
// how much of the host's per-card request budget this card already spent.
const lcSwap=swapTo;
swapTo=function(receipt){lcClose();lcBridge.canInvoke=false;
 return lcSwap({...receipt,html:String(receipt.html).replace('<meta charset="utf-8" />',x=>x+'<meta name="voiceos-receipt-used" content="'+lcBridge.count+'">')})};
// Tag the optimistic send bubble: the live chat drops it once the conversation has the delivered copy.
const lcSB=sendBubble;
sendBubble=function(list,text){const h=lcSB(list,text),s=list.lastElementChild,b=s&&s.previousElementSibling,p=lcPane;
 if(b){b.dataset.lcMine=String(text).trim();b.dataset.lcAt=String(Date.now())}
 const then=f=>(...a)=>{f(...a);if(p&&lcPane===p)p.live.refresh()};
 return {...h,ok:then(h.ok),unknown:then(h.unknown)}};
// Same composer wiring as show.html, plus: staged files send through the + menu's job, and the draft map.
wireComposer=function(root,onSend){const f=$('#compose',root),i=$('#msg',f),b=$('.send',f);
 const go=()=>{const v=i.value.trim(),p=lcPane,k=p&&p.kit;
  if(k&&k.hasAttachments()){if(!k.busy())k.send(v);return}
  if(!v||(k&&k.busy()))return;i.value='';b.disabled=true;if(p)lcDrafts.delete(p.id);onSend(v)};
 i.addEventListener('input',()=>b.disabled=!i.value.trim());b.addEventListener('click',e=>{e.preventDefault();go()});
 i.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();go()}})};

function lcClose(){const p=lcPane;if(!p)return;lcPane=null;
 const i=$('#chat #msg');if(i)lcDrafts.set(p.id,i.value);
 // Reopening this conversation starts from what the pane already showed.
 D.threads=D.threads||{};D.threads[p.id]=p.live.items();D.nextBeforeSeqs=D.nextBeforeSeqs||{};D.nextBeforeSeqs[p.id]=p.live.nextBeforeSeq();
 p.live.destroy();if(p.kit)p.kit.destroy();if(p.off)p.off()}
function lcMount(b){const c=$('#chat'),list=$('#msgs',c),hd=$('.hd',c),form=$('#compose',c),groups=D.groups||[];
 const g=b.group&&(groups.find(x=>x.id===lcGroup&&x.name===b.name)||groups.find(x=>x.name===b.name)),id=b.group?g&&g.id:b.id;
 if(!id||!list||!hd||!form)return;
 const input=$('#msg',form),sb=$('.send',form);
 // One line for the live chat, one for the + menu: neither may clear or replace the other's message.
 const line=()=>{const st=document.createElement('div');st.className='sys lc-st';st.setAttribute('role','status');st.hidden=true;form.before(st);
  return (t,bad)=>{st.textContent=t||'';st.hidden=!t;st.classList.toggle('bad',!!bad);report()}};
 const say=line();
 const p=lcPane={id};
 const draft=lcDrafts.get(id);if(draft){input.value=draft;sb.disabled=!draft.trim()}
 input.addEventListener('input',()=>lcDrafts.set(id,input.value));
 if(b.group)$('.plus',form)?.remove();
 p.live=LiveChat.mount({bridge:lcBridge,list,header:hd,target:{id,name:b.name,isGroup:!!b.group},
  items:(D.threads&&D.threads[id])||[],nextBeforeSeq:D.nextBeforeSeqs&&D.nextBeforeSeqs[id],
  renderItem:m=>lcItem(m,id,!!b.group),onBots:(bots,gs)=>lcBots(bots,gs,p,!!b.group),statusLine:say});
 if(!b.group){
  p.kit=ComposerKit.mount({bridge:lcBridge,form,input,sendButton:sb,bot:{id,name:b.name},status:line(),
   onSent:()=>p.live.refresh(),openComputer:()=>p.live.openComputer()});
  // The + needs tools; it appears once the host says they are ready.
  const plus=()=>{const x=$('.plus',form);if(x)x.hidden=!lcBridge.canInvoke};plus();p.off=lcBridge.onReady(plus)}
 const back=$('#back',c),goBack=back.onclick;back.onclick=()=>{lcClose();if(goBack)goBack.call(back)};
 p.live.refresh()}
// show.html's own row markup (thread()), one item at a time. Notices have no bot, so no orb. In a group
// each bot's message is named, as in the group thread card (thread.html msgHtml).
function lcItem(m,id,g){if(typeof m.sys==='string'&&!m.bot)return m.sys?'<div class="sys">'+esc(m.sys)+'</div>':'';
 const bots=D.bots||[],who=m.sys&&!bots.some(x=>x.id===m.bot)?[{id:m.bot,name:m.sender||m.bot,color:'#888',shape:'blob'}]:[];
 const s=thread({bots:bots.concat(who),threads:{[id]:[m]}},id),i=s.indexOf('<div class="bubble');
 if(!g||typeof m.sys==='string'||m.from!=='bot'||!m.bot||i<0)return s;
 const sb=bots.find(x=>x.id===m.bot)||{name:m.sender||m.bot,color:'#888',shape:'blob'};
 return s.slice(0,i)+'<div class="from">'+av(sb,'tiny')+esc(sb.name)+'</div>'+s.slice(i)}
// A refresh's roster: the open bot's header status, and the roster pane behind it for the back button.
function lcBots(bots,groups,p,isGroup){let changed=false;
 if(bots.length&&JSON.stringify(bots)!==JSON.stringify(D.bots)){D.bots=bots;changed=true}
 if(JSON.stringify(groups)!==JSON.stringify(D.groups||[])){D.groups=groups;changed=true}
 if(!changed)return;render(D);
 if(isGroup||lcPane!==p)return;
 const bt=botById(D,p.id),hd=$('#chat .hd'),s=hd&&$('.st',hd),a=hd&&$('.av',hd);
 if(s)s.innerHTML='<span class="dot '+dotCls(bt)+'"></span>'+statusText(bt)+(bt.label?' · '+esc(bt.label):'');
 if(a&&a.dataset.state!==(bt.status||'idle'))Motion.set(a,bt.status||'idle')}

/* Show-card glue: the ONE Grok Bot conversation surface. The chat pane (openChat) gets the live
   conversation, the + menu (1:1), Open computer, the fly-into-the-orb send, and a new-group pane
   (pick bots, name it, first send creates it). Runs in its own IIFE after show.html's script, whose
   top-level functions (openChat, wireComposer, render, …) it wraps by reassignment.

   Voice opens this same card: args.open says which pane to start on — {bot}, {group}, or
   {members, groupName} for a new group — and args.message is the draft for that pane. */
const lcBridge=LiveChat.bridge({canInvoke:CAN_INVOKE}),lcDrafts=new Map();
let lcPane=null,lcGroup=null,gbNew=null;
const gbCalm=matchMedia('(prefers-reduced-motion: reduce)').matches;
// show.html's own init listener runs first and sets CAN_INVOKE; mirror it (tools become ready on a later init).
addEventListener('message',e=>{const m=e.data;if(e.source===parent&&m&&m.type==='voiceos:init')lcBridge.canInvoke=CAN_INVOKE});
// Group rows open the pane with only a name; remember which row it was.
document.addEventListener('click',e=>{const r=e.target.closest&&e.target.closest('.row[data-group]');if(r)lcGroup=r.dataset.group},true);

/* The card's own memory. VoiceOS rebuilds a result card from its FIRST html every time the notch
   closes and opens (a networked card on every hide), and keeps nothing the card did. Grok Bot's cards
   are networked, so each tool result has its own origin with working localStorage for the app's
   lifetime: the open pane, each conversation's draft and rows (with unsent sends) live there.
   A plain srcdoc card has no storage; every call below is then a no-op. */
const GB_KEY='gb-show';
const gbGet=()=>{try{return JSON.parse(localStorage.getItem(GB_KEY)||'null')||{}}catch(_){return {}}};
const gbPut=patch=>{try{localStorage.setItem(GB_KEY,JSON.stringify({...gbGet(),...patch}))}catch(_){}};
const gbSaveDrafts=()=>gbPut({drafts:Object.fromEntries(lcDrafts)});
const gbSaveThread=(id,items,before)=>{const s=gbGet();gbPut({threads:{...(s.threads||{}),[id]:items},befores:{...(s.befores||{}),[id]:before}})};
// A draft's key: the bot or group id, or 'new' for the new-group pane.
const gbKey=o=>o?o.bot||o.group||(o.members?'new':''):'';
// Sends still waiting for the host's answer in THIS document; any other 'sending' row is an orphan.
const gbFlying=new Set();

// The host often sends {} as init data and no args; fall back to the baked payload (as the thread adapter did).
const lcBoot=boot;
boot=function(data,args,mode){const d=data&&Array.isArray(data.bots)?data:DEMO.data,a=args&&Object.keys(args).length?args:(DEMO.args||{}),s=gbGet();
 // The card's last copy of each conversation is newer than the baked one.
 d.threads={...(d.threads||{}),...(s.threads||{})};d.nextBeforeSeqs={...(d.nextBeforeSeqs||{}),...(s.befores||{})};
 // Groups this card created after its html was baked.
 (s.madeGroups||[]).forEach(g=>{d.groups=d.groups||[];if(!d.groups.some(x=>x.id===g.id))d.groups.push(g)});
 Object.entries(s.drafts||{}).forEach(([k,v])=>lcDrafts.set(k,v));
 // The voice draft is used once: a reopened card must not put an already-sent message back in the box.
 const k=gbKey(a.open);if(!s.argsUsed&&k&&a.message&&!lcDrafts.has(k)){lcDrafts.set(k,String(a.message));gbSaveDrafts()}
 gbPut({argsUsed:true});
 lcBoot(d,a,mode);
 // Where the user left the card beats where voice opened it (null = they went back to the roster).
 const pane=s.pane!==undefined?s.pane:(a.open||null);if(pane)gbOpen(pane,true)};
function gbOpen(p,instant){const panes=$('#panes');if(instant)panes.classList.add('gb-instant');
 if(p.bot){const b=(D.bots||[]).find(x=>x.id===p.bot);if(b)openChat(b)}
 else if(p.group){const g=(D.groups||[]).find(x=>x.id===p.group);if(g){lcGroup=g.id;openChat(gbGroupRef(g))}}
 else if(p.members)gbOpenNew(p);
 if(instant)setTimeout(()=>panes.classList.remove('gb-instant'),60)}
const gbGroupRef=g=>({name:g.name,color:'#888',shape:'blob',status:'working',group:true,members:g.members||[]});

const lcOpen=openChat;
openChat=function(b){lcClose();gbNew=null;lcOpen(b);lcMount(b);if(lcPane)gbPut({pane:b.group?{group:lcPane.id}:{bot:b.id}})};
// The host allows one pending action per card: the card's own send waits its turn behind the live chat's calls.
const lcInv=invoke;invoke=(n,a)=>lcBridge.queue(()=>lcInv(n,a));
// Same composer wiring as show.html, plus: staged files send through the + menu's job, the saved draft,
// and the live send below (show.html's own send swapped the card for a receipt).
wireComposer=function(root,onSend){const f=$('#compose',root),i=$('#msg',f),b=$('.send',f);
 const go=()=>{const v=i.value.trim(),p=lcPane,k=p&&p.kit;
  if(k&&k.hasAttachments()){if(!k.busy())k.send(v);return}
  if(!v||(k&&k.busy()))return;
  if(gbNew&&gbNew.root===root)return gbNewSend(v);
  if(!p)return;
  if(!CAN_INVOKE){p.say('Sending is unavailable in this host. Your draft is still here.',true);return}
  i.value='';b.disabled=true;lcDrafts.delete(p.id);gbSaveDrafts();p.say('');gbSend(p,v)};
 i.addEventListener('input',()=>b.disabled=!i.value.trim());b.addEventListener('click',e=>{e.preventDefault();go()});
 i.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();go()}})};

function lcClose(){const p=lcPane;if(!p)return;lcPane=null;
 const i=$('#chat #msg');if(i){lcDrafts.set(p.id,i.value);gbSaveDrafts()}
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
 const p=lcPane={id,say,group:!!b.group};
 const draft=lcDrafts.get(id);if(draft){input.value=draft;sb.disabled=!draft.trim()}
 input.addEventListener('input',()=>{lcDrafts.set(id,input.value);gbSaveDrafts()});
 if(b.group)$('.plus',form)?.remove();
 // A send that was in flight when an earlier document went away is unconfirmed now.
 const items=((D.threads&&D.threads[id])||[]).map(i=>i&&i.local==='sending'&&!gbFlying.has(i.id)?{...i,local:'orphan'}:i);
 p.live=LiveChat.mount({bridge:lcBridge,list,header:hd,target:{id,name:b.name,isGroup:!!b.group},
  items,nextBeforeSeq:D.nextBeforeSeqs&&D.nextBeforeSeqs[id],
  renderItem:m=>lcItem(m,id,!!b.group),onBots:(bots,gs)=>lcBots(bots,gs,p,!!b.group),statusLine:say,
  onItems:(its,before)=>{D.threads[id]=its;D.nextBeforeSeqs=D.nextBeforeSeqs||{};D.nextBeforeSeqs[id]=before;gbSaveThread(id,its,before)},
  onLost:it=>{gbGiveBack(id,it.text);say('A message did not send. It is back in the box.',true)}});
 if(!b.group){
  p.kit=ComposerKit.mount({bridge:lcBridge,form,input,sendButton:sb,bot:{id,name:b.name},status:line(),
   onSent:()=>{lcDrafts.delete(id);gbSaveDrafts();p.live.hurry()}});
  // The + needs tools; it appears once the host says they are ready.
  const plus=()=>{const x=$('.plus',form);if(x)x.hidden=!lcBridge.canInvoke};plus();p.off=lcBridge.onReady(plus)}
 const back=$('#back',c),goBack=back.onclick;back.onclick=()=>{lcClose();gbPut({pane:null});if(goBack)goBack.call(back)};
 p.live.refresh()}
// show.html's own row markup (thread()), one item at a time. Notices have no bot, so no orb. In a group
// each bot's message is named, as in the group thread card. A local send reads "Sending…" until confirmed.
function lcItem(m,id,g){if(typeof m.sys==='string'&&!m.bot)return m.sys?'<div class="sys">'+esc(m.sys)+'</div>':'';
 const sending=m.local&&m.local!=='sent'?'<div class="sys gb-sending">Sending…</div>':'';
 const bots=D.bots||[],who=m.sys&&!bots.some(x=>x.id===m.bot)?[{id:m.bot,name:m.sender||m.bot,color:'#888',shape:'blob'}]:[];
 const s=thread({bots:bots.concat(who),threads:{[id]:[m]}},id)+sending,i=s.indexOf('<div class="bubble');
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

/* Send: the bubble shows at once as a local row ('sending') while the message flies into the orb,
   the box clears for the next one, and the host's answer settles it — 'sent' (the next refresh swaps
   in the real message), back to the box on failure, or 'orphan' when unconfirmed (a refresh that finds
   it confirms it; one that still lacks it 30 s later hands it back). Replies are looked for sooner. */
function gbSend(p,v){const id=p.id,localId=p.live.addLocal(v);gbFlying.add(localId);gbLaunch(v,localId,id);
 invoke('grokbot_card_send',{bot:id,message:v})
  .then(r=>{let body=null;try{body=unpackResult(r)}catch(e){throw {status:'failed',error:e.message}}
   if(!body||body.sent!==true)throw {status:'failed',error:(body&&body.message)||'The send was not confirmed.'};gbLocal(id,localId,'sent')})
  .catch(e=>{const st=e&&e.status;if(st==='unknown'){gbLocal(id,localId,'orphan');return}
   gbLocal(id,localId,null);gbGiveBack(id,v);gbSay(id,((st==='cancelled'?'':(e&&(e.error||e.message))||'')+' Not sent. Your message is back in the box.').trim(),true)})
  .finally(()=>gbFlying.delete(localId))}
// Settle a local row whether or not its conversation is still the open pane.
function gbLocal(id,localId,state){const p=lcPane&&lcPane.id===id?lcPane:null;
 if(p){state?p.live.setLocal(localId,state):p.live.dropLocal(localId);if(state)p.live.hurry();return}
 const its=((D.threads&&D.threads[id])||[]).map(i=>i.id===localId?(state?{...i,local:state}:null):i).filter(Boolean);
 D.threads[id]=its;gbSaveThread(id,its,D.nextBeforeSeqs&&D.nextBeforeSeqs[id])}
// A message that did not go out returns to its box, unless the user already typed something new.
function gbGiveBack(id,text){const i=lcPane&&lcPane.id===id&&$('#chat #msg');
 if(i){if(!i.value.trim()){i.value=text;$('#chat .send').disabled=false;lcDrafts.set(id,text);gbSaveDrafts()}return}
 if(!(lcDrafts.get(id)||'').trim()){lcDrafts.set(id,text);gbSaveDrafts()}}
function gbSay(id,t,bad){if(lcPane&&lcPane.id===id)lcPane.say(t,bad)}

/* The message leaves the box as a bubble, condenses into a glowing pellet with a comet trail, and rides
   a curved motion path into the bot's orb (or the group's avatars), which gulp it. Its row shows on landing. */
const gbMix=(a,b,t)=>{const h=x=>[1,3,5].map(i=>parseInt(x.slice(i,i+2),16));const p=h(a),q=h(b);return 'rgb('+p.map((v,i)=>Math.round(v+(q[i]-v)*t)).join(',')+')'};
const gbRamp=t=>t<.5?gbMix('#ff5fd2','#8f7cff',t*2):gbMix('#8f7cff','#7cf5c8',(t-.5)*2);
const GB_FLY=950;
function gbGulp(orb,color){if(!orb)return;const a=orb.classList.contains('av')?orb:orb.querySelector('.av');
 if(a){Motion.react(a);setTimeout(()=>Motion.set(a,'working'),350)}
 if(gbCalm)return;orb.classList.remove('gb-gulp');void orb.offsetWidth;orb.classList.add('gb-gulp');setTimeout(()=>orb.classList.remove('gb-gulp'),850);
 const r=orb.getBoundingClientRect(),s=Math.min(r.width,r.height);
 [0,130].forEach(delay=>{const w=document.createElement('i');w.className='gb-wave';
  Object.assign(w.style,{left:(r.left+r.width/2-s/2)+'px',top:(r.top+r.height/2-s/2)+'px',width:s+'px',height:s+'px',animationDelay:delay+'ms'});
  w.style.setProperty('--c',color);document.body.appendChild(w);setTimeout(()=>w.remove(),900+delay)})}
function gbLaunch(text,localId,id){const c=$('#chat'),orb=$('.hd .av',c)&&!$('.hd .stack',c)?$('.hd .av',c):$('.hd .stack',c),input=$('#msg',c);
 const bot=(D.bots||[]).find(x=>x.id===id),color=(bot&&bot.color)||'#8f7cff';
 const row=()=>localId&&c.querySelector('[data-lc="'+localId+'"]');
 const land=()=>{const r=row();if(r)r.style.visibility='';gbGulp(orb,color)};
 if(gbCalm||!orb||!input){land();return}
 const r0=row();if(r0)r0.style.visibility='hidden';
 const s=input.getBoundingClientRect(),o=orb.getBoundingClientRect();
 const lead=document.createElement('div');lead.className='gb-fly probe';lead.textContent=text;document.body.appendChild(lead);
 const w=Math.min(lead.offsetWidth,s.width),sx=s.left+w/2,sy=s.top+s.height/2,ex=o.left+Math.min(o.width,36)/2,ey=o.top+o.height/2,reach=Math.min(innerWidth-24,Math.max(sx,ex)+150);
 const path="path('M "+sx+' '+sy+' C '+reach+' '+(sy-20)+', '+reach+' '+(ey+40)+', '+ex+' '+ey+"')";
 const set=el=>{el.style.setProperty('--path',path);el.style.setProperty('--dur',GB_FLY+'ms');el.style.setProperty('--c',color)};
 set(lead);lead.style.setProperty('--w',w+'px');lead.className='gb-fly lead';
 const ghosts=Array.from({length:6},(_,i)=>{const g=document.createElement('i');g.className='gb-fly ghost';set(g);
  g.style.setProperty('--s',(9-i)+'px');g.style.setProperty('--o',(.8-i*.12).toFixed(2));g.style.setProperty('--d',(38*(i+1))+'ms');g.style.setProperty('--col',gbRamp(i/5));
  document.body.appendChild(g);return g});
 let landed=false;const once=()=>{if(landed)return;landed=true;land()};
 lead.addEventListener('animationend',once,{once:true});setTimeout(once,GB_FLY+80);
 setTimeout(()=>{lead.remove();ghosts.forEach(g=>g.remove())},GB_FLY+420)}

/* New group: the same chat pane, before the group exists. Tap the avatars to pick bots, name it, and the
   first send creates it (grokbot_card_send with members + groupName); the pane then becomes that group's
   live chat. The pane itself is remembered, so a reopened notch comes back to it. */
function gbOpenNew(o){lcClose();const c=$('#chat');gbNew={members:[...new Set(o.members||[])],name:o.groupName||'',open:false,busy:false};
 c.innerHTML='<div class="hd"><button class="back" id="back" aria-label="Back"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg></button>'
  +'<button class="stack gb-pick" id="gb-pick" aria-label="Choose bots"></button><div class="grow"><input class="gb-gname" id="gb-gname" placeholder="Name this group" autocomplete="off" maxlength="80"><div class="st" id="gb-count"></div></div></div>'
  +'<div class="gb-members" id="gb-members" hidden></div>'
  +'<div class="msgs" id="msgs" style="max-height:268px"><div class="sys gb-empty">Pick the bots, then send the first message to start the group.</div></div>'+composer('the group');
 $('#panes').classList.add('open');
 const name=$('#gb-gname',c),form=$('#compose',c),input=$('#msg',form),sb=$('.send',form);$('.plus',form)?.remove();
 const st=document.createElement('div');st.className='sys lc-st';st.setAttribute('role','status');st.hidden=true;form.before(st);
 gbNew.say=(t,bad)=>{st.textContent=t||'';st.hidden=!t;st.classList.toggle('bad',!!bad);report()};
 name.value=gbNew.name;name.addEventListener('input',()=>{gbNew.name=name.value;gbSaveNew()});
 const draft=lcDrafts.get('new');if(draft){input.value=draft;sb.disabled=!draft.trim()}
 input.addEventListener('input',()=>{lcDrafts.set('new',input.value);gbSaveDrafts()});
 $('#gb-pick',c).onclick=()=>{gbNew.open=!gbNew.open;gbDrawNew()};
 $('#back',c).onclick=()=>{gbNew=null;gbPut({pane:null});$('#panes').classList.remove('open')};
 wireComposer(c,()=>{});gbNew.root=c;gbDrawNew();gbSaveNew()}
function gbSaveNew(){if(gbNew)gbPut({pane:{members:gbNew.members,groupName:gbNew.name}})}
function gbDrawNew(){const c=$('#chat'),n=gbNew;if(!n)return;const picked=n.members.map(id=>botById(D,id));
 $('#gb-pick',c).innerHTML=picked.length?picked.map(b=>av(b,'small')).join(''):'<span class="gb-plus">+</span>';
 $('#gb-count',c).textContent=picked.length?'New group · '+picked.map(b=>b.name).join(', '):'New group · tap + to add bots';
 const m=$('#gb-members',c);m.hidden=!n.open;
 m.innerHTML=(D.bots||[]).map(b=>'<button class="row gb-mrow" data-pick="'+esc(b.id)+'" aria-pressed="'+n.members.includes(b.id)+'">'+av(b,'small')+'<span class="t2 grow">'+esc(b.name)+'</span><span class="gb-check">'+(n.members.includes(b.id)?'✓':'')+'</span></button>').join('');
 $$('[data-pick]',m).forEach(r=>r.onclick=()=>{const id=r.dataset.pick;n.members=n.members.includes(id)?n.members.filter(x=>x!==id):[...n.members,id];gbDrawNew();gbSaveNew()});
 $('#msg',c).placeholder=picked.length?'Message '+picked.map(b=>b.name).join(', '):'Message the group';report()}
function gbNewSend(v){const n=gbNew,c=$('#chat'),input=$('#msg',c),sb=$('.send',c);if(!n||n.busy)return;
 if(n.members.length<2){n.say('Add at least two bots to start a group.',true);n.open=true;gbDrawNew();return}
 if(!CAN_INVOKE){n.say('Sending is unavailable in this host. Your draft is still here.',true);return}
 n.busy=true;n.open=false;gbDrawNew();input.value='';sb.disabled=true;input.disabled=true;n.say('Starting the group…');
 const list=$('#msgs',c),e=$('.gb-empty',list);if(e)e.remove();
 const b=document.createElement('div');b.className='bubble me fade-in';b.textContent=v;b.dataset.lc='gb-first';list.appendChild(b);list.scrollTop=list.scrollHeight;
 gbLaunch(v,'gb-first','');
 const members=n.members.slice(),groupName=n.name.trim();
 invoke('grokbot_card_send',{members,groupName,message:v})
  .then(r=>{let body=null;try{body=unpackResult(r)}catch(err){throw {status:'failed',error:err.message}}
   if(!body||body.sent!==true||!body.group)throw {status:'failed',error:(body&&body.message)||'The group was not created.'};
   const g={id:body.group,name:body.groupName||groupName||'New group',members:body.members||members,time:'now',last:v};
   D.groups=[...(D.groups||[]).filter(x=>x.id!==g.id),g];render(D);gbPut({madeGroups:[...(gbGet().madeGroups||[]).filter(x=>x.id!==g.id),g]});
   D.threads=D.threads||{};D.threads[g.id]=[{id:'lc-local-first-'+Date.now().toString(36),from:'me',text:v,timestampMs:Date.now(),local:'sent'}];
   lcDrafts.delete('new');gbSaveDrafts();gbSaveThread(g.id,D.threads[g.id],undefined);
   lcGroup=g.id;openChat(gbGroupRef(g));if(lcPane)lcPane.live.hurry()})
  .catch(err=>{if(!gbNew)return;const st=err&&err.status;n.busy=false;
   if(st==='unknown'){n.say('Not confirmed. Check Grok Bot before sending again.',true);return}
   b.remove();input.disabled=false;if(!input.value.trim()){input.value=v;lcDrafts.set('new',v);gbSaveDrafts()}sb.disabled=!input.value.trim();
   n.say(((st==='cancelled'?'':(err&&(err.error||err.message))||'')+' Not sent. Your message is back in the box.').trim(),true)})}

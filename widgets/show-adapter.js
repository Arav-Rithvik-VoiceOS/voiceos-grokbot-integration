/* Show-card glue: the ONE Grok Bot conversation surface. The chat pane (openChat) gets the live
   conversation, the + menu (1:1), Open computer, the fly-into-the-orb send, and a new-group pane
   (pick bots, name it, first send creates it). Runs in its own IIFE after show.html's script, whose
   top-level functions (openChat, wireComposer, render, …) it wraps by reassignment.

   Voice opens this same card: args.open says which pane to start on — {bot}, {group} (with optional
   pending {members, groupName} edits), or {members, groupName} for a new group — and args.message is
   the draft for that pane, or with args.sent the message voice already sent (it flies into the orb). */
const lcBridge=LiveChat.bridge({canInvoke:CAN_INVOKE}),lcDrafts=new Map();
let lcPane=null,lcGroup=null,gbNew=null,gbEdit=null,gbScreen=null,gbRosterDue=false,gbNewSince=null;
const gbCalm=matchMedia('(prefers-reduced-motion: reduce)').matches;
// show.html's own init listener runs first and sets CAN_INVOKE; mirror it (tools become ready on a later init).
addEventListener('message',e=>{const m=e.data;if(e.source===parent&&m&&m.type==='voiceos:init'){lcBridge.canInvoke=CAN_INVOKE;if(gbRosterDue&&CAN_INVOKE)gbRoster()}});
// Group rows open the pane with only a name; remember which row it was.
document.addEventListener('click',e=>{const r=e.target.closest&&e.target.closest('.row[data-group],.tile[data-group]');if(r)lcGroup=r.dataset.group},true);
// The roster header's +: the new-group pane (pick bots, name it, the first send creates it).
document.addEventListener('click',e=>{if(e.target.closest&&e.target.closest('#gb-new'))gbOpen({members:[],groupName:''})});

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
 // The last live roster this card saw is newer than the baked one: a bot or group deleted in Grok Bot
 // since then must not come back when the notch reopens the card.
 if(s.roster&&Array.isArray(s.roster.bots)&&Array.isArray(s.roster.groups)){d.bots=s.roster.bots;d.groups=s.roster.groups;gbMeta(d,s.roster)}
 // Groups this card created after its html was baked.
 (s.madeGroups||[]).forEach(g=>{d.groups=d.groups||[];if(!d.groups.some(x=>x.id===g.id))d.groups.push(g)});
 Object.entries(s.drafts||{}).forEach(([k,v])=>lcDrafts.set(k,v));
 // The voice message is used once: a reopened card must not put it back in the box or fly it in again.
 // args.sent = voice already sent it (it flies in below); otherwise it is a draft for the box.
 const k=gbKey(a.open),voice=!s.argsUsed&&k&&a.message?String(a.message):'';
 if(voice&&!a.sent&&!lcDrafts.has(k)){lcDrafts.set(k,voice);gbSaveDrafts()}
 gbPut({argsUsed:true});
 // boot runs inside show.html's init listener, before ours mirrors CAN_INVOKE: a pane opened below
 // (the screen pane probes its feed at once) must find the queue already on.
 lcBridge.canInvoke=CAN_INVOKE;
 lcBoot(d,a,mode);
 // Where the user left the card beats where voice opened it (null = they went back to the roster).
 const pane=s.pane!==undefined?s.pane:(a.open||null);if(pane)gbOpen(pane,true);
 // Wait two frames so the pane has its final layout before the flight measures the box and the orb.
 if(voice&&a.sent)requestAnimationFrame(()=>requestAnimationFrame(()=>{if(lcPane&&lcPane.id===k)gbFlyIn(lcPane,voice)}));
 // Check the roster once per open, even behind a chat: the saved chat's own bot may be the deleted one.
 // Then keep the roster pane in step with Grok Bot while it is on screen (gbListLive).
 gbRoster();gbListLive()};
// The sidebar layout that rides with every roster: pinned ids, sections, the Main Bot.
const GB_META=['pinned','sections','mainId'];
function gbMeta(to,from){if(!from)return;for(const k of GB_META){if(k in from)to[k]=from[k];else delete to[k]}}
const gbPick=from=>{const o={};for(const k of GB_META)if(from&&k in from)o[k]=from[k];return o};
// One roster-only read (no bot = no transcript): drops bots and groups deleted in Grok Bot.
// A card that booted before the host granted tools checks as soon as the grant arrives.
// auto: a background refresh, which spends only the card's automatic budget (LiveChat's AUTO cap).
let gbRosterBusy=false;
function gbRoster(auto){gbRosterDue=!CAN_INVOKE;if(gbRosterDue||gbRosterBusy)return;gbRosterBusy=true;
 lcBridge.call('grokbot_card_snapshot',{},{auto:!!auto}).then(b=>{
  if(b&&b.ok&&Array.isArray(b.bots)&&Array.isArray(b.groups))lcBots(b.bots,b.groups,null,true,b)}).catch(()=>{}).finally(()=>{gbRosterBusy=false})}
/* The roster pane follows Grok Bot while it is on screen, like the app's sidebar: a bot you just messaged
   in the app, or one that just answered, moves up. A read every 6 s while the roster is the visible pane
   (the chat pane's own refresh already brings the roster), at most 200 per card so a card left open does
   not spend the host's request budget. Showing the card again reads at once. */
const GB_LIST_GAP=6e3,GB_LIST_MAX=200;let gbListN=0,gbListT=0;
function gbListLive(){clearTimeout(gbListT);gbListT=setTimeout(gbListLive,GB_LIST_GAP);
 if(document.hidden||lcPane||gbNew||gbListN>=GB_LIST_MAX)return;gbListN++;gbRoster(true)}
document.addEventListener('visibilitychange',()=>{if(!document.hidden)gbListLive()});
/* Grok Bot moves a conversation to the top of its sidebar (below the pinned tiles) the moment you send
   in it. The card does the same at once, before the roster read catches up; a bump lasts 20 s, after
   which the live roster's own order is the truth again. */
const gbBumps=new Map(),GB_BUMP_MS=2e4;
function gbBumped(d){const now=Date.now();for(const [id,t] of gbBumps)if(now-t>GB_BUMP_MS)gbBumps.delete(id);if(!gbBumps.size)return d;
 const pinned=new Set(d.pinned||[]),list=rows(d);
 // Oldest bump first, so the latest send ends on top.
 for(const [id] of [...gbBumps].sort((a,b)=>a[1]-b[1])){const i=list.findIndex(x=>x.id===id);if(i<0||pinned.has(id))continue;
  const [x]=list.splice(i,1),at=list.findIndex(y=>!pinned.has(y.id));list.splice(at<0?list.length:at,0,x)}
 const order=list.map(x=>x.id);
 d.bots=list.filter(x=>!isGroup(x));
 d.groups=list.map((x,ix)=>[x,ix]).filter(([x])=>isGroup(x)).map(([x,ix])=>({...x,ix}));
 if(Array.isArray(d.sections))d.sections=d.sections.map(s=>({...s,ids:order.filter(id=>(s.ids||[]).includes(id))}));
 return d}
const gbRosterKey=d=>JSON.stringify([d.bots||[],d.groups||[],...GB_META.map(k=>d[k]??null)]);
function gbBump(id){if(!id)return;gbBumps.set(id,Date.now());const next=gbBumped({...D});
 if(gbRosterKey(next)===gbRosterKey(D))return;D.bots=next.bots;D.groups=next.groups;if('sections' in next)D.sections=next.sections;render(D)}
function gbOpen(p,instant){const panes=$('#panes');if(instant)panes.classList.add('gb-instant');
 // A reply notification's Open: the pane it opens marks the unseen replies, once (the saved pane drops it).
 gbNewSince=typeof p.newSince==='number'?{id:p.bot||p.group,t:p.newSince}:null;
 // {bot, screen}: "show me Jasper's screen" lands on the screen pane, the chat one Back away.
 if(p.bot){const b=(D.bots||[]).find(x=>x.id===p.bot);if(b){openChat(b);if(p.screen)gbOpenScreen(b)}}
 else if(p.group){const g=(D.groups||[]).find(x=>x.id===p.group);if(g){lcGroup=g.id;openChat(gbGroupRef(g));gbPending(p)}}
 else if(p.members)gbOpenNew(p);
 if(instant)setTimeout(()=>panes.classList.remove('gb-instant'),60)}
// A group opens with its own orb colors (the sidebar's), so the pane's accent is the group's.
const gbGroupRef=g=>({...g,status:'working',group:true,members:g.members||[]});

/* The screen pane sits on top of the open chat (list → chat → screen). It is saved as {bot, screen}, so a
   reopened notch comes back to the screen (the pane probes the feed again); Back saves the chat instead.
   The chat's LiveChat keeps running behind it, so Back just slides the feed away and tears it down. */
function gbOpenScreen(b){const host=$('#screen-pane');if(!host||b.group)return;
 if(gbScreen&&gbScreen.destroy)gbScreen.destroy();
 gbScreen=ScreenPane.mount({host,bot:botById(D,b.id)||b,invoke,onBack:gbCloseScreen,whenReady:f=>lcBridge.onReady(f)});
 gbPut({pane:{bot:b.id,screen:true}});
 $('#panes').classList.add('screen');if(typeof report==='function')report()}
function gbCloseScreen(){$('#panes').classList.remove('screen');const g=gbScreen;gbScreen=null;
 if(lcPane&&!lcPane.group)gbPut({pane:{bot:lcPane.id}});
 // Let the slide-out finish before dropping the socket and clearing the pane.
 setTimeout(()=>{if(g&&g.destroy)g.destroy();if(!gbScreen){const h=$('#screen-pane');if(h)h.innerHTML=''}if(typeof report==='function')report()},360)}

const lcOpen=openChat;
openChat=function(b){lcClose();gbNew=null;lcOpen(b);lcMount(b);if(lcPane)gbPut({pane:b.group?{group:lcPane.id}:{bot:b.id}})};
// The host allows one pending action per card: the card's own send waits its turn behind the live chat's calls.
const lcInv=invoke;invoke=(n,a)=>lcBridge.queue(()=>lcInv(n,a));
// Same composer wiring as show.html, plus: the saved draft,
// and the live send below (show.html's own send swapped the card for a receipt).
/* Attachments: the + opens the file picker (the app's own composer control); picked files show as chips
   above the box and go with the next send. Files live only in this document (a reopened notch starts
   without them). Limits match what one card can move through the host's 32 KB-per-call bridge in a
   reasonable time: 4 files, 4 MB each. */
const GB_FILE_MAX=4*1024*1024,GB_FILES_MAX=4,GB_CHUNK=30000;
let gbFiles=[];
const gbKind=f=>/^image\/(png|jpeg|gif|webp)$/.test(f.type)?'image':'file';
const gbSize=n=>n<1024?n+' B':n<1048576?Math.round(n/1024)+' KB':(n/1048576).toFixed(1)+' MB';
function gbDrawFiles(root){const box=$('#files',root),sb=$('.send',root),i=$('#msg',root);if(!box)return;
 box.hidden=!gbFiles.length;
 box.innerHTML=gbFiles.map((f,ix)=>'<span class="file'+(f.up?' up':'')+'" data-f="'+ix+'">'+(f.url?'<img src="'+f.url+'" alt="">':'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5"/></svg>')+'<span>'+esc(f.file.name)+'</span><small>'+(f.up?f.up:gbSize(f.file.size))+'</small>'+(f.up?'':'<button class="x" type="button" aria-label="Remove">×</button>')+'</span>').join('');
 $$('.file .x',box).forEach(x=>x.onclick=()=>{const ix=+x.parentNode.dataset.f;const [g]=gbFiles.splice(ix,1);if(g&&g.url)URL.revokeObjectURL(g.url);gbDrawFiles(root)});
 if(sb&&i)sb.disabled=gbFiles.some(f=>f.up)||(!i.value.trim()&&!gbFiles.length);report()}
function gbAddFiles(root,list,p){const add=Array.from(list||[]);if(!add.length)return;
 const next=gbFiles.slice();
 for(const f of add){if(next.some(x=>x.file.name===f.name&&x.file.size===f.size&&x.file.lastModified===f.lastModified))continue;
  if(f.size>GB_FILE_MAX){if(p)p.say('Files can be up to 4 MB each.');continue}
  if(next.length>=GB_FILES_MAX){if(p)p.say('Attach up to '+GB_FILES_MAX+' files at a time.');break}
  next.push({file:f,url:gbKind(f)==='image'?URL.createObjectURL(f):'',up:''})}
 gbFiles=next;gbDrawFiles(root)}
function gbClearFiles(root,sent){sent.forEach(f=>{if(f.url)URL.revokeObjectURL(f.url)});gbFiles=gbFiles.filter(f=>!sent.includes(f));gbDrawFiles(root)}
const gbB64=file=>new Promise((ok,no)=>{const r=new FileReader();r.onload=()=>ok(String(r.result).replace(/^data:[^,]*,/,''));r.onerror=()=>no(new Error('Could not read '+file.name));r.readAsDataURL(file)});
// The card can measure its local copy. Only Grok Bot knows when the remote upload finishes.
async function gbUpload(root,entry,botId){
 if(entry.uploaded&&entry.uploaded.botId===botId)return entry.uploaded.file;
 const update=label=>{entry.up=label;gbDrawFiles(root)};
 update('Reading…');
 const b64=await gbB64(entry.file),id='u'+Date.now().toString(36)+Math.random().toString(36).slice(2,7);
 let off=0;
 do {
  const chunk=b64.slice(off,off+GB_CHUNK),last=off+chunk.length===b64.length;
  update(last?'Uploading to Grok Bot…':'Preparing '+Math.floor(off/b64.length*100)+'%');
  const r=await invoke('grokbot_card_upload',{bot:botId,uploadId:id,name:entry.file.name,type:entry.file.type||'',offset:off,total:b64.length,chunk});
  const body=unpackResult(r);
  if(last){
   if(!body||!body.done||!body.path)throw new Error('Grok Bot did not confirm the upload.');
   update('Uploaded');
   const file={path:body.path,name:body.name||entry.file.name};
   entry.uploaded={botId,file};return file;
  }
  off+=chunk.length;
  if(!body||body.received!==off)throw new Error('VoiceOS did not receive the file.');
 } while(off<b64.length);
}
wireComposer=function(root,onSend){const f=$('#compose',root),i=$('#msg',f),b=$('.send',f),pick=$('#pick',root),plus=$('#attach',root);
 gbFiles=[];
 const go=()=>{const v=i.value.trim(),p=lcPane,files=gbFiles.slice();
  if(!v&&!files.length)return;
  if(gbNew&&gbNew.root===root)return v?gbNewSend(v):undefined;
  if(!p)return;
  if(!CAN_INVOKE){p.say('Sending is unavailable in this host. Your draft is still here.',true);return}
  if(p.group&&gbEdit&&gbEdit.id===p.id&&!gbEdit.members.length){p.say('Keep at least one bot in the group.',true);gbEdit.open=true;gbDrawEdit();return}
  if(files.some(x=>x.up))return; // an upload is already on its way
  i.value='';b.disabled=true;lcDrafts.delete(p.id);gbSaveDrafts();p.say('');gbSend(p,v,files)};
 i.addEventListener('input',()=>b.disabled=gbFiles.some(f=>f.up)||(!i.value.trim()&&!gbFiles.length));b.addEventListener('click',e=>{e.preventDefault();go()});
 i.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();go()}});
 if(plus&&pick){const newPane=gbNew&&gbNew.root===root;plus.disabled=newPane; // a group that does not exist yet takes text first
  plus.addEventListener('click',()=>pick.click());pick.addEventListener('change',()=>{gbAddFiles(root,pick.files,lcPane);pick.value=''})}
 // Paste an image into the box: the app accepts that too.
 i.addEventListener('paste',e=>{const fs=Array.from((e.clipboardData&&e.clipboardData.files)||[]);if(fs.length){e.preventDefault();gbAddFiles(root,fs,lcPane)}})};

function lcClose(){const p=lcPane;gbEdit=null;if(!p)return;lcPane=null;
 const i=$('#chat #msg');if(i){lcDrafts.set(p.id,i.value);gbSaveDrafts()}
 // Reopening this conversation starts from what the pane already showed.
 D.threads=D.threads||{};D.threads[p.id]=p.live.items();D.nextBeforeSeqs=D.nextBeforeSeqs||{};D.nextBeforeSeqs[p.id]=p.live.nextBeforeSeq();
 p.live.destroy()}
function lcMount(b){const c=$('#chat'),list=$('#msgs',c),hd=$('.hd',c),form=$('#compose',c),groups=D.groups||[];
 const g=b.group&&(groups.find(x=>x.id===lcGroup&&x.name===b.name)||groups.find(x=>x.name===b.name)),id=b.group?g&&g.id:b.id;
 if(!id||!list||!hd||!form)return;
 const input=$('#msg',form),sb=$('.send',form);
 // Status lines are gray and brief (never red): the app shows no warnings in a chat.
 const line=()=>{const st=document.createElement('div');st.className='sys lc-st';st.setAttribute('role','status');st.hidden=true;form.before(st);let t0=0;
  return (t)=>{st.textContent=t||'';st.hidden=!t;report();clearTimeout(t0);if(t)t0=setTimeout(()=>{st.textContent='';st.hidden=true;report()},4000)}};
 const say=line();
 const p=lcPane={id,say,group:!!b.group};
 const draft=lcDrafts.get(id);if(draft){input.value=draft;sb.disabled=!draft.trim()}
 input.addEventListener('input',()=>{lcDrafts.set(id,input.value);gbSaveDrafts()});
 // A send that was in flight when an earlier document went away is unconfirmed now.
 const items=((D.threads&&D.threads[id])||[]).map(i=>i&&i.local==='sending'&&!gbFlying.has(i.id)?{...i,local:'orphan'}:i);
 p.live=LiveChat.mount({bridge:lcBridge,list,header:hd,target:{id,name:b.name,isGroup:!!b.group},
  items,nextBeforeSeq:D.nextBeforeSeqs&&D.nextBeforeSeqs[id],newSince:gbNewSince&&gbNewSince.id===id?gbNewSince.t:null,
  renderItem:m=>lcItem(m,id,!!b.group),onBots:(bots,gs,meta)=>lcBots(bots,gs,p,!!b.group,meta),statusLine:say,onScreen:()=>gbOpenScreen(b),
  onItems:(its,before)=>{D.threads[id]=its;D.nextBeforeSeqs=D.nextBeforeSeqs||{};D.nextBeforeSeqs[id]=before;gbSaveThread(id,its,before)},
  onLost:it=>{gbGiveBack(id,it.text);say('A message did not send. It is back in the box.',true)}});
 const back=$('#back',c),goBack=back.onclick;back.onclick=()=>{lcClose();gbPut({pane:null});if(goBack)goBack.call(back);gbListLive()};
 gbNewSince=null;if(b.group)gbMountEdit(g,c);
 p.live.refresh()}
// show.html's own row markup (thread()), one item at a time. Notices have no bot, so no orb. In a group
// each bot's message is named, as in the group thread card. A local send reads "Sending…" until confirmed.
function lcItem(m,id,g){if(typeof m.sys==='string'&&!m.bot)return m.sys?'<div class="sys">'+esc(m.sys)+'</div>':'';
 const sending='';
 const bots=D.bots||[],who=m.sys&&!bots.some(x=>x.id===m.bot)?[{id:m.bot,name:m.sender||m.bot,color:'#888',shape:'blob'}]:[];
 const s=thread({bots:bots.concat(who),threads:{[id]:[m]}},id)+sending,i=s.indexOf('<div class="bubble');
 if(!g||typeof m.sys==='string'||m.from!=='bot'||!m.bot||i<0)return s;
 const sb=bots.find(x=>x.id===m.bot)||{name:m.sender||m.bot,color:'#888',shape:'blob'};
 return s.slice(0,i)+'<div class="from">'+av(sb,'tiny')+esc(sb.name)+'</div>'+s.slice(i)}
// A refresh's roster: the open bot's header status, and the roster pane behind it for the back button.
function lcBots(bots,groups,p,isGroup,meta){
 // Every caller passes a whole live roster (a snapshot), so it is saved for the next reopen as is.
 const layout=gbPick(meta);gbPut({roster:{bots,groups,...layout}});
 // The live roster is the truth for groups this card made: one missing from it was deleted in Grok Bot,
 // so a reopened card must stop re-adding it. (Card calls run one at a time, so a refresh never races the create.)
 const made=gbGet().madeGroups||[];if(made.length){const live=new Map(groups.map(g=>[g.id,g]));
  const kept=made.filter(g=>live.has(g.id)).map(g=>({...g,...live.get(g.id)}));
  if(JSON.stringify(kept)!==JSON.stringify(made))gbPut({madeGroups:kept})}
 // An empty list is real too: every bot was deleted. The live roster in its sidebar order, plus any send
 // bump still in its window, is what the pane shows; it redraws only when that differs (a redraw restarts
 // every orb's eyes, so an unchanged roster must not redraw).
 const next={bots,groups,...gbPick(D)};if(meta)gbMeta(next,meta);gbBumped(next);
 if(gbRosterKey(next)===gbRosterKey(D))return;
 D.bots=next.bots;D.groups=next.groups;gbMeta(D,next);render(D);
 if(isGroup||lcPane!==p)return;
 const bt=botById(D,p.id),hd=$('#chat .hd'),s=hd&&$('.st',hd),a=hd&&$('.av',hd);
 if(s)s.innerHTML='<span class="dot '+dotCls(bt)+'"></span>'+statusText(bt)+(bt.label?' · '+esc(bt.label):'');
 if(a&&a.dataset.state!==(bt.status||'idle'))Motion.set(a,bt.status||'idle')}

/* Send: the bubble shows at once as a local row ('sending') while the message flies into the orb,
   the box clears for the next one, and the host's answer settles it — 'sent' (the next refresh swaps
   in the real message), back to the box on failure, or 'orphan' when unconfirmed (a refresh that finds
   it confirms it; one that still lacks it 30 s later hands it back). Replies are looked for sooner. */
function gbSend(p,v,files){files=files||[];const id=p.id,root=$('#chat'),names=files.map(x=>x.file.name);
 const localId=p.live.addLocal(v,names);gbFlying.add(localId);gbLaunch(v,localId,id);gbBump(id);
 // A group with pending member/name edits saves them in the same call, before it sends.
 const e=p.group&&gbEdit&&gbEdit.id===id&&gbDirty(gbEdit)?gbEdit:null,edit=e&&{members:e.members.slice(),groupName:e.name.trim()||e.base.name};
 // Lock every selected chip before the first asynchronous file read. A second click cannot send it twice.
 files.forEach(f=>{f.up='Waiting…'});if(files.length)gbDrawFiles(root);
 let sending=false;
 const uploads=(async()=>{const out=[];for(const f of files)out.push(await gbUpload(root,f,id));return out})();
 uploads.then(att=>{
  files.forEach(f=>{f.up='Sending…'});if(files.length)gbDrawFiles(root);
  sending=true;
  return invoke('grokbot_card_send',{...(edit?{group:id,...edit}:{bot:id}),message:v,...(att.length?{attachments:att}:{})});
 }).then(r=>{let body=null;try{body=unpackResult(r)}catch(e){throw {status:'failed',error:e.message}}
   if(!body||body.sent!==true)throw {status:'failed',error:(body&&body.message)||'The send was not confirmed.'};
   if(files.length)gbClearFiles(root,files);gbLocal(id,localId,'sent');
   if(edit)gbSaved(id,body.members||edit.members,body.groupName||edit.groupName)})
  .catch(e=>{if(sending&&e&&e.status==='unknown'){
    if(files.length)gbClearFiles(root,files);gbLocal(id,localId,'orphan');gbSay(id,'Check the chat before sending again.');return}
   gbLocal(id,localId,null);gbGiveBack(id,v);files.forEach(f=>{f.up=''});gbDrawFiles(root);
   gbSay(id,sending?'Not sent. Your message is back in the box.':'The upload did not finish. Your message was not sent.')})
  .finally(()=>gbFlying.delete(localId))}
/* Voice already sent this message: it still leaves the box and flies into the orb, as a tap send does.
   It lands on its real row if the pane's first refresh already brought it, else on a local 'sent' row
   that the next refresh swaps for the real one. */
function gbFlyIn(p,v){const t=v.trim(),now=Date.now();gbBump(p.id);
 const hit=p.live.items().filter(i=>i&&i.from==='me'&&!i.local&&String(i.text||'').trim()===t&&now-(+i.timestampMs||0)<12e4).pop();
 const id=hit?hit.id:p.live.addLocal(v);if(!hit)p.live.setLocal(id,'sent');
 gbLaunch(v,id,p.id);p.live.hurry()}
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

/* A send shows its row at once, like the app: no flight, no label. The orb only blinks. */
function gbLaunch(text,localId,id){const c=$('#chat'),a=$('.hd .av',c);if(a)Motion.react(a);
 const r=localId&&c.querySelector('[data-lc="'+localId+'"]');if(r)r.style.visibility=''}

/* New group: the same chat pane, before the group exists. Tap the avatars to pick bots, name it, and the
   first send creates it (grokbot_card_send with members + groupName); the pane then becomes that group's
   live chat. The pane itself is remembered, so a reopened notch comes back to it. */
function gbOpenNew(o){lcClose();const c=$('#chat');gbNew={members:[...new Set(o.members||[])],name:o.groupName||'',open:false,busy:false};
 c.style.setProperty('--bot','#777777');c.style.setProperty('--bot-ink','#fff');
 c.innerHTML='<div class="hd chat-hd"><button class="back" id="back" aria-label="Back"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg></button>'
  +'<div class="mid"><div class="pill"><button class="stack gb-pick" id="gb-pick" aria-label="Choose bots"></button><div class="grow"><input class="gb-gname" id="gb-gname" placeholder="Name this group" autocomplete="off" maxlength="80"></div></div></div></div><div class="sys gb-count" id="gb-count"></div>'
  +'<div class="gb-members" id="gb-members" hidden></div>'
  +msgsBox('<div class="sys gb-empty">Pick the bots, then send the first message to start the group.</div>')+composer('the group');
 $('#panes').classList.add('open');
 const name=$('#gb-gname',c),form=$('#compose',c),input=$('#msg',form),sb=$('.send',form);
 const st=document.createElement('div');st.className='sys lc-st';st.setAttribute('role','status');st.hidden=true;form.before(st);
 let st0=0;gbNew.say=(t)=>{st.textContent=t||'';st.hidden=!t;report();clearTimeout(st0);if(t)st0=setTimeout(()=>{st.textContent='';st.hidden=true;report()},4000)};
 name.value=gbNew.name;name.addEventListener('input',()=>{gbNew.name=name.value;gbSaveNew()});
 const draft=lcDrafts.get('new');if(draft){input.value=draft;sb.disabled=!draft.trim()}
 input.addEventListener('input',()=>{lcDrafts.set('new',input.value);gbSaveDrafts()});
 $('#gb-pick',c).onclick=()=>{gbNew.open=!gbNew.open;gbDrawNew()};
 $('#back',c).onclick=()=>{gbNew=null;gbPut({pane:null});$('#panes').classList.remove('open')};
 wireComposer(c,()=>{});gbNew.root=c;gbDrawNew();gbSaveNew()}
function gbSaveNew(){if(gbNew)gbPut({pane:{members:gbNew.members,groupName:gbNew.name}})}
function gbDrawNew(){const c=$('#chat'),n=gbNew;if(!n)return;const picked=n.members.map(id=>botById(D,id));
 $('#gb-pick',c).innerHTML=picked.length?picked.map(b=>av(b,'mini')).join(''):'<span class="gb-plus">+</span>';
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
   const g={id:body.group,name:body.groupName||groupName||'New group',members:body.members||members,time:'now',last:v,color:'#777777',shape:'blob'};
   D.groups=[...(D.groups||[]).filter(x=>x.id!==g.id),g];render(D);gbPut({madeGroups:[...(gbGet().madeGroups||[]).filter(x=>x.id!==g.id),g]});
   D.threads=D.threads||{};D.threads[g.id]=[{id:'lc-local-first-'+Date.now().toString(36),from:'me',text:v,timestampMs:Date.now(),local:'sent'}];
   lcDrafts.delete('new');gbSaveDrafts();gbSaveThread(g.id,D.threads[g.id],undefined);
   lcGroup=g.id;openChat(gbGroupRef(g));if(lcPane)lcPane.live.hurry()})
  .catch(err=>{if(!gbNew)return;const st=err&&err.status;n.busy=false;
   if(st==='unknown'){n.say('Not confirmed. Check Grok Bot before sending again.',true);return}
   b.remove();input.disabled=false;if(!input.value.trim()){input.value=v;lcDrafts.set('new',v);gbSaveDrafts()}sb.disabled=!input.value.trim();
   n.say(((st==='cancelled'?'':(err&&(err.error||err.message))||'')+' Not sent. Your message is back in the box.').trim(),true)})}

/* Existing group: the header's avatars and name are its editor, like the new-group pane's. Edits stay
   pending (saved with the pane, so a reopened notch keeps them) and the next send saves them first
   (grokbot_card_send with group + members + groupName). Back drops unsent edits. */
const gbSame=(a,b)=>a.length===b.length&&a.every(x=>b.includes(x));
const gbDirty=e=>!gbSame(e.members,e.base.members)||(!!e.name.trim()&&e.name.trim()!==e.base.name);
function gbMountEdit(g,c){const hd=$('.hd',c),stack=hd&&$('.stack',hd),t=hd&&$('.t2',hd);if(!g||!stack||!t)return;
 const e=gbEdit={id:g.id,base:{members:(g.members||[]).slice(),name:g.name},members:(g.members||[]).slice(),name:g.name,open:false};
 const pick=document.createElement('button');pick.className='stack gb-pick';pick.id='gb-pick';pick.setAttribute('aria-label','Edit members');stack.replaceWith(pick);
 const name=document.createElement('input');name.className='gb-gname';name.id='gb-gname';name.maxLength=80;name.autocomplete='off';name.setAttribute('aria-label','Group name');name.value=g.name;t.replaceWith(name);
 const m=document.createElement('div');m.className='gb-members';m.id='gb-members';m.hidden=true;hd.after(m);
 name.addEventListener('input',()=>{e.name=name.value;gbSaveEdit()});
 pick.onclick=()=>{e.open=!e.open;gbDrawEdit()};gbDrawEdit()}
// Voice's (or the saved pane's) pending edits, applied to the pane openChat just mounted.
function gbPending(p){const e=gbEdit;if(!e||e.id!==p.group||(!p.members&&!p.groupName))return;
 if(Array.isArray(p.members))e.members=[...new Set(p.members)];
 if(p.groupName){e.name=String(p.groupName);const n=$('#chat #gb-gname');if(n)n.value=e.name}
 gbDrawEdit();gbSaveEdit()}
function gbSaveEdit(){const e=gbEdit;if(!e||!lcPane||lcPane.id!==e.id)return;const d=gbDirty(e);
 gbPut({pane:d?{group:e.id,members:e.members,groupName:e.name}:{group:e.id}});lcPane.say(d?'Your changes save when you send.':'');
 const i=$('#chat #msg');if(i)i.placeholder='Message '+(e.name.trim()||e.base.name)}
function gbDrawEdit(){const c=$('#chat'),e=gbEdit,pick=$('#gb-pick',c),m=$('#gb-members',c);if(!e||!pick||!m)return;
 const picked=e.members.map(id=>botById(D,id));
 pick.innerHTML=picked.length?picked.map(b=>av(b,'mini')).join(''):'<span class="gb-plus">+</span>';
 m.hidden=!e.open;
 m.innerHTML=(D.bots||[]).map(b=>'<button class="row gb-mrow" data-pick="'+esc(b.id)+'" aria-pressed="'+e.members.includes(b.id)+'">'+av(b,'small')+'<span class="t2 grow">'+esc(b.name)+'</span><span class="gb-check">'+(e.members.includes(b.id)?'✓':'')+'</span></button>').join('');
 $$('[data-pick]',m).forEach(r=>r.onclick=()=>{const id=r.dataset.pick;e.members=e.members.includes(id)?e.members.filter(x=>x!==id):[...e.members,id];gbDrawEdit();gbSaveEdit()});
 report()}
// The send saved the edits: they are the group's now, in the roster and as the pane's new baseline.
function gbSaved(id,members,name){D.groups=(D.groups||[]).map(g=>g.id===id?{...g,members,name}:g);render(D);
 const s=gbGet(),fix=g=>g.id===id?{...g,members,name}:g;
 gbPut({madeGroups:(s.madeGroups||[]).map(fix),...(s.roster?{roster:{...s.roster,groups:(s.roster.groups||[]).map(fix)}}:{})});
 const e=gbEdit;if(!e||e.id!==id)return;e.base={members:members.slice(),name};
 if(gbSame(e.members,members)&&(e.name.trim()||name)===name)e.name=name;gbSaveEdit()}

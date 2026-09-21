import {
  composerCss,
  composerHtml,
  composerMenuHtml,
  teachHtml,
  composerRuntime,
} from "./composerWidget.ts";
import { MARK_DATA_URI } from "./assets.generated.ts";
import { markdownCss } from "./markdown.ts";
import { avatarCss, avatarRuntime } from "./avatar.ts";

const css = String.raw`
html,body{background:#070707!important;color:#f3f3f3;font:13px/1.5 -apple-system,BlinkMacSystemFont,system-ui,sans-serif;margin:0;height:100%;min-height:0;overflow:hidden}
*{box-sizing:border-box}button,input,textarea{font:inherit}button{cursor:pointer;color:inherit}button:disabled{opacity:.45;cursor:default}button:focus-visible,input:focus-visible,textarea:focus-visible{outline:2px solid #a7a7a7;outline-offset:2px}
[hidden]{display:none!important}.card{height:min(410px,100dvh);display:flex;flex-direction:column;overflow:hidden;border-radius:20px;background:#111}
.header{flex:none;display:flex;align-items:center;gap:10px;padding:12px 14px;background:#111;z-index:1;border-bottom:1px solid #222}.header .identity{flex:1;min-width:0}.name{font-weight:600;font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.status,.muted{color:#999;font-size:11px}.brand{display:flex;gap:7px;align-items:center;color:#f3f3f3;font-size:14px;font-weight:600;white-space:nowrap}.brand img{width:16px;height:16px}.round{background:#262626;border:0;border-radius:50%;width:28px;height:28px;flex:none}.round:hover{background:#3a3a3a}
.list{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain;padding:4px 12px}.bot-row{display:flex;gap:11px;align-items:center;width:100%;padding:10px 12px;text-align:left;border:0;background:none;border-radius:10px}.bot-row:hover{background:#222;--avatar-ring:#222}.bot-row .identity{flex:1;min-width:0}.preview{overflow:hidden;white-space:nowrap;text-overflow:ellipsis;color:#999;font-size:12px}.attention{color:#f3bd69}
.messages{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain;padding:10px 12px;display:flex;flex-direction:column;gap:5px;background:#070707}.entry{width:100%;flex:none;min-width:0}.bubble{font-size:13px;line-height:1.5;background:#262626;border-radius:17px;padding:8px 12px;max-width:96%;width:fit-content;margin:0;overflow-wrap:anywhere;white-space:normal}.bubble.me{background:#313131;margin-left:auto;border-bottom-right-radius:5px}.bubble.bot{border-bottom-left-radius:5px}.bubble p{margin:0 0 8px}.bubble p:last-child{margin:0}.bubble a{color:#bcd7ff;text-decoration:underline}.bubble pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#111;padding:8px;border-radius:6px}.bubble code{font-size:12px;background:#191919;border-radius:4px;padding:1px 3px}.bubble ul,.bubble ol{margin:5px 0;padding-left:20px}.system{display:flex;gap:5px;align-items:center;justify-content:center;margin:7px 0;color:#999;font-size:10px}.system .avatar{width:14px;height:14px}.sender{margin:5px 0;color:#aaa;font-size:11px}.time{margin:2px 2px 5px;color:#777;font-size:10px;text-align:right}
.media{margin:5px 0;max-width:288px}.image-button{padding:0;display:block;border:0;background:#262626;border-radius:12px;overflow:hidden;max-width:100%;min-height:70px;min-width:120px;text-align:left}.image-button img{display:block;max-width:100%;max-height:220px;width:auto;object-fit:contain}.image-label{font-size:11px;color:#aaa;padding:6px 8px}.file{display:flex;align-items:center;gap:8px;padding:10px;background:#262626;border:1px solid #3d3d3d;border-radius:10px;width:100%;text-align:left;overflow-wrap:anywhere}
.request{background:#262626;border-radius:13px;padding:10px 12px;margin:3px 0;max-width:100%}.request-title{display:flex;gap:8px;align-items:flex-start;margin-bottom:8px}.request-title span{flex:1}.dismiss{background:none;border:0;color:#999;padding:0 2px}.choices{border:1px solid #414141;border-radius:8px;overflow:hidden}.option{display:flex;align-items:center;gap:8px;text-align:left;background:#303030;border:0;border-bottom:1px solid #414141;width:100%;padding:8px}.option:last-child{border-bottom:0}.option:hover,.option[aria-pressed=true]{background:#414141}.key{font-size:10px;line-height:17px;min-width:17px;text-align:center;border-radius:3px;background:#444;color:#bbb}.option-text{flex:1}.option-description{display:block;font-size:11px;color:#aaa}.custom{display:flex;gap:6px;margin-top:8px}.custom input{min-width:0}.action{padding:7px 11px;background:#e5e5e5;color:#161616;border:0;border-radius:8px;margin-top:8px}.request-status{flex:none;font-size:10px;line-height:1.5;border-radius:12px;padding:2px 7px;background:#373737;color:#a0a0a0}.request-status.success{color:#8bcc9d}.request-status.error{color:#ff8c8c}.request-details{font-size:12px;color:#bbb;margin:6px 0}.request-details summary{cursor:pointer}.request-details dl{margin:7px 0}.request-details dt{color:#999;font-size:11px;margin-top:7px}.request-details dd{margin:2px 0;white-space:pre-wrap;overflow-wrap:anywhere}.request-footer{margin-top:8px}.resolved{color:#bdbdbd;font-size:12px}.request p{color:#bbb;font-size:12px;margin:0 0 8px;white-space:pre-wrap}.composer{flex:none;display:flex;gap:8px;align-items:center;padding:8px 12px;background:#111;border-top:1px solid #222}.composer textarea{border:1px solid #414141;min-width:0;flex:1;height:38px;max-height:70px;border-radius:18px;background:#262626;color:#eee;padding:8px 12px;resize:none}.composer .send{width:32px;height:32px;border:0;border-radius:50%;background:#ddd;color:#111;font-size:19px}.notice{padding:5px 14px;font-size:11px;line-height:1.4;color:#f3bd69;background:#171717;max-height:52px;overflow:auto}.empty{padding:25px 10px;text-align:center;color:#999}.load{color:#aaa;background:none;border:0;padding:5px;font-size:11px}.lightbox{position:absolute;inset:0;background:#080808;z-index:5;display:flex;flex-direction:column;padding:12px;gap:8px}.lightbox img{min-height:0;flex:1;width:100%;object-fit:contain}.lightbox .round{align-self:flex-end}.lightbox .action{align-self:center}.busy .send{opacity:.4}
`;

// Self-contained by design: packaged MCP servers must not read a widgets folder.
export const conversationRuntime = String.raw`
(()=>{
const payload=JSON.parse(document.getElementById('payload').textContent),data=payload.data||{},args=payload.args||{};
const $=s=>document.querySelector(s),esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let bots=data.bots||[],groups=(data.groups||[]).map(g=>({...g,isGroup:true})),selected=args.bot||args.group||null,items=data.thread||[],before,canInvoke=false,pending=null,sequence=0,requests=0,refreshTimer,disposed=false;
let chain=Promise.resolve(),busyAction=false,uncertain=false,revision='',drafts=new Map(),imageCache=new Map(),selection=new Map(),answers=new Map(),fullEntries=new Map(),entryLoads=new Set();
const head=$('.header'),messages=$('.messages'),list=$('.list'),composer=$('.composer'),input=$('#message'),send=$('#send'),notice=$('.notice');
const brand='<span class="brand"><img src="'+payload.mark+'" alt="">Grok Bot</span>';
const bot=id=>[...bots,...groups].find(b=>b.id===id)||{id,name:'Bot',shape:'blob',color:'#777'};
${avatarRuntime}
function state(b){return b.status==='waiting'?'Needs your attention':b.status==='thinking'?'Typing…':b.status==='working'?'Working':'Idle';}
function attention(b){return typeof b.attention==='boolean'?b.attention:b.status==='waiting';}
function working(b){return !b.isGroup&&!attention(b)&&(b.working??['working','thinking'].includes(b.status));}
function marker(b){const waiting=attention(b);return waiting||b.unread?'<span class="status-marker '+(waiting?'attention':'unread')+'" role="status" aria-label="'+(waiting?'Needs your attention':'Unread messages')+'" title="'+(waiting?'Needs your attention':'Unread messages')+'"></span>':'';}
function info(text){notice.textContent=text||'';notice.hidden=!text;}
function report(){parent.postMessage({type:'voiceos:resize',height:410},'*');}
function unwrap(result){if(result?.isError)throw Error('Grok Bot could not complete this request.');if(result?.structuredContent)return result.structuredContent;const text=result?.content?.find(b=>b.type==='text')?.text;return typeof text==='string'?JSON.parse(text):result;}
function invoke(name,args){
 const go=()=>new Promise((resolve,reject)=>{
  if(disposed||!canInvoke){reject(Error('Open this card again to reconnect to Grok Bot.'));return;}
  if(requests>=62){reject(Error('Open a fresh Grok Bot card to continue.'));return;}
  requests++;const requestId='conversation_'+Date.now()+'_'+(++sequence);
  const timer=setTimeout(()=>{if(pending?.requestId===requestId)pending=null;reject(Object.assign(Error('The result is unconfirmed. Refresh before trying again.'),{unknown:true}));},60000);
  pending={requestId,resolve,reject,timer};parent.postMessage({type:'voiceos:invokeTool',name,args,requestId},'*');
 });const task=chain.then(go);chain=task.catch(()=>{});return task;
}
addEventListener('message',event=>{
 if(event.source!==parent)return;const m=event.data;
 if(m?.type==='voiceos:init'){const becameReady=!canInvoke&&m.capabilities?.invokeTool===true;canInvoke=m.capabilities?.invokeTool===true;send.disabled=!input.value.trim()||!canInvoke||uncertain;report();updateSend();if(becameReady){if(selected){recoverFiles();observeDeferred();messages.querySelectorAll('[data-load]').forEach(el=>{imageObserver.unobserve(el);imageObserver.observe(el);});}refresh();}return;}
 if(m?.type!=='voiceos:toolResult'||!pending||m.requestId!==pending.requestId||!['completed','failed','cancelled','unknown'].includes(m.status))return;
 const p=pending;pending=null;clearTimeout(p.timer);
 if(m.status==='completed'&&!m.resultOmitted){try{const r=unwrap(m.result);if(r?.ok===false)throw Error(r.message||'The request failed.');p.resolve(r);}catch(e){p.reject(e);}}
 else p.reject(Object.assign(Error(m.error||(m.resultOmitted?'The result was too large. Reopen the conversation.':'The request did not complete.')),{unknown:m.status==='unknown'||m.resultOmitted===true}));
});
function markdown(text){return esc(text).replace(/\n/g,'<br>');}
function messageHtml(item){return typeof item.html==='string'?item.html:markdown(item.text||'');}
function effectiveState(item){return item.state==='pending'?(answers.get(selected+':'+item.id)?.state||item.state):item.state;}
function waitingOn(item){return item.deferred?.attention||(effectiveState(item)==='pending'&&(item.choice||item.request?.attention===true));}
function itemHtml(item){
 if(item.deferred)return (item.text?'<div class="bubble '+item.from+'">'+markdown(item.text)+'</div>':'')+'<div class="muted" data-deferred role="status">Loading message…</div>';
 if(item.sys)return '<div class="system">'+esc(item.sys)+(item.bot?' '+avatar(bot(item.bot))+' '+esc(item.sender||bot(item.bot).name):'')+'</div>';
 let html=item.sender?'<div class="sender">'+esc(item.sender)+'</div>':'';
 if(item.text&&messageHtml(item).trim())html+='<div class="bubble '+item.from+'">'+messageHtml(item)+'</div>';
 for(const [index,m] of (item.media||[]).entries()){
  const key=item.id+':'+index,src=imageCache.get(selected+':'+key);
  html+='<div class="media">'+(m.kind==='image'?'<button class="image-button" data-image="'+index+'" aria-label="View '+esc(m.name)+'">'+(src?'<img src="'+esc(src)+'" alt="'+esc(m.name)+'">':'<div class="image-label" data-load="'+index+'">Loading image…</div>')+'</button>':'<button class="file" data-open>↗ '+esc(m.name)+' <span class="muted">Open in Grok Bot</span></button>')+'</div>';
 }
 if(item.choice){const w=item.choice,settled=item.state==='pending'?answers.get(selected+':'+item.id):null,st=effectiveState(item);
  html+='<section class="request" aria-label="'+esc(w.prompt)+'"><div class="request-title"><span>'+esc(w.prompt)+'</span>'+(st==='pending'?'<button class="dismiss" data-dismiss aria-label="Dismiss question">×</button>':'')+'</div>';
  if(st!=='pending')html+='<div class="resolved">'+(st==='dismissed'?'Dismissed':'✓ '+esc((settled?.answer||item.answer||'Answered').split('\n').map(v=>w.options.find(o=>(w.multiSelect?o.value.replace(/\s*\n\s*/g,' ').trim():o.value)===v)?.label||v).join(', ')))+'</div>';
  else{const chosen=selection.get(selected+':'+item.id)||new Set();html+='<div class="choices">'+w.options.map((o,i)=>'<button class="option" data-choice="'+i+'" aria-pressed="'+chosen.has(i)+'"><span class="key">'+(w.multiSelect?(chosen.has(i)?'✓':'□'):String.fromCharCode(65+i))+'</span><span class="option-text">'+esc(o.label)+(o.description?'<small class="option-description">'+esc(o.description)+'</small>':'')+'</span></button>').join('')+'</div>';
   if(w.allowCustom)html+='<div class="custom"><input data-custom placeholder="Your answer" aria-label="Your answer" value="'+esc(drafts.get(selected+':'+item.id)||'')+'"></div>';
   if(w.multiSelect||w.allowCustom)html+='<button class="action" data-submit>Submit</button>';
  }html+='</section>';
 }
 if(item.request){const r=item.request,st=item.state;
  html+='<section class="request" data-request-state="'+esc(st)+'"><div class="request-title"><span>'+esc(r.title)+'</span>'+(r.statusLabel?'<small class="request-status '+(['denied','failed'].includes(st)?'error':st==='resolved'?'success':'')+'">'+esc(r.statusLabel)+'</small>':'')+'</div>'+(r.description?'<p>'+esc(r.description)+'</p>':'');
  if(r.details?.length)html+='<details class="request-details"><summary>View the full request</summary><dl>'+r.details.map(([label,value])=>'<dt>'+esc(label)+'</dt><dd>'+esc(value)+'</dd>').join('')+'</dl></details>';
  if(r.footer)html+='<div class="muted request-footer">'+esc(r.footer)+'</div>';
  if(st==='pending'||st==='unknown')html+='<div class="muted">'+(st==='unknown'?'Check the current status in Grok Bot.':/secret|credential|connect|cookie/.test(r.type)?'Finish securely in Grok Bot. This card updates when you return.':'Review this request in Grok Bot.')+'</div><button class="action" data-open>'+(/secret|credential|connect|cookie/.test(r.type)?'Authenticate in Grok Bot':'Open in Grok Bot')+'</button>';
  html+='</section>';
 }
 return html;
}
function drawHeader(){const b=bot(selected),waiting=typeof b.attention==='boolean'?b.attention:items.some(waitingOn),identity={...b,attention:waiting};head.innerHTML=(selected?'<button class="round" data-back aria-label="Back to bots">‹</button>'+avatar(b,working(identity))+'<div class="identity"><div class="name">'+esc(b.name)+'</div>'+(b.isGroup?'<div class="muted">Group · '+(b.members||[]).length+' bots</div>':'')+'<span class="status sr-only">'+(waiting?'Needs your attention':state(b))+'</span></div>'+marker(identity)+(b.isGroup?'':'<button class="round" data-computer aria-label="Open computer" title="Open computer">▣</button>'):'<div class="identity">'+brand+'</div>');}
function drawList(){list.innerHTML=[...bots,...groups].sort((a,b)=>(b.lastActivityAt||0)-(a.lastActivityAt||0)).map(b=>'<button class="bot-row" data-bot="'+esc(b.id)+'" aria-label="'+esc(b.name)+(b.isGroup?', group chat':'')+(working(b)?', working':'')+'">'+avatar(b,working(b))+'<div class="identity"><div class="name">'+esc(b.name)+(b.isGroup?' <span class="muted">Group</span>':'')+'</div><div class="preview">'+esc(b.task||b.last||b.label||'')+'</div></div>'+marker(b)+'</button>').join('')||'<div class="empty">No bots or group chats yet.</div>';}
function drawMessages(force=false){
 items=items.map(i=>cachedEntry(selected,i));
 const nearBottom=messages.scrollHeight-messages.clientHeight-messages.scrollTop<70;
 const version=JSON.stringify([items,before,Array.from(answers)]);if(!force&&revision===version){drawHeader();observeDeferred();return;}revision=version;
 const oldTop=messages.scrollTop,oldHeight=messages.scrollHeight;
 const anchor=[...messages.querySelectorAll('.entry')].find(n=>n.getBoundingClientRect().bottom>messages.getBoundingClientRect().top+1),anchorTop=anchor?.getBoundingClientRect().top;
 const nodes=new Map([...messages.querySelectorAll('.entry')].map(n=>[n.dataset.entry,n]));
 const frag=document.createDocumentFragment();
 if(before!=null){const load=document.createElement('button');load.className='load';load.dataset.older='';load.textContent='Load earlier messages';frag.append(load);}
 for(const item of items){let el=nodes.get(item.id);const sig=JSON.stringify([item,answers.get(selected+':'+item.id)]);if(!el){el=document.createElement('div');el.className='entry';el.dataset.entry=item.id;}if(el.dataset.signature!==sig){el.innerHTML=itemHtml(item);el.dataset.signature=sig;}frag.append(el);}
 if(!items.length){const empty=document.createElement('div');empty.className='empty';empty.textContent='No messages yet.';frag.append(empty);}
 messages.replaceChildren(frag);messages.scrollTop=force||nearBottom?messages.scrollHeight:oldTop+(loadingOlder?messages.scrollHeight-oldHeight:0);
 if(!force&&!nearBottom&&!loadingOlder&&anchor?.isConnected)messages.scrollTop+=anchor.getBoundingClientRect().top-anchorTop;
 messages.querySelectorAll('[data-load]').forEach(el=>imageObserver.observe(el));
 observeDeferred();drawHeader();
}
let loadingOlder=false;
${composerRuntime}
function show(id){toggleMenu(false);info('');if(selected)drafts.set(selected,input.value);selected=id;revision='';before=undefined;items=id?data.threads?.[id]||((args.bot===id||args.group===id)?data.thread||[]:[]):[];input.value=drafts.get(id)||((args.bot===id||args.group===id)?args.message||'':'');input.placeholder='Message '+bot(id).name;list.hidden=!!id;messages.hidden=!id;composer.hidden=!id;drawHeader();if(id)drawMessages(true);else drawList();refresh();drawFiles();if(canInvoke&&id)recoverFiles();}
async function refresh(older=false){
 clearTimeout(refreshTimer);if(!canInvoke||busyAction||fileWorking()||!teacher.hidden||disposed)return;
 const id=selected;loadingOlder=older;
 try{const body=await invoke('grokbot_card_snapshot',{...(id?{bot:id}:{}),...(older&&before!=null?{beforeSeq:before}:{})});if(selected!==id)return;
 bots=body.bots||bots;groups=body.groups?body.groups.map(g=>({...g,isGroup:true})):groups;
 if(!id){info('');drawList();return;}
 if(older){const seen=new Set(items.map(i=>i.id));items=[...(body.thread||[]).filter(i=>!seen.has(i.id)),...items];before=body.nextBeforeSeq;}
 else{items=items.filter(i=>!i.receipt);const fresh=(body.thread||[]).map(i=>cachedEntry(id,i)),byId=new Map(fresh.map(i=>[i.id,i]));for(const previous of items){const updated=byId.get(previous.id);if(updated&&JSON.stringify(updated.choice)!==JSON.stringify(previous.choice)){selection.delete(id+':'+previous.id);drafts.delete(id+':'+previous.id);}}items=items.length?items.map(i=>byId.get(i.id)||i):fresh;const known=new Set(items.map(i=>i.id));items.push(...fresh.filter(i=>!known.has(i.id)));if(before===undefined)before=body.nextBeforeSeq;}
 if(uncertain){uncertain=false;send.disabled=!input.value.trim();}info('');drawMessages();updateSend();
 }catch(e){if(selected===id)info(e.message);}finally{loadingOlder=false;if(selected===id&&requests<48&&!disposed)refreshTimer=setTimeout(()=>{if(!document.hidden)refresh();},15000);else if(selected===id&&requests>=48)info('Live updates paused. Open this conversation again in VoiceOS to continue.');}
}
function cachedEntry(botId,item){const cached=fullEntries.get(botId+':'+item.id);return item.deferred&&cached?.version===item.deferred.version?cached.item:item;}
function observeDeferred(){messages.querySelectorAll('[data-deferred]').forEach(el=>entryObserver.observe(el));}
const entryObserver=new IntersectionObserver(entries=>{for(const e of entries)if(e.isIntersecting){entryObserver.unobserve(e.target);loadEntry(e.target);}}, {root:messages,rootMargin:'160px'});
async function loadEntry(el){
 const id=selected,entryId=el.closest('[data-entry]')?.dataset.entry,item=items.find(i=>i.id===entryId);
 if(!item?.deferred||!canInvoke||disposed)return;
 const key=id+':'+entryId,loadKey=key+':'+item.deferred.version;if(entryLoads.has(loadKey))return;entryLoads.add(loadKey);
 let offset=0,version=item.deferred.version,parts='',restarts=0;
 try{
  do{
   const body=await invoke('grokbot_card_entry',{bot:id,entryId,offset,version});if(selected!==id||disposed)return;
   if(body.entryId!==entryId||typeof body.chunk!=='string'||typeof body.version!=='string')throw Error('Could not load this message.');
   if(body.offset===0&&offset>0){if(++restarts>2)throw Error('This message is still updating.');parts='';offset=0;}
   if(body.offset!==offset||(offset>0&&body.version!==version))throw Error('This message changed while loading.');
   version=body.version;parts+=body.chunk;
   if(body.nextOffset===null)break;
   if(body.nextOffset!==offset+body.chunk.length||body.nextOffset<=offset)throw Error('Could not load this message.');
   offset=body.nextOffset;
  }while(true);
  const full=JSON.parse(parts);if(full.id!==entryId||full.deferred)throw Error('Could not load this message.');
  if(fullEntries.size>=32)fullEntries.delete(fullEntries.keys().next().value);fullEntries.set(key,{version,item:full});
  items=items.map(i=>i.id===entryId&&i.deferred&&[item.deferred.version,version].includes(i.deferred.version)?full:i);
  drawMessages();
 }catch(e){if(selected===id&&el.isConnected)el.textContent='Message could not finish loading. Retrying automatically…';}
 finally{entryLoads.delete(loadKey);}
}
const imageObserver=new IntersectionObserver(entries=>{for(const e of entries)if(e.isIntersecting){imageObserver.unobserve(e.target);loadImage(e.target);}}, {root:messages,rootMargin:'80px'});
async function loadImage(el){const row=el.closest('[data-entry]'),id=selected,index=Number(el.dataset.load),item=items.find(i=>i.id===row?.dataset.entry);if(!item||!canInvoke)return;const key=id+':'+item.id+':'+index;
 try{const result=await invoke('grokbot_card_image',{bot:id,entryId:item.id,index});if(!/^data:image\/(png|jpeg|webp|gif);base64,/.test(result.dataUrl||''))throw Error('Image unavailable.');imageCache.set(key,result.dataUrl);if(el.isConnected&&selected===id){const img=document.createElement('img');img.src=result.dataUrl;img.alt=item.media[index].name;const pinned=messages.scrollHeight-messages.clientHeight-messages.scrollTop<80;img.addEventListener('load',()=>{if(pinned)messages.scrollTop=messages.scrollHeight;});el.replaceWith(img);}}
 catch(e){if(el.isConnected){el.textContent='Image unavailable · Open in Grok Bot';el.removeAttribute('data-load');el.parentElement.dataset.open='';}}
}
async function action(item,action,values=[],custom=''){
 if(busyAction||uncertain)return;busyAction=true;const id=selected;info(action==='open'?'Opening Grok Bot…':'Sending response…');
 try{const response=await invoke('grokbot_card_action',{bot:id,...(item?{entryId:item.id}:{}),action,values,custom});if(action!=='open')answers.set(id+':'+item.id,{state:response.state,answer:[...values,custom].filter(Boolean).join('\n')});info(action==='open'?'Complete the request in Grok Bot, then return here.':'');drawMessages();}
 catch(e){uncertain=!!e.unknown;info(e.message);}finally{busyAction=false;refresh();}
}
async function openComputer(button){const id=selected;if(!id||bot(id).isGroup)return;button.disabled=true;info('Opening computer…');try{const r=await invoke('grokbot_open_computer_window',{bot:id});if(selected===id)info(r.opened?'':r.message||'Computer unavailable.');}catch(e){if(selected===id)info(e.message);}finally{button.disabled=false;}}
async function sendMessage(){if(hasFiles()){sendFiles();return;}const submitted=input.value,text=submitted.trim();if(!text||busyAction||uncertain)return;const id=selected;busyAction=true;send.disabled=true;info('Sending…');
 try{const response=await invoke('grokbot_card_send',{bot:id,message:text});if(response?.sent!==true)throw Error(response?.message||'Delivery was not confirmed.');if(selected===id&&input.value===submitted)input.value='';if(drafts.get(id)===submitted)drafts.delete(id);info('');}
 catch(e){uncertain=!!e.unknown;info(e.message);}finally{busyAction=false;updateSend();refresh();}}
document.addEventListener('click',e=>{const t=e.target.closest('button,a');if(!t)return;
 if(t.tagName==='A'){e.preventDefault();if(t.href.startsWith('https://'))parent.postMessage({type:'voiceos:openUrl',url:t.href},'*');return;}
 const item=items.find(i=>i.id===t.closest('[data-entry]')?.dataset.entry);
 if(t.hasAttribute('data-computer')){openComputer(t);return;}
 if(t.hasAttribute('data-back')){show(null);return;}if(t.dataset.bot){show(t.dataset.bot);return;}
 if(t.hasAttribute('data-older')){refresh(true);return;}if(t.hasAttribute('data-open')){action(item,'open');return;}
 if(composerClick(t))return;if(t.id==='send'){sendMessage();return;}
 if(t.hasAttribute('data-dismiss')){action(item,'dismiss');return;}
 if(t.hasAttribute('data-choice')){const i=Number(t.dataset.choice);if(!item?.choice)return;if(item.choice.multiSelect){const key=selected+':'+item.id,set=selection.get(key)||new Set();set.has(i)?set.delete(i):set.add(i);selection.set(key,set);t.setAttribute('aria-pressed',String(set.has(i)));t.querySelector('.key').textContent=set.has(i)?'✓':'□';}else action(item,'answer',[item.choice.options[i].value]);return;}
 if(t.hasAttribute('data-submit')){if(!item?.choice)return;const set=selection.get(selected+':'+item.id)||new Set();action(item,'answer',[...set].map(i=>item.choice.options[i].value),drafts.get(selected+':'+item.id)||'');return;}
 if(t.hasAttribute('data-image')){const src=imageCache.get(selected+':'+item?.id+':'+t.dataset.image);if(!src){action(item,'open');return;}const box=$('.lightbox');box.innerHTML='<button class="round" data-close aria-label="Close image">×</button><img src="'+esc(src)+'" alt="'+esc(item.media[Number(t.dataset.image)].name)+'"><button class="action" data-open>Open original in Grok Bot</button>';box.hidden=false;return;}
 if(t.hasAttribute('data-close'))$('.lightbox').hidden=true;
});
input.addEventListener('input',()=>{updateSend();drafts.set(selected,input.value);});
input.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();sendMessage();}});
messages.addEventListener('input',e=>{if(e.target.hasAttribute('data-custom'))drafts.set(selected+':'+e.target.closest('[data-entry]').dataset.entry,e.target.value);});
document.addEventListener('keydown',e=>{if(e.key==='Escape'){toggleMenu(false);$('.lightbox').hidden=true;if(!teacher.hidden)closeTeach();return;}if(!teacher.hidden||!menu.hidden)return;if(e.target.closest('input,textarea,[contenteditable]')||e.metaKey||e.ctrlKey||e.altKey)return;const item=[...items].reverse().find(i=>i.choice&&effectiveState(i)==='pending');const n=e.key.toUpperCase().charCodeAt(0)-65;if(item&&!item.choice.multiSelect&&e.key.length===1&&n>=0&&n<item.choice.options.length){e.preventDefault();action(item,'answer',[item.choice.options[n].value]);}});
document.addEventListener('visibilitychange',()=>{if(document.hidden)clearTimeout(refreshTimer);else if(requests<48)refresh();});
addEventListener('pagehide',()=>{disposed=true;clearTimeout(refreshTimer);clearTimeout(fileTimer);clearTimeout(teachTimer);clearInterval(tickTimer);disconnectComputer();imageObserver.disconnect();entryObserver.disconnect();});
show(selected);report();
})();
`;

export function renderConversationCard(payload: {
  data?: unknown;
  args?: unknown;
}) {
  const json = JSON.stringify({ ...payload, mark: MARK_DATA_URI })
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
  return `<!doctype html><meta charset="utf-8"><title>Grok Bot</title><style>${avatarCss}\n${css}\n${markdownCss}\n${composerCss}</style><div class="card"><header class="header"></header><div class="list"></div><div class="messages" role="log" aria-label="Conversation"></div><div class="notice" role="status" hidden></div>${composerHtml}<div class="composer">${composerMenuHtml}<button class="round" id="attach" aria-label="Add to message" aria-haspopup="menu" aria-expanded="false" aria-controls="composer-menu">+</button><textarea id="message" aria-label="Message" placeholder="Message"></textarea><button class="send" id="send" aria-label="Send" disabled>↑</button></div>${teachHtml}<div class="lightbox" hidden></div></div><script type="application/json" id="payload">${json}</script><script>${conversationRuntime}</script>`;
}

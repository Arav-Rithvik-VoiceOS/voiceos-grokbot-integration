/* LiveChat: the live conversation in Arav's thread + show cards (refresh, earlier messages, lazy
   images, requests, choices, deferred messages, Open computer). Rows use the card's own markup. */
const LiveChat=(()=>{
 const END={completed:1,failed:1,cancelled:1,unknown:1},GAP=15e3,CAP=48,BUDGET=56,HARD=62;
 // requestState.ts's passive types: connection prompts stay in history after they are done.
 const PASSIVE=/^(connectors?|listener-connect|scm-connect|onepassword-connect|team-access|slack-connect|cursor-agent|bot-template-share)$/;
 const DATA=/^data:image\/(png|jpeg|webp|gif);base64,/,UNSURE='The result is unconfirmed. Check Grok Bot before trying again.',OPEN='Open in Grok Bot';
 const PC='<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg>';
 const DOC='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5"/></svg>';
 const h=s=>String(s??'').replace(/[&<>"']/g,c=>'&#'+c.charCodeAt(0)+';');
 const fail=(msg,x)=>Object.assign(new Error(msg||'That didn’t go through.'),x);
 const num=v=>typeof v==='number'&&isFinite(v)?v:null,noop=()=>Promise.resolve();
 // Per document, so a reopened show-card pane reuses what it loaded.
 const IMG=new Map(),FULL=new Map(),keep=(m,k,v)=>{if(m.size>=32)m.delete(m.keys().next().value);m.set(k,v)};
 let anon=0;

 // Exact port of cards.ts relTime().
 function relTime(ms){if(!ms)return '';const min=Math.floor((Date.now()-ms)/60000);if(min<1)return 'now';if(min<60)return min+'m';
  const hr=Math.floor(min/60);if(hr<24)return hr+'h';const day=Math.floor(hr/24);if(day===1)return 'Yesterday';
  if(day<7)return new Date(ms).toLocaleDateString(undefined,{weekday:'short'});return new Date(ms).toLocaleDateString(undefined,{month:'short',day:'numeric'})}

 function unpack(r){const t=r&&Array.isArray(r.content)&&r.content.find(b=>b&&b.type==='text');
  if(r&&r.isError)throw fail(t&&t.text||'Grok Bot could not complete this request.',{status:'failed'});
  if(r&&r.structuredContent)return r.structuredContent;
  if(t&&typeof t.text==='string'){try{return JSON.parse(t.text)}catch(_){throw fail(t.text,{status:'failed'})}}
  return r||{}}

 // One serialized invoke queue per card document; only its own 'lc_' requestIds are read.
 function bridge(o){let can=!!(o&&o.canInvoke),seq=0,chain=Promise.resolve();const wait=new Map(),ready=new Set();
  addEventListener('message',e=>{const m=e.data;if(e.source!==parent||!m||m.type!=='voiceos:toolResult'||!END[m.status])return;
   const p=wait.get(m.requestId);if(!p)return;wait.delete(m.requestId);clearTimeout(p.t);const s=m.status;
   if(s!=='completed')return p.no(fail(s==='unknown'?UNSURE:m.error||(s==='cancelled'?'Cancelled.':''),{status:s,unknown:s==='unknown'}));
   if(m.resultOmitted)return p.no(fail('The result was too large for this card.',{status:'unknown',unknown:true}));
   try{const b=unpack(m.result);if(b&&b.ok===false)throw fail(b.message,{status:'failed'});p.ok(b||{})}catch(err){p.no(err)}});
  const b={count:0,refreshes:0,
   get canInvoke(){return can},
   set canInvoke(v){const was=can;can=!!v;if(can&&!was)ready.forEach(f=>{try{f()}catch(_){}})},
   onReady(f){ready.add(f);return()=>ready.delete(f)},
   call(name,args,opt){const run=()=>new Promise((ok,no)=>{
     if(!can)return no(fail('Open this card again to reconnect to Grok Bot.',{status:'failed'}));
     if(b.count>=HARD)return no(fail('Open a fresh Grok Bot card to continue.',{status:'failed'}));
     b.count++;const id='lc_'+Date.now().toString(36)+'_'+(++seq);
     // A timed-out call may already have acted: it rejects as unconfirmed and is never retried.
     const t=setTimeout(()=>{if(wait.delete(id))no(fail(UNSURE,{status:'unknown',unknown:true}))},(opt&&opt.timeoutMs)||6e4);
     wait.set(id,{ok,no,t});parent.postMessage({type:'voiceos:invokeTool',name,args:args||{},requestId:id},'*')});
    const p=chain.then(run);chain=p.catch(()=>{});return p}};
  return b}

 function mount(o){
  const br=o&&o.bridge,list=o&&o.list,T=(o&&o.target)||{},bot=T.id;
  if(!br||!list||!bot)return {refresh:noop,loadOlder:noop,openComputer:noop,destroy(){},items:()=>[],nextBeforeSeq:()=>null};
  const say=(m,bad)=>{try{o.statusLine&&o.statusLine(m||'',!!bad)}catch(_){}};
  const rep=()=>{try{typeof report==='function'&&report()}catch(_){}};
  const key=(...a)=>bot+':'+a.join(':'),ui=new Map(),busyK=new Set(),bad=new Set();
  const norm=a=>{const seen=new Set();return (Array.isArray(a)?a:[]).filter(i=>i&&typeof i==='object').map(i=>{const {t,...r}=i;r.id=r.id==null?'lc-anon-'+(++anon):String(r.id);return r}).filter(i=>!seen.has(i.id)&&seen.add(i.id))};
  let items=norm(o.items),before=num(o.nextBeforeSeq),stick=true,dead=false,timer=0,busy=null,older=false,paused=false,erred=false,said=false;
  const el=(tag,cls,text)=>{const e=document.createElement(tag);e.className=cls;if(text)e.textContent=text;return e};
  const top=el('button','sys lc-older','Earlier messages'),end=el('div','sys lc-paused','Live updates paused. Open this conversation again to continue.');
  let pc=null;
  if(o.header&&!T.isGroup){pc=el('button','lc-pc');pc.title='Open computer';pc.setAttribute('aria-label','Open computer');pc.innerHTML=PC;
   const wm=o.header.querySelector('.mark');wm?wm.before(pc):o.header.append(pc);pc.addEventListener('click',()=>openComputer())}

  const view=it=>it.deferred&&FULL.get(key(it.id,it.deferred.version))||it;
  const st8=id=>{let u=ui.get(id);if(!u)ui.set(id,u={sel:new Set(),custom:'',v:0});return u};
  const link=(from,t)=>'<button class="sys lc-link '+from+'" data-lc-open>'+h(t)+'</button>';
  const mk=(m,f,i)=>key(m.id,Number.isInteger(f.index)?f.index:i),fs=m=>Array.isArray(m.media)?m.media:[];
  const word=s=>({dismissed:'Dismissed',expired:'Expired',denied:'Denied',failed:'Failed',cancelled:'Cancelled',unknown:'Status unavailable'}[s]||'Answered');
  const label=(c,a)=>String(a||'').split('\n').map(v=>{const x=(c.options||[]).find(x=>x.value===v||c.multiSelect&&String(x.value).replace(/\s*\n\s*/g,' ').trim()===v);return x?x.label||x.value:v}).filter(Boolean).join(', ');

  function media(m){return fs(m).map((f,i)=>{const k=mk(m,f,i),nm=h(f.name||'Attachment');
   if(f.kind!=='image')return '<button class="chip lc-file '+m.from+'" data-lc-open title="'+OPEN+'">'+DOC+'<span>'+nm+'</span></button>';
   if(IMG.has(k))return '<img class="lc-img '+m.from+'" src="'+h(IMG.get(k))+'" alt="'+nm+'">';
   if(bad.has(k))return link(m.from,'Image unavailable · '+OPEN);
   return '<div class="lc-img lc-ph '+m.from+'" data-lc-img="'+k.slice(k.lastIndexOf(':')+1)+'" role="img" aria-label="'+nm+'"><span>'+nm+'</span></div>'}).join('')}
  function choice(m){const c=m.choice;if(!c||typeof c!=='object')return '';const u=ui.get(m.id)||{},st=u.done?u.done.state:m.state||'pending',opts=Array.isArray(c.options)?c.options:[];
   let s='<div class="lc-card '+m.from+(st==='pending'?' lc-att':'')+'"><div class="lc-q"><span>'+h(c.prompt||'Choose an answer')+'</span></div>';
   if(st!=='pending'){const a=label(c,u.done?u.done.answer:m.answer);return s+'<div class="lc-ans">'+(st==='resolved'?'Answered'+(a?' · '+h(a):''):word(st))+'</div></div>'}
   const sel=u.sel||new Set(),off=u.busy||u.locked?' disabled':'';
   s+='<div class="lc-opts" role="group">'+opts.map((x,i)=>'<button class="lc-opt" data-lc-opt="'+i+'" aria-pressed="'+sel.has(i)+'"'+off+'><span class="lc-k">'+(c.multiSelect?(sel.has(i)?'✓':''):String.fromCharCode(65+i%26))+'</span><span class="lc-ot">'+h(x&&(x.label||x.value))+(x&&x.description?'<small>'+h(x.description)+'</small>':'')+'</span></button>').join('')+'</div>';
   if(c.allowCustom)s+='<input class="lc-in" data-lc-custom placeholder="Your answer" aria-label="Your answer" autocomplete="off" value="'+h(u.custom)+'"'+off+'>';
   return s+'<div class="lc-row">'+(c.multiSelect||c.allowCustom?'<button class="lc-btn pri" data-lc-send'+off+'>Send</button>':'')+'<button class="lc-btn" data-lc-dismiss'+off+'>Dismiss</button></div></div>'}
  function request(m){const r=m.request;if(!r||typeof r!=='object')return '';const pend=m.state==='pending';
   let s='<div class="lc-card '+m.from+(pend&&r.attention?' lc-att':'')+'"><div class="lc-q"><span>'+h(r.title||'Request')+'</span>'+(r.statusLabel?'<span class="chip">'+h(r.statusLabel)+'</span>':'')+'</div>';
   if(r.description)s+='<div class="lc-d">'+h(r.description)+'</div>';
   if(Array.isArray(r.details)&&r.details.length)s+='<dl class="lc-kv">'+r.details.slice(0,6).map(p=>'<dt>'+h(p&&p[0])+'</dt><dd>'+h(p&&p[1])+'</dd>').join('')+'</dl>';
   if(r.footer)s+='<div class="lc-f">'+h(r.footer)+'</div>';
   // Sign-ins and approvals finish in Grok Bot's own window: secrets never pass through VoiceOS, which logs tool calls.
   if(pend&&!(r.passive===true||PASSIVE.test(r.type||'')))s+='<div class="lc-row"><button class="lc-btn pri" data-lc-open="entry">'+OPEN+'</button>'+(/secret|credential|cookie/.test(r.type||'')?'<span class="lc-f">Sign in there, not here.</span>':'')+'</div>';
   return s+'</div>'}
  function html(v){const m={...v,from:v.from==='me'?'me':'bot'},t=relTime(v.timestampMs);
   if(t)m.t=t;if(m.sys==='')return '';
   if(m.deferred){m.text=String(m.text||'').trim()+'…';delete m.html}
   let s='';try{s=o.renderItem(m)||''}catch(_){}
   if(typeof m.sys==='string')return s;
   return s+media(m)+choice(m)+request(m)+(m.deferred&&bad.has(key(m.id,m.deferred.version))?link(m.from,'This message did not load · '+OPEN):'')}
  // Everything a row's markup depends on, so draw() re-renders exactly the rows that changed.
  const sig=v=>JSON.stringify(v)+relTime(v.timestampMs)+'|'+(ui.get(v.id)||{v:0}).v+(v.deferred&&bad.has(key(v.id,v.deferred.version))?'!':'')+fs(v).map((f,i)=>{const k=mk(v,f,i);return IMG.has(k)?'i':bad.has(k)?'x':'-'}).join('');

  // Pinned to the newest message until the user scrolls up (also true before the frame has any layout).
  const near=()=>list.scrollHeight-list.clientHeight-list.scrollTop<=24,bottom=()=>{list.scrollTop=list.scrollHeight};
  const onScroll=()=>{stick=near()},rsz=typeof ResizeObserver==='function'?new ResizeObserver(()=>{if(stick&&!dead)bottom()}):null;
  function anchor(){const y=list.getBoundingClientRect().top;for(const w of list.children){if(!w.dataset.lc)continue;const k=w.children;
   for(let i=0;i<k.length;i++){const r=k[i].getBoundingClientRect();if(r.bottom>y+1)return {id:w.dataset.lc,i,top:r.top}}}return null}
  function draw(mode){if(dead)return;
   const pin=stick,h0=list.scrollHeight,y0=list.scrollTop,a=mode?null:anchor();
   const old=new Map([...list.children].filter(n=>n.dataset.lc).map(n=>[n.dataset.lc,n]));
   const nodes=items.map(it=>{const v=view(it),s=sig(v);let n=old.get(it.id);if(n&&n.dataset.s===s)return n;
    const fresh=!n;if(fresh){n=el('div','');n.dataset.lc=it.id}
    n.dataset.s=s;n.innerHTML=html(v);
    if(!v.html&&!v.text)n.querySelectorAll('.bubble').forEach(b=>{if(!b.firstChild)b.remove()});
    if(!fresh)n.querySelectorAll('.fade-in').forEach(x=>x.classList.remove('fade-in'));
    if(v.deferred){const b=[...n.querySelectorAll('.bubble')].pop();if(b&&!bad.has(key(v.id,v.deferred.version)))b.dataset.lcDef=''}
    n.querySelectorAll('img').forEach(i=>i.complete||i.addEventListener('load',()=>{if(stick&&!dead)bottom();rep()},{once:true}));
    return n});
   // Rows the card appended itself (optimistic send bubbles) stay after the conversation.
   const rest=[...list.children].filter(n=>!n.dataset.lc&&n!==top&&n!==end&&!(items.length&&n.classList.contains('empty')));
   top.hidden=before==null;
   const want=[top,...nodes,...rest];if(paused)want.push(end);
   // Move only what changed, so a focused answer field keeps focus across refreshes.
   let ref=list.firstChild;for(const n of want){if(n===ref)ref=ref.nextSibling;else list.insertBefore(n,ref)}
   while(ref){const nx=ref.nextSibling;ref.remove();ref=nx}
   if(mode==='older')list.scrollTop=y0+(list.scrollHeight-h0);
   else if(mode==='bottom'||pin){stick=true;bottom()}
   else if(a){const w=[...list.children].find(n=>n.dataset.lc===a.id),e=w&&(w.children[a.i]||w.firstElementChild);if(e)list.scrollTop+=e.getBoundingClientRect().top-a.top}
   scan();rep()}

  const load=t=>t.dataset.lcImg!=null?loadImg(t):loadEntry(t);
  const io=typeof IntersectionObserver==='function'?new IntersectionObserver(es=>es.forEach(e=>{if(e.isIntersecting&&!dead&&br.canInvoke){io.unobserve(e.target);load(e.target)}}),{root:list,rootMargin:'80px'}):null;
  function scan(){if(!dead)list.querySelectorAll('[data-lc-img],[data-lc-def]').forEach(t=>{if(io){io.unobserve(t);io.observe(t)}else if(br.canInvoke)load(t)})}
  const itemOf=t=>{const w=t.closest('[data-lc]');return w&&items.find(i=>i.id===w.dataset.lc)};

  async function loadImg(t){const it=itemOf(t),ix=+t.dataset.lcImg;if(!it||!br.canInvoke)return;const k=key(it.id,ix);
   if(busyK.has(k))return;if(IMG.has(k)||bad.has(k))return draw();busyK.add(k);
   try{const b=await br.call('grokbot_card_image',{bot,entryId:it.id,index:ix});if(!DATA.test(b&&b.dataUrl||''))throw 0;keep(IMG,k,b.dataUrl)}
   catch(_){bad.add(k)}
   busyK.delete(k);draw()}
  // Every chunk comes from one version, in order; a changed message restarts at 0 (twice at most).
  async function loadEntry(t){const it=itemOf(t);if(!it||!it.deferred||!br.canInvoke)return;const v0=it.deferred.version,k=key(it.id,v0);
   if(FULL.has(k)||busyK.has(k)||bad.has(k))return;busyK.add(k);let offset=0,version=v0,parts='',restarts=0;
   try{for(;;){const b=await br.call('grokbot_card_entry',{bot,entryId:it.id,offset,version});if(dead)return;
     if(!b||b.entryId!==it.id||typeof b.chunk!=='string'||typeof b.version!=='string'||typeof b.offset!=='number')throw 0;
     if(b.version!==version||b.offset!==offset){if(++restarts>2)throw 0;version=b.version;parts='';offset=0;if(b.offset)continue}
     parts+=b.chunk;if(b.nextOffset==null)break;if(!(b.nextOffset>offset))throw 0;offset=b.nextOffset}
    const full=JSON.parse(parts);if(!full||String(full.id)!==it.id||full.deferred)throw 0;
    delete full.t;full.id=it.id;keep(FULL,k,full);if(version!==v0)keep(FULL,key(it.id,version),full)}
   catch(_){bad.add(k)}
   finally{busyK.delete(k);draw()}}

  function bots(b){if(o.onBots&&(Array.isArray(b.bots)||Array.isArray(b.groups)))try{o.onBots(b.bots||[],b.groups||[])}catch(_){}}
  const over=()=>br.refreshes>=CAP||br.count>=BUDGET;
  function pause(){if(paused||dead)return;paused=true;clearTimeout(timer);timer=0;draw();try{o.paused&&o.paused()}catch(_){}}
  function schedule(){clearTimeout(timer);timer=0;if(!dead&&!paused&&br.canInvoke&&document.visibilityState!=='hidden')timer=setTimeout(()=>{timer=0;refresh()},GAP)}
  function refresh(){if(dead)return noop();if(!list.isConnected){destroy();return noop()}
   if(busy)return busy;if(!br.canInvoke)return noop();if(over()){pause();return noop()}
   clearTimeout(timer);timer=0;br.refreshes++;
   busy=br.call('grokbot_card_snapshot',{bot}).then(b=>{if(dead)return;const fresh=norm(b.thread),ids=new Set(fresh.map(i=>i.id)),at=items.findIndex(i=>ids.has(i.id));
     // Loaded older rows stay above the newest page; a page with no overlap replaces them (the gap is "Earlier messages").
     const kept=at<0?[]:items.slice(0,at).filter(i=>!ids.has(i.id)&&!i.id.startsWith('lc-anon-'));
     items=[...kept,...fresh];if(!kept.length)before=num(b.nextBeforeSeq);
     bots(b);if(erred){erred=false;say('')}draw()})
    .catch(e=>{if(!dead){erred=true;say(e.message,true)}})
    .finally(()=>{busy=null;if(!dead)over()?pause():schedule()});
   return busy}
  function loadOlder(){if(dead||older||before==null||!br.canInvoke)return noop();older=top.disabled=true;top.textContent='Loading…';
   return br.call('grokbot_card_snapshot',{bot,beforeSeq:before}).then(b=>{if(dead)return;const have=new Set(items.map(i=>i.id));
     items=[...norm(b.thread).filter(i=>!have.has(i.id)),...items];before=num(b.nextBeforeSeq);bots(b);draw('older')})
    .catch(e=>{if(!dead)say(e.message,true)})
    .finally(()=>{older=top.disabled=false;top.textContent='Earlier messages'})}

  async function openComputer(){if(dead||!br.canInvoke)return;if(pc)pc.disabled=true;
   try{const r=await br.call('grokbot_open_computer_window',{bot});if(dead)return;
    if(r&&r.opened===false){said=true;say(r.message||'The computer is not running right now.',true)}else if(said){said=false;say('')}}
   catch(e){if(!dead){said=true;say(e.message,true)}}
   if(pc)pc.disabled=false}
  async function act(v,action,btn,values,custom){const u=v&&v.choice&&action!=='open'?st8(v.id):null;if(u&&(u.busy||u.locked))return;
   if(u){u.busy=true;u.v++;draw()}else if(btn)btn.disabled=true;
   say(action==='open'?'Opening Grok Bot…':action==='dismiss'?'Dismissing…':'Sending your answer…');
   try{const args={bot,action};if(v&&(u||v.request))args.entryId=v.id;if(action==='answer'){args.values=values;if(custom)args.custom=custom}
    const r=await br.call('grokbot_card_action',args);if(dead)return;
    say(action==='open'?'Finish in Grok Bot, then come back here.':'');
    if(u){u.done={state:r.state||(action==='dismiss'?'dismissed':'resolved'),answer:[...values||[],custom].filter(Boolean).join('\n')};refresh()}}
   catch(e){if(dead)return;if(u&&e.unknown)u.locked=true;say(u&&e.unknown?'Not confirmed. Check Grok Bot before answering again.':e.message,true)}
   if(u){u.busy=false;u.v++;draw()}else if(btn&&btn.isConnected)btn.disabled=false}

  function click(e){const t=e.target.closest('a[href],button');if(!t||!list.contains(t))return;
   if(t.tagName==='A'){e.preventDefault();if(/^https:\/\//i.test(t.href))parent.postMessage({type:'voiceos:openUrl',url:t.href},'*');return}
   if(t===top)return void loadOlder();
   if(t.disabled||!br.canInvoke)return;const it=itemOf(t),v=it&&view(it);
   if(t.hasAttribute('data-lc-open'))return void act(t.dataset.lcOpen==='entry'?v:null,'open',t);
   if(!v||!v.choice)return;const u=st8(v.id),c=v.choice,opts=c.options||[];
   if(t.dataset.lcOpt!=null){const i=+t.dataset.lcOpt;if(!opts[i])return;
    if(!c.multiSelect)return void act(v,'answer',t,[opts[i].value],'');
    u.sel.has(i)?u.sel.delete(i):u.sel.add(i);t.setAttribute('aria-pressed',u.sel.has(i));t.querySelector('.lc-k').textContent=u.sel.has(i)?'✓':'';return}
   if(t.hasAttribute('data-lc-send')){const vals=[...u.sel].sort((a,b)=>a-b).map(i=>opts[i]&&opts[i].value).filter(x=>x!=null),cu=u.custom.trim();
    if(!vals.length&&!cu)return say('Choose an answer first.',true);return void act(v,'answer',t,vals,cu)}
   if(t.hasAttribute('data-lc-dismiss'))act(v,'dismiss',t)}
  const onInput=e=>{if(e.target.matches('[data-lc-custom]')){const it=itemOf(e.target);if(it)st8(it.id).custom=e.target.value}};
  const onKey=e=>{if(e.key==='Enter'&&!e.isComposing&&e.target.matches('[data-lc-custom]')){e.preventDefault();const s=e.target.closest('.lc-card').querySelector('[data-lc-send]');if(s)s.click()}};
  const vis=()=>{if(dead)return;if(document.visibilityState==='hidden'){clearTimeout(timer);timer=0}else if(!timer&&!busy&&!paused)refresh()};
  const ro=()=>list.classList.toggle('lc-ro',!br.canInvoke);
  // A hidden card waits: vis() refreshes it once it is shown.
  const off=br.onReady?br.onReady(()=>{if(dead)return;ro();if(pc)pc.hidden=false;draw();if(document.visibilityState!=='hidden')refresh()}):null;
  const on=(t,f,x)=>(x||list)[dead?'removeEventListener':'addEventListener'](t,f);
  const wire=()=>{on('click',click);on('input',onInput);on('keydown',onKey);on('scroll',onScroll);on('visibilitychange',vis,document)};

  function destroy(){if(dead)return;dead=true;clearTimeout(timer);timer=0;if(io)io.disconnect();if(rsz)rsz.disconnect();if(off)off();wire();if(pc)pc.remove();top.remove();end.remove()}

  // Take over the list: keyed rows replace the handoff's first render (an empty-group note stays until messages arrive).
  [...list.childNodes].forEach(n=>{if(!(n.classList&&n.classList.contains('empty')&&!items.length))n.remove()});
  list.classList.add('lc-list');ro();if(pc)pc.hidden=!br.canInvoke;wire();if(rsz)rsz.observe(list);
  draw('bottom');schedule();
  return {refresh,loadOlder,destroy,openComputer,items:()=>items.map(view),nextBeforeSeq:()=>before}}

 return {bridge,relTime,mount};
})();

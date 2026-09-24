/* ComposerKit: the 1:1 composer's + menu (Attach files, Teach a task). Never sends on its own; the glue calls send(). */
const ComposerKit=(()=>{
 const MEM=new Map(); // per bot, per document: a remounted show-card pane keeps its chips, job and recording
 const UNSURE='Delivery is unconfirmed. Check Grok Bot before sending again.';
 // Polls spend the card's automatic request budget (shared with live refresh), so they back off and stop at 24;
 // the file picker waits on the user, so it gets fewer, slower polls. After that: Check status.
 const STEP=[1e3,1e3,1e3,2e3,2e3,3e3,5e3,8e3],POLLS=24,PICK=[3e3,5e3,8e3,10e3,12e3,15e3];
 const CLIP='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.5 11.5l-8.4 8.4a5.4 5.4 0 0 1-7.6-7.6l8.4-8.4a3.6 3.6 0 0 1 5.1 5.1l-8.4 8.4a1.8 1.8 0 0 1-2.5-2.5l7.7-7.7"/></svg>';
 const REC='<svg class="ck-r" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="4.2" fill="currentColor"/></svg>';
 const X='<svg width="8" height="8" viewBox="0 0 10 10" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><path d="M2 2l6 6M8 2L2 8"/></svg>';
 const h=s=>String(s??'').replace(/[&<>"']/g,c=>'&#'+c.charCodeAt(0)+';');
 const size=n=>(n=+n||0)<1024?n+' B':n<1048576?Math.round(n/1024)+' KB':(n/1048576).toFixed(n<10485760?1:0)+' MB';
 const wait=ms=>new Promise(r=>setTimeout(r,ms));
 // 'unknown' and timeouts may already have acted: never treat them as a plain failure.
 const unsure=e=>!!e&&(e.unknown===true||e.status==='unknown'||/unconfirm|lost the tool|hidden before|not returned|without a result/i.test(e.message||''));
 const nonce=()=>{const a=new Uint8Array(16);try{crypto.getRandomValues(a)}catch(_){a.forEach((_,i)=>a[i]=Math.random()*256)}return 'ck'+[...a].map(x=>x.toString(16).padStart(2,'0')).join('')};
 let seq=0;

 function mount(o){
  const {bridge,form,input,sendButton:sb}=o||{},bot=(o&&o.bot)||{};
  if(!bridge||!form||!input||!sb||!bot.id)return {hasAttachments:()=>false,send:async()=>'failed',busy:()=>false,destroy(){}};
  if(form.__ck)form.__ck.destroy();
  const name=bot.name||'this bot',N=h(name),cs=getComputedStyle(form);
  let m=MEM.get(bot.id);if(!m)MEM.set(bot.id,m={files:[],job:null,nonce:null,sent:null,locked:false,rec:null});
  let dead=false,open=false,active=false,stalled=false,said=false,forced=false,hard=false,tracking=false,teach=null,panel=null,tick=0;
  const off=[],on=(t,ev,f,c)=>{t.addEventListener(ev,f,c);off.push(()=>t.removeEventListener(ev,f,c))};
  const say=(t,bad)=>{said=!!t;try{o.status&&o.status(t||'',!!bad)}catch(_){}},hush=()=>{if(said)say('')};
  const call=(tool,a,x)=>bridge.call(tool,{bot:bot.id,...a},x),files=(a,x)=>call('grokbot_card_files',a,x),tc=a=>call('grokbot_card_teach',{action:a});
  const job=(k,s='working')=>!!m.job&&m.job.kind===k&&m.job.state===s;
  // A picker the kit stopped polling (Check status) does not hold up a plain text send.
  const busy=()=>m.locked||active||!!(m.job&&m.job.state==='working'&&!(stalled&&m.job.kind==='pick'))||!!(teach&&teach.step!=='idle');
  const edge=(el,ks)=>ks.forEach(k=>el.style['margin'+k]=cs['margin'+k]);
  const fire=f=>{try{f&&f()}catch(_){}};

  // The handoff draws + as a span; it becomes a real menu button.
  let plus=form.querySelector('.plus');
  if(!plus||plus.tagName!=='BUTTON'){const b=document.createElement('button');b.className='plus';b.textContent='+';plus?plus.replaceWith(b):form.prepend(b);plus=b}
  const menu=document.createElement('div'),mid='ck-menu-'+(++seq);
  plus.type='button';[['aria-label','Add to message'],['aria-haspopup','menu'],['aria-expanded','false'],['aria-controls',mid]].forEach(a=>plus.setAttribute(...a));
  menu.className='ck-menu';menu.id=mid;menu.hidden=true;menu.setAttribute('role','menu');menu.setAttribute('aria-label','Add to message');
  menu.innerHTML='<button type="button" role="menuitem" tabindex="-1" data-ck="attach">'+CLIP+'Attach files</button><button type="button" role="menuitem" tabindex="-1" data-ck="teach">'+REC+'Teach a task</button>';
  form.append(menu);
  const tray=document.createElement('div');tray.className='ck-tray';tray.setAttribute('aria-label','Attachments');edge(tray,['Left','Right']);form.before(tray);

  // position:fixed escapes the card's overflow clipping; it opens upward from +.
  function place(){if(!open)return;const r=plus.getBoundingClientRect();
   menu.style.left=Math.max(6,Math.min(r.left,document.documentElement.clientWidth-menu.offsetWidth-6))+'px';menu.style.top=Math.max(6,r.top-menu.offsetHeight-6)+'px'}
  const items=()=>[...menu.querySelectorAll('button:not([disabled])')];
  function toggle(v,last){if(v&&(dead||plus.disabled||teach)||!v&&!open)return;open=v;menu.hidden=!v;plus.setAttribute('aria-expanded',v);
   if(v){place();const l=items();l[last?l.length-1:0]?.focus()}}
  on(plus,'click',()=>toggle(!open));
  on(plus,'keydown',e=>{if(/^Arrow(Down|Up)$/.test(e.key)){e.preventDefault();toggle(true,e.key==='ArrowUp')}});
  on(menu,'keydown',e=>{const l=items(),i=l.indexOf(document.activeElement);
   if(e.key==='Escape'){e.preventDefault();e.stopPropagation();toggle(false);plus.focus()}
   else if(e.key==='Tab')toggle(false);
   else if(/^Arrow(Down|Up)$/.test(e.key)){e.preventDefault();l[(i+(e.key==='ArrowDown'?1:-1)+l.length)%l.length]?.focus()}});
  on(menu,'click',e=>{const b=e.target.closest('[data-ck]');if(b){toggle(false);b.dataset.ck==='attach'?pick():openTeach()}});
  on(menu,'focusout',e=>{const t=e.relatedTarget;if(t&&!menu.contains(t)&&t!==plus)toggle(false)});
  on(document,'pointerdown',e=>{if(open&&!menu.contains(e.target)&&!plus.contains(e.target))toggle(false)},true);
  on(document,'keydown',e=>{if(open&&e.key==='Escape'){toggle(false);plus.focus()}});
  on(window,'resize',()=>toggle(false));on(window,'blur',()=>toggle(false));
  on(document,'transitionend',()=>place()); // a sliding pane (show card) is a transformed ancestor until it settles
  if(typeof ResizeObserver==='function'){const ro=new ResizeObserver(()=>place());ro.observe(document.body);off.push(()=>ro.disconnect())}

  // Overrides the glue's send-button rule only while chips or a job need it.
  function sync(){if(dead)return;const was=hard,pk=job('pick')&&!stalled;hard=m.locked||active||job('send');
   if(hard)input.disabled=true;else if(was)input.disabled=false;
   plus.disabled=hard||pk;if(plus.disabled)toggle(false);
   const f=hard||pk||m.files.length>0;
   if(f)sb.disabled=hard||pk||!m.files.length;else if(forced)sb.disabled=!input.value.trim();
   forced=f}
  function draw(){if(dead)return;const lock=m.locked||active||job('send');
   tray.innerHTML=m.files.map(f=>'<span class="chip ck-file'+(f.sending?' is-sending':'')+'" title="'+h(f.name)+'">'+CLIP+'<span class="ck-nm">'+h(f.name)+'</span><span class="ck-sz">'+size(f.size)+'</span><button type="button" class="ck-x" data-rm="'+h(f.id)+'" aria-label="Remove '+h(f.name)+'"'+(lock||f.sending?' disabled':'')+'>'+X+'</button></span>').join('')
    +(stalled&&m.job?'<button type="button" class="chip ck-chk" data-ck="check">Check status</button>':'');
   sync()}
  // A closed pane still records what the server said, and wakes this bot's open pane (if any) to follow the job.
  function accept(b){if(!b)return;if(Array.isArray(b.attachments))m.files=b.attachments.filter(f=>f&&f.id);if(b.job&&b.job.id)m.job=b.job;dead?m.wake&&m.wake():draw()}
  const follow=now=>{tracking=true;return track(now).finally(()=>{tracking=false})};
  const resume=()=>{if(dead||tracking||active)return;if(m.locked){say(UNSURE,true);draw()}else if(m.job&&m.job.state==='working')follow().then(settle);else draw()};
  on(tray,'click',e=>{const x=e.target.closest('[data-rm]');if(x)drop(x.dataset.rm,x);else if(e.target.closest('[data-ck=check]')&&!tracking)follow(true).then(settle)});
  on(form,'input',sync); // bubble phase: after the glue's own input listener
  // Capture phase: runs before the glue's Enter handler, so a busy composer cannot send around the kit.
  on(form,'keydown',e=>{if(e.target===input&&e.key==='Enter'&&!e.shiftKey&&busy()){e.preventDefault();e.stopImmediatePropagation();if(job('pick'))say('Finish choosing files first.')}},true);

  // Polls the current job until it leaves 'working'. now: the user's Check status (no wait first).
  async function track(now){stalled=false;draw();const t0=Date.now(),pick=!!m.job&&m.job.kind==='pick',steps=pick?PICK:STEP;let fails=0;
   for(let n=0;!dead&&m.job&&m.job.state==='working';n++){
    if(n>=(pick?PICK.length:POLLS)||Date.now()-t0>3e5){stalled=true;return}
    if(!(now&&!n))await wait(steps[Math.min(n,steps.length-1)]);
    if(dead||!m.job)return;
    try{accept(await files({action:'status',jobId:m.job.id},{auto:!(now&&!n)}));fails=0}
    catch(err){if(dead||!m.job)return;
     if(/expired/i.test(err.message)){m.job={...m.job,state:m.job.kind==='send'?'unknown':'cancelled'};return}
     // Nothing was asked. Out of automatic requests (or tools): wait for Check status. The card is spent: a picker
     // ends here, and a send stays unconfirmed (it may already have acted).
     if(err.refused){if(err.refused==='hard')m.job={...m.job,state:m.job.kind==='send'?'unknown':'failed',message:err.message};else stalled=true;return}
     if(++fails>1){stalled=true;return}}}}
  // Turns the tracked job into UI; returns the send outcome.
  function settle(){const j=m.job;if(dead)return 'unknown';if(!j){draw();return 'failed'}
   if(j.state==='working'){if(stalled)say(j.kind==='send'?'Still sending. Check the status in a moment.':'Still waiting for the file picker.');draw();return 'unknown'}
   m.job=null;stalled=false;
   if(j.kind==='pick'){j.state==='failed'?say(j.message||'Those files could not be attached.',true):hush();draw();if(j.state==='complete')input.focus();return j.state}
   if(j.state==='complete'){const ids=m.sent||[];m.files=m.files.filter(f=>!ids.includes(f.id));m.sent=m.nonce=null;
    input.value='';input.dispatchEvent(new Event('input',{bubbles:true}));say('Sent.');draw();fire(o.onSent);return 'sent'}
   if(j.state==='unknown'){m.locked=true;say(UNSURE,true);draw();return 'unknown'}
   m.nonce=null;say(j.message||'The files could not be sent. Your draft is still here.',true);draw();return 'failed'}

  async function pick(){if(busy())return;
   if(!bridge.canInvoke)return say('Attaching files is unavailable here right now.',true);
   if(m.files.length>=20)return say('Attach up to 20 files at a time.',true);
   say('Choose files in the picker…');
   try{accept(await files({action:'pick'}))}
   catch(err){if(dead)return;if(!unsure(err))return say(err.message,true);
    try{accept(await files({action:'status'}))}catch(_){return say(err.message,true)}}
   if(dead)return;if(!m.job)return hush();
   await follow();settle()}
  async function drop(id,btn){if(m.locked||active||job('send'))return;btn.disabled=true;
   try{accept(await files({action:'remove',attachmentId:id}));hush();input.focus()}
   catch(err){if(dead)return;if(/no longer available/i.test(err.message)){m.files=m.files.filter(f=>f.id!==id);draw()}else btn.disabled=false;say(err.message||'That file could not be removed.',true)}}
  async function send(message){
   if(dead)return 'failed';
   if(m.locked){say(UNSURE,true);return 'unknown'}
   if(!m.files.length||busy()){if(job('pick'))say('Finish choosing files first.');return 'failed'}
   if(!bridge.canInvoke){say('Sending is unavailable here right now. Your draft is still here.',true);return 'failed'}
   const text=String(message??input.value).trim(),ids=m.files.map(f=>f.id),fp=JSON.stringify([ids,text]);
   // One nonce per draft: retrying the same draft reuses it, so the server never sends it twice.
   if(!m.nonce||m.nonce.fp!==fp)m.nonce={fp,v:nonce()};
   active=true;m.sent=ids;toggle(false);say(ids.length>1?'Sending '+ids.length+' files…':'Sending 1 file…');draw();
   let r;
   try{accept(await files({action:'send',attachments:ids,message:text,clientNonce:m.nonce.v}));
    if(!m.job||m.job.kind!=='send')throw Object.assign(Error(UNSURE),{unknown:true});
    await follow();r=settle()}
   catch(err){if(dead){if(unsure(err)){m.locked=true;m.wake&&m.wake()}return 'unknown'}
    if(unsure(err)){m.locked=true;say(UNSURE,true);r='unknown'}
    else{say(err.message||'Not sent. Your draft is still here.',true);r='failed'}}
   if(dead)return r;
   active=false;
   if(r==='failed'&&text&&!input.value.trim())input.value=text; // keep the draft even if the glue cleared it
   draw();return r}

  // Teach a task: a compact panel in place of the composer row.
  function openPanel(step){toggle(false);teach={step,err:''};
   if(!panel){panel=document.createElement('div');panel.className='ck-teach';panel.tabIndex=-1;panel.setAttribute('role','group');panel.setAttribute('aria-label','Teach a task');
    edge(panel,['Top','Right','Bottom','Left']);form.after(panel);
    panel.addEventListener('click',e=>{const b=e.target.closest('[data-t]');if(b&&!b.disabled)act(b.dataset.t)});
    panel.addEventListener('keydown',e=>{if(e.key==='Escape'&&teach&&teach.step==='idle'){e.preventDefault();closePanel()}})}
   form.classList.add('ck-hide');tray.classList.add('ck-hide');drawTeach(true)}
  function closePanel(){teach=null;clearInterval(tick);if(panel)panel.remove();panel=null;
   form.classList.remove('ck-hide');tray.classList.remove('ck-hide');draw();if(!input.disabled)input.focus()}
  const btn=(t,label,cls)=>'<button type="button" class="ck-b '+(cls||'')+'" data-t="'+t+'">'+label+'</button>';
  function drawTeach(focus){if(!panel||!teach||dead)return;
   const s=teach.step,rec=/^(rec|saving|discarding)$/.test(s),note={check:'Checking…',prep:'Starting '+N+'’s computer…',saving:'Saving…',discarding:'Discarding…'}[s];
   const had=focus||panel.contains(document.activeElement)||document.activeElement===document.body;
   panel.classList.toggle('on',rec);
   panel.innerHTML='<div class="ck-tl">'+(rec?'<span class="ck-dot" aria-hidden="true"></span><span class="ck-tt">Recording on '+N+'’s computer</span><span class="ck-tm" aria-hidden="true"></span>'
     :REC+'<span>Show '+N+' a task on its computer. '+N+' learns it from the recording.</span>')+'</div>'
    +'<div class="ck-st" role="status" aria-live="polite">'+(note?'<span class="ty"><i></i><i></i><i></i></span>'+note:teach.err?'<span class="ck-er">'+h(teach.err)+'</span>':'')+'</div>'
    +'<div class="ck-ta">'+(rec?btn('open','Open computer')+btn('discard','Discard','q rm')+btn('save','Save','pri'):btn('cancel','Cancel','q')+btn('start','Start recording','rec'))+'</div>';
   // Cancel stays usable while the computer starts: nothing records until 'start' is sent.
   if(note)panel.querySelectorAll('[data-t]').forEach(b=>b.disabled=!(s==='prep'&&b.dataset.t==='cancel'&&!teach.hold));
   clearInterval(tick);if(rec){tick=setInterval(clock,1e3);clock()}
   if(had)(['save','start','cancel'].map(t=>panel.querySelector('[data-t='+t+']:enabled')).find(Boolean)||panel).focus()}
  function clock(){const t=panel&&panel.querySelector('.ck-tm');if(!t||!m.rec)return;
   let s=Math.max(0,(Date.now()-(m.rec.startedAtMs||Date.now()))/1e3|0);if(m.rec.maxDurationMs)s=Math.min(s,m.rec.maxDurationMs/1e3|0);
   t.textContent=(s/60|0)+':'+String(s%60).padStart(2,'0')}
  const mine=r=>!!r&&r.state==='recording'&&r.agentId===bot.id;
  const computer=()=>Promise.resolve().then(()=>o.openComputer&&o.openComputer()).catch(()=>{});
  async function openTeach(){if(busy())return;
   if(!bridge.canInvoke)return say('Teach a task is unavailable here right now.',true);
   hush();openPanel('check');const g=teach;
   try{const r=(await tc('status')).recording||{};if(dead||teach!==g)return;
    if(mine(r)){m.rec=r;g.step='rec'}
    else{g.step='idle';if(r.state==='stopping'&&r.agentId===bot.id)g.err='The last recording is still saving. Try again in a moment.';
     else if(r.state&&r.state!=='idle'&&r.agentId&&r.agentId!==bot.id)g.err='Another bot is recording. Finish that recording first.'}}
   catch(err){if(dead||teach!==g)return;g.step='idle';g.err=err.message}
   drawTeach()}
  async function act(t){const g=teach;if(!g||dead)return;
   if(t==='cancel')return closePanel();
   if(t==='open')return computer();
   if(t==='start'){g.step='prep';g.err='';g.hold=false;drawTeach();
    try{await tc('prepare');if(dead||teach!==g)return;
     g.hold=true;drawTeach();let r;
     try{r=(await tc('start')).recording}catch(err){if(!unsure(err))throw err;r=(await tc('status')).recording}
     if(mine(r))m.rec=r; // remember even if the pane closed meanwhile, so a remount shows the recording
     if(dead)return;if(!mine(r))throw Error('Recording did not start. Please try again.');
     if(teach!==g)openPanel('rec');else{g.step='rec';drawTeach(true)}
     computer()}
    catch(err){if(dead||teach!==g)return;g.step='idle';g.hold=false;g.err=err.message||'That didn’t go through.';drawTeach()}
    return}
   g.step=t==='save'?'saving':'discarding';g.err='';drawTeach();
   try{const b=await tc(t);if(dead)return;
    if(mine(b.recording)){m.rec=b.recording;throw Error('Recording is still active. Try again.')}
    m.rec=null;if(teach===g)closePanel();
    if(t==='discard')say('Recording discarded.');else if(b.saved){say('Saved. '+name+' will learn this task.');fire(o.onSent)}else say('The recording had already ended.')}
   catch(err){if(dead||teach!==g)return;g.step='rec';g.err=unsure(err)?'Not confirmed. Check Grok Bot before trying again.':err.message||'That didn’t go through.';drawTeach()}}

  const kit={hasAttachments:()=>m.files.length>0,send,busy,
   destroy(){if(dead)return;toggle(false);dead=true;if(m.wake===resume)m.wake=null;clearInterval(tick);off.forEach(f=>f());menu.remove();tray.remove();if(panel)panel.remove();panel=teach=null;form.classList.remove('ck-hide');if(form.__ck===kit)delete form.__ck}};
  form.__ck=kit;
  // Resume what this document already knows for this bot; no request unless a job is still running.
  draw();
  m.wake=resume;resume();
  if(mine(m.rec))openPanel('rec');
  return kit}

 return {mount};
})();

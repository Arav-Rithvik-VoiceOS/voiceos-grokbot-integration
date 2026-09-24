/* ComposerKit: the 1:1 composer's + button (Attach files). Never sends on its own; the glue calls send(). */
const ComposerKit=(()=>{
 const MEM=new Map(); // per bot, per document: a remounted show-card pane keeps its chips and job
 const UNSURE='Delivery is unconfirmed. Check Grok Bot before sending again.';
 // Polls spend the card's automatic request budget (shared with live refresh), so they back off and stop at 24;
 // the file picker waits on the user, so it gets fewer, slower polls. After that: Check status.
 const STEP=[1e3,1e3,1e3,2e3,2e3,3e3,5e3,8e3],POLLS=24,PICK=[3e3,5e3,8e3,10e3,12e3,15e3];
 const CLIP='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.5 11.5l-8.4 8.4a5.4 5.4 0 0 1-7.6-7.6l8.4-8.4a3.6 3.6 0 0 1 5.1 5.1l-8.4 8.4a1.8 1.8 0 0 1-2.5-2.5l7.7-7.7"/></svg>';
 const X='<svg width="8" height="8" viewBox="0 0 10 10" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><path d="M2 2l6 6M8 2L2 8"/></svg>';
 const h=s=>String(s??'').replace(/[&<>"']/g,c=>'&#'+c.charCodeAt(0)+';');
 const size=n=>(n=+n||0)<1024?n+' B':n<1048576?Math.round(n/1024)+' KB':(n/1048576).toFixed(n<10485760?1:0)+' MB';
 const wait=ms=>new Promise(r=>setTimeout(r,ms));
 // 'unknown' and timeouts may already have acted: never treat them as a plain failure.
 const unsure=e=>!!e&&(e.unknown===true||e.status==='unknown'||/unconfirm|lost the tool|hidden before|not returned|without a result/i.test(e.message||''));
 const nonce=()=>{const a=new Uint8Array(16);try{crypto.getRandomValues(a)}catch(_){a.forEach((_,i)=>a[i]=Math.random()*256)}return 'ck'+[...a].map(x=>x.toString(16).padStart(2,'0')).join('')};

 function mount(o){
  const {bridge,form,input,sendButton:sb}=o||{},bot=(o&&o.bot)||{};
  if(!bridge||!form||!input||!sb||!bot.id)return {hasAttachments:()=>false,send:async()=>'failed',busy:()=>false,destroy(){}};
  if(form.__ck)form.__ck.destroy();
  const cs=getComputedStyle(form);
  let m=MEM.get(bot.id);if(!m)MEM.set(bot.id,m={files:[],job:null,nonce:null,sent:null,locked:false});
  let dead=false,active=false,stalled=false,said=false,forced=false,hard=false,tracking=false;
  const off=[],on=(t,ev,f,c)=>{t.addEventListener(ev,f,c);off.push(()=>t.removeEventListener(ev,f,c))};
  const say=(t,bad)=>{said=!!t;try{o.status&&o.status(t||'',!!bad)}catch(_){}},hush=()=>{if(said)say('')};
  const call=(tool,a,x)=>bridge.call(tool,{bot:bot.id,...a},x),files=(a,x)=>call('grokbot_card_files',a,x);
  const job=(k,s='working')=>!!m.job&&m.job.kind===k&&m.job.state===s;
  // A picker the kit stopped polling (Check status) does not hold up a plain text send.
  const busy=()=>m.locked||active||!!(m.job&&m.job.state==='working'&&!(stalled&&m.job.kind==='pick'));
  const edge=(el,ks)=>ks.forEach(k=>el.style['margin'+k]=cs['margin'+k]);
  const fire=f=>{try{f&&f()}catch(_){}};

  // The handoff draws + as a span; it becomes a real button that opens the file picker.
  let plus=form.querySelector('.plus');
  if(!plus||plus.tagName!=='BUTTON'){const b=document.createElement('button');b.className='plus';b.textContent='+';plus?plus.replaceWith(b):form.prepend(b);plus=b}
  plus.type='button';plus.setAttribute('aria-label','Attach files');plus.title='Attach files';
  const tray=document.createElement('div');tray.className='ck-tray';tray.setAttribute('aria-label','Attachments');edge(tray,['Left','Right']);form.before(tray);
  on(plus,'click',()=>pick());

  // Overrides the glue's send-button rule only while chips or a job need it.
  function sync(){if(dead)return;const was=hard,pk=job('pick')&&!stalled;hard=m.locked||active||job('send');
   if(hard)input.disabled=true;else if(was)input.disabled=false;
   plus.disabled=hard||pk;
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
   active=true;m.sent=ids;say(ids.length>1?'Sending '+ids.length+' files…':'Sending 1 file…');draw();
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

  const kit={hasAttachments:()=>m.files.length>0,send,busy,
   destroy(){if(dead)return;dead=true;if(m.wake===resume)m.wake=null;off.forEach(f=>f());tray.remove();if(form.__ck===kit)delete form.__ck}};
  form.__ck=kit;
  // Resume what this document already knows for this bot; no request unless a job is still running.
  draw();
  m.wake=resume;resume();
  return kit}

 return {mount};
})();

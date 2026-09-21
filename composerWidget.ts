/** Runs inside the conversation runtime, sharing its serialized, scoped bridge. */
export const composerCss = String.raw`
.card{position:relative}.composer{position:relative}.composer-menu{position:absolute;bottom:calc(100% + 4px);left:12px;width:198px;padding:4px;background:#191919;border:1px solid #303030;border-radius:8px;box-shadow:0 8px 28px #0008;z-index:4}.composer-menu button{display:flex;align-items:center;gap:9px;width:100%;padding:7px 9px;border:0;border-radius:4px;background:none;text-align:left;font-size:12px;line-height:18px}.composer-menu button:hover,.composer-menu button:focus-visible{background:#303030}.composer-menu svg{width:15px;height:15px;flex:none}.staged{flex:none;display:flex;gap:5px;overflow:auto;max-height:56px;padding:5px 12px;background:#111}.staged:empty{display:none}.attachment-chip{display:flex;align-items:center;gap:6px;flex:none;max-width:210px;border:1px solid #414141;border-radius:8px;padding:4px 7px;font-size:11px;background:#262626}.attachment-chip span{overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.attachment-chip button{border:0;background:none;color:#aaa;padding:0 2px}.composer-progress{flex:none;display:flex;align-items:center;justify-content:space-between;gap:6px;padding:4px 12px;font-size:11px;background:#171717}.composer-progress button{border:0;background:#303030;border-radius:5px;padding:3px 7px;white-space:nowrap}.teach-panel{position:absolute;inset:0;z-index:6;display:flex;flex-direction:column;min-height:0;background:#111}.teach-header{display:flex;align-items:center;gap:8px;padding:8px 12px;flex:none}.teach-header strong{flex:1}.teach-screen{min-height:0;flex:1;overflow:hidden;background:#080808;position:relative}.teach-screen canvas{outline:none}.teach-help{margin:0;padding:7px 12px;font-size:12px;color:#bbb;flex:none;max-height:40px;overflow:auto}.teach-controls{display:flex;flex:none;gap:8px;align-items:center;flex-wrap:wrap;padding:6px 12px 10px}.teach-controls .action{margin:0}.teach-controls .secondary{background:#303030;color:#ddd}.record-dot{display:inline-block;width:10px;height:10px;border:2px solid #ff3348;border-radius:50%;margin-right:6px}.is-recording .record-dot{background:#ff3348}.record-banner{padding:4px 12px;display:flex;align-items:center;gap:8px;font-size:11px;background:#28191b;flex:none}.record-banner span{flex:1}.record-banner button{border:0;border-radius:6px;padding:4px 8px;background:#3c292b;color:#fff}
`;
export const composerHtml = `<div class="record-banner" hidden><span></span><button data-resume-teach>View recording</button><button data-save-teach>Stop &amp; save</button></div><div class="staged"></div><div class="composer-progress" hidden><span></span><button data-check-files>Check status</button></div>`;
export const composerMenuHtml = `<div class="composer-menu" id="composer-menu" role="menu" aria-label="Add to message" hidden><button role="menuitem" data-pick-files><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M8 13V6a4 4 0 0 1 8 0v10a6 6 0 0 1-12 0V7m8-1v10a2 2 0 0 1-4 0V8"/></svg>Attach files</button><button role="menuitem" data-teach><svg viewBox="0 0 24 24" fill="none" stroke="#ff233d" stroke-width="2"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4" fill="#ff233d" stroke="none"/></svg>Teach a task</button></div>`;
export const teachHtml = `<section class="teach-panel" role="dialog" aria-label="Teach a task" hidden><div class="teach-header"><strong>Teach a task</strong><button class="round" data-close-teach aria-label="Close task view">×</button></div><p class="teach-help"></p><div class="teach-screen" tabindex="0" aria-label="Bot computer"></div><div class="teach-controls"><span class="teach-timer"></span><button class="action" data-start-teach>Start recording</button><button class="action" data-save-teach hidden>Stop &amp; save</button><button class="action secondary" data-discard-teach hidden>Discard</button><button class="action secondary" data-retry-teach hidden>Retry connection</button></div></section>`;
export const composerRuntime = String.raw`
const attachments=new Map(),fileJobs=new Map(),fileDrafts=new Map(),fileNonces=new Map();
let fileTimer,teachTimer,tickTimer,teachBot=null,recording={state:'idle'},rfb=null,teachBusy=false,teachReady=false,teachGeneration=0;
const menu=$('.composer-menu'),teacher=$('.teach-panel');
function hasFiles(id=selected){return (attachments.get(id)||[]).length>0;}
function fileWorking(id=selected){return fileJobs.get(id)?.state==='working';}
function updateSend(){send.disabled=!canInvoke||busyAction||uncertain||fileWorking()||!(input.value.trim()||hasFiles());$('#attach').disabled=!canInvoke;}
function toggleMenu(open){menu.hidden=!open;$('#attach').setAttribute('aria-expanded',String(open));if(open){menu.querySelector('[data-teach]').disabled=groups.some(g=>g.id===selected);menu.querySelector('button').focus();}}
function drawFiles(){
 $('.staged').innerHTML=(attachments.get(selected)||[]).map(f=>'<div class="attachment-chip"><span title="'+esc(f.name)+'">'+esc(f.name)+'</span><button data-remove-file="'+esc(f.id)+'" aria-label="Remove '+esc(f.name)+'" '+(f.sending?'disabled':'')+'>×</button></div>').join('');
 const job=fileJobs.get(selected),bar=$('.composer-progress');bar.hidden=!selected||!job;
 if(job)bar.querySelector('span').textContent=job.state==='working'?(job.kind==='pick'?'Choose files in the file picker…':'Uploading and sending…'):job.message||(job.state==='complete'?'Sent':job.state==='cancelled'?'Selection cancelled':'Check attachment status');
 updateSend();
}
function scheduleFiles(){clearTimeout(fileTimer);if(!disposed&&requests<48&&[...fileJobs.values()].some(j=>j.state==='working'))fileTimer=setTimeout(pollFiles,2500);}
function acceptFiles(id,body){
 attachments.set(id,body.attachments||[]);const previous=fileJobs.get(id),job=body.job;
 if(job){fileJobs.set(id,job);if(job.kind==='send'&&job.state==='complete'&&previous?.state!=='complete'){
   const submitted=fileDrafts.get(id);if(selected===id&&input.value===submitted)input.value='';if(drafts.get(id)===submitted)drafts.delete(id);fileDrafts.delete(id);fileNonces.delete(id);if(selected===id)refresh();
  }if(['cancelled','complete'].includes(job.state)&&job.kind==='pick')fileJobs.delete(id);
 }else if(previous?.state!=='working')fileJobs.delete(id);
 if(id===selected)drawFiles();scheduleFiles();
}
async function fileCall(id,action,extra={}){try{const body=await invoke('grokbot_card_files',{bot:id,action,...extra});acceptFiles(id,body);return body;}catch(e){if(id===selected)info(e.message);throw e;}}
async function pollFiles(){
 for(const [id,job] of fileJobs){if(job.state!=='working'||disposed)continue;try{await fileCall(id,'status',{jobId:job.id});}catch{break;}}
 scheduleFiles();
}
async function recoverFiles(){if(!selected||!canInvoke)return;const id=selected;try{await fileCall(id,'status',fileJobs.has(id)?{jobId:fileJobs.get(id).id}:{});}catch{}}
async function pickFiles(){toggleMenu(false);const id=selected;try{await fileCall(id,'pick');}catch{}}
async function sendFiles(){
 if(busyAction||uncertain||fileWorking())return;
 const id=selected,submitted=input.value,ids=(attachments.get(id)||[]).map(f=>f.id);if(!ids.length)return;
 const fingerprint=JSON.stringify([ids,submitted.trim()]);let attempt=fileNonces.get(id);
 // An unconfirmed send must be checked, never automatically retried.
 if(fileJobs.get(id)?.state==='unknown'){info('Delivery is unconfirmed. Check the conversation before sending again.');return;}
 if(!attempt||attempt.fingerprint!==fingerprint||fileJobs.get(id)?.state==='failed')attempt={fingerprint,nonce:crypto.randomUUID()};fileNonces.set(id,attempt);
 busyAction=true;fileDrafts.set(id,submitted);updateSend();
 try{await fileCall(id,'send',{attachments:ids,message:submitted.trim(),clientNonce:attempt.nonce});}catch(e){if(e.unknown){fileJobs.set(id,{kind:'send',state:'unknown',message:e.message});} }
 finally{busyAction=false;drawFiles();}
}
function recordingHere(){return recording.state!=='idle'&&recording.agentId===teachBot;}
function drawTeach(){
 const active=recordingHere(),stopping=recording.state==='stopping';
 teacher.querySelector('[data-start-teach]').hidden=active;teacher.querySelector('[data-start-teach]').disabled=!teachReady||teachBusy;
 teacher.querySelector('[data-save-teach]').hidden=!active;teacher.querySelector('[data-discard-teach]').hidden=!active;
 teacher.querySelectorAll('[data-save-teach],[data-discard-teach]').forEach(b=>b.disabled=teachBusy||stopping);
 teacher.classList.toggle('is-recording',active);
 if(teachReady)teacher.querySelector('.teach-help').textContent=active?'Show '+bot(teachBot).name+' the task on the computer below.': 'Record yourself doing a task. '+bot(teachBot).name+' learns the steps and can run them again on its own.';
 const banner=$('.record-banner');banner.hidden=!active||!teacher.hidden;banner.querySelector('span').textContent='● Recording with '+bot(teachBot).name;banner.querySelector('[data-save-teach]').disabled=teachBusy||stopping;
 if(rfb)rfb.viewOnly=!active||stopping;
 updateTimer();
}
function updateTimer(){const active=recordingHere(),seconds=Math.max(0,Math.floor((Date.now()-(recording.startedAtMs||Date.now()))/1000));$('.teach-timer').innerHTML=active?'<span class="record-dot"></span>'+Math.floor(seconds/60)+':'+String(seconds%60).padStart(2,'0')+(recording.state==='stopping'?' Saving…':''):'';}
function disconnectComputer(){teachGeneration++;if(rfb){rfb.disconnect();rfb=null;}teachReady=false;$('.teach-screen').replaceChildren();}
async function connectComputer(body,generation){
 if(!/^wss:\/\//.test(body.wsUrl||'')||!body.viewer)throw Error('The bot computer is unavailable.');
 const bytes=Uint8Array.from(atob(body.viewer),c=>c.charCodeAt(0)),blob=await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).blob(),url=URL.createObjectURL(new Blob([blob],{type:'text/javascript'}));
 let RFB;try{RFB=(await import(url)).default;}finally{URL.revokeObjectURL(url);}
 if(disposed||teacher.hidden||generation!==teachGeneration)return;
 rfb=new RFB($('.teach-screen'),body.wsUrl,{shared:true});rfb.scaleViewport=true;rfb.resizeSession=false;rfb.viewOnly=!recordingHere();
 rfb.addEventListener('connect',()=>{if(generation!==teachGeneration)return;teachReady=true;drawTeach();});
 rfb.addEventListener('disconnect',()=>{if(generation!==teachGeneration)return;teachReady=false;$('.teach-help').textContent='Computer disconnected. Reconnect to continue.';teacher.querySelector('[data-retry-teach]').hidden=false;drawTeach();});
}
function scheduleTeach(){clearTimeout(teachTimer);if(!disposed&&recordingHere()&&requests<48)teachTimer=setTimeout(()=>teachAction('status'),15000);}
async function teachAction(action){
 if(teachBusy||!teachBot)return;teachBusy=true;drawTeach();const generation=teachGeneration;
 try{const body=await invoke('grokbot_card_teach',{bot:teachBot,action});recording=body.recording||recording;
  if(action==='prepare'){await connectComputer(body,generation);}
  if((action==='save'||action==='discard')&&recording.state==='idle'){closeTeach();info(action==='save'&&body.saved?'Recording saved. '+bot(teachBot).name+' is learning the task.':action==='discard'?'Recording discarded.':'Recording has ended.');refresh();}
 }catch(e){$('.teach-help').textContent=e.message;info(e.message);if(action==='prepare')teacher.querySelector('[data-retry-teach]').hidden=false;}
 finally{teachBusy=false;drawTeach();scheduleTeach();}
}
function openTeach(){toggleMenu(false);if(recording.state!=='idle'&&recording.agentId!==selected){info('Finish the active recording first.');return;}teachBot=selected;teacher.hidden=false;disconnectComputer();teacher.querySelector('[data-retry-teach]').hidden=true;$('.teach-help').textContent='Connecting to '+bot(teachBot).name+'’s computer…';drawTeach();teachAction('prepare');clearInterval(tickTimer);tickTimer=setInterval(updateTimer,1000);}
function closeTeach(){teacher.hidden=true;disconnectComputer();drawTeach();if(!recordingHere()){clearInterval(tickTimer);clearTimeout(teachTimer);refresh();}}
function composerClick(t){
 if(t.id==='attach'){toggleMenu(menu.hidden);return true;}
 if(t.hasAttribute('data-pick-files')){pickFiles();return true;}
 if(t.dataset.removeFile){fileCall(selected,'remove',{attachmentId:t.dataset.removeFile}).catch(()=>{});return true;}
 if(t.hasAttribute('data-check-files')){recoverFiles();return true;}
 if(t.hasAttribute('data-teach')){openTeach();return true;}
 if(t.hasAttribute('data-resume-teach')){if(selected!==teachBot)show(teachBot);openTeach();return true;}
 if(t.hasAttribute('data-close-teach')){closeTeach();return true;}
 if(t.hasAttribute('data-retry-teach')){openTeach();return true;}
 for(const action of ['start','save','discard'])if(t.hasAttribute('data-'+action+'-teach')){teachAction(action);return true;}
 return false;
}
document.addEventListener('pointerdown',e=>{if(!e.target.closest('.composer-menu,#attach'))toggleMenu(false);});
menu.addEventListener('keydown',e=>{if(!['ArrowDown','ArrowUp','Escape','Tab'].includes(e.key))return;if(e.key==='Escape'||e.key==='Tab'){toggleMenu(false);if(e.key==='Escape'){$('#attach').focus();e.preventDefault();}return;}e.preventDefault();const options=[...menu.querySelectorAll('button:not(:disabled)')],i=options.indexOf(document.activeElement);options[(i+(e.key==='ArrowDown'?1:-1)+options.length)%options.length].focus();});
`;

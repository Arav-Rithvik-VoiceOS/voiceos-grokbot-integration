/* ScreenPane — the show card's live-screen pane (list → chat → screen). show-adapter.js builds it
   when the chat header's screen button is tapped and tears it down on Back. It reuses show.html's
   globals (av, esc, report, statusText, dotCls, CAN_INVOKE, unpackResult) since it is concatenated
   into show.html's own <script>, in the same IIFE as the other adapters.

   No composer of its own: the chat pane one Back away is the single conversation surface. The 57KB
   noVNC viewer is NOT baked into the show card (that card is THE surface, rendered on every turn);
   grokbot_card_screen delivers {live, wsUrl, viewer} only when this pane opens, so the viewer rides
   the tool result exactly when needed. Tapping a live frame opens the big interactive window. */
const ScreenPane=(()=>{
 const calm=matchMedia('(prefers-reduced-motion: reduce)').matches;
 const BACK='<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>';
 const EXPAND='<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6M20 4l-7 7M10 20H4v-6M4 20l7-7"/></svg>';
 const rep=()=>{try{typeof report==='function'&&report()}catch(_){}};

 /* The live feed, one per mounted pane. `viewer` is the gzip+base64 noVNC client from the tool result
    (grokbot_card_screen), loaded only when this pane opens. */
 function makeFeed(host){
  const cv=host.querySelector('#sp-cv'),live=host.querySelector('#sp-live');
  let rfb=null,lastUrl='',viewerMod=null,retries=0,VIEWER='';
  function loadRFB(){return viewerMod||(viewerMod=(async()=>{
   const bin=Uint8Array.from(atob(VIEWER),c=>c.charCodeAt(0));
   const inflated=await new Response(new Blob([bin]).stream().pipeThrough(new DecompressionStream('gzip'))).blob();
   const mod=await import(URL.createObjectURL(new Blob([inflated],{type:'text/javascript'})));
   return mod.default;})());}
  function badge(label,off){live.classList.toggle('paused',!!off);live.lastChild.textContent=label}
  function connect(url,viewer){if(!url||!viewer)return;VIEWER=viewer;if(rfb&&lastUrl===url)return;lastUrl=url;cv.style.display='none';
   const f=host.querySelector('#sp-feed');let box=f.querySelector('.rfb');if(!box){box=document.createElement('div');box.className='rfb';f.appendChild(box)}
   loadRFB().then(RFB=>{
    if(rfb&&lastUrl===url)return;
    if(rfb){const old=rfb;rfb=null;old._stale=true;try{old.disconnect()}catch(e){}}
    const r=rfb=new RFB(box,url,{shared:true});r.viewOnly=true;r.scaleViewport=false;r.background='#0a0a0b';
    /* Match the frame to the remote screen's real shape so it fills with no bars and no crop. */
    let fitTries=0;const fitFrame=()=>{const cvn=box.querySelector('canvas');if(cvn&&cvn.width>1&&cvn.height>1){const s=host.querySelector('#sp-screen');if(s)s.style.aspectRatio=cvn.width+'/'+cvn.height;rep();return}if(fitTries++<40)setTimeout(fitFrame,100)};
    r.addEventListener('connect',()=>{if(!r._stale){badge('LIVE',false);fitFrame()}});
    r.addEventListener('disconnect',e=>{if(r._stale)return;rfb=null;const clean=e.detail&&e.detail.clean;badge(clean?'ENDED':'OFFLINE',true);
     if(!clean&&retries<4){retries++;setTimeout(()=>{if(!rfb&&lastUrl)connect(lastUrl,VIEWER)},1500*retries)}});
    r.addEventListener('connect',()=>{retries=0});
    r.addEventListener('credentialsrequired',()=>{badge('LOCKED',true);setWhat(host,'This screen needs a password')});
   }).catch(err=>{badge('OFFLINE',true);setWhat(host,'Viewer failed: '+((err&&err.message)||err))});
  }
  function disconnect(){if(rfb){const r=rfb;rfb=null;r._stale=true;try{r.disconnect()}catch(e){}}}
  return{connect,disconnect};
 }

 function setWhat(host,t){const w=host.querySelector('#sp-what');if(w){w.textContent=t||'';w.style.display=t?'':'none'}rep()}

 function mount(o){
  const host=o.host,bot=o.bot||{},invoke=o.invoke,onBack=o.onBack;
  let dead=false,isLive=false,feed=null;
  host.style.setProperty('--glow',(bot.color||'#FF8A00')+'80');
  host.innerHTML=
   '<div class="hd"><button class="back" id="sp-back" aria-label="Back">'+BACK+'</button>'+av(bot)
   +'<div class="grow" style="min-width:0"><div class="t2">'+esc(bot.name)+'’s screen'+(bot.label?' <span class="chip">'+esc(bot.label)+'</span>':'')+'</div>'
   +'<div class="st" id="sp-st"><span class="dot"></span>Connecting…</div></div></div>'
   +'<div class="sp-screen" id="sp-screen" role="button" aria-label="Open the full interactive window">'
   +'<div class="sp-feed" id="sp-feed"><canvas id="sp-cv" width="800" height="500"></canvas></div>'
   +'<div class="sp-openo"><span>'+EXPAND+'Open window</span></div>'
   +'<div class="sp-cap"><div class="sp-what" id="sp-what" style="display:none"></div></div>'
   +'<div class="sp-live paused" id="sp-live"><i class="sp-rec"></i>CONNECTING</div></div>';
  const q=s=>host.querySelector(s);
  const setStatus=word=>{q('#sp-st').innerHTML='<span class="dot '+dotCls(bot)+'"></span>'+esc(word)};
  const capAv=q('.hd .av');
  q('#sp-back').onclick=()=>{if(!dead&&onBack)onBack()};
  /* Tapping a live frame hands off to the big interactive window (the one action the pane can't do inline). */
  q('#sp-screen').onclick=()=>{if(!isLive||dead)return;if(!CAN_INVOKE){setWhat(host,'Opening the window isn’t available here');return}
   invoke('grokbot_open_computer_window',{bot:bot.id}).then(r=>{const b=safe(r);if(b&&b.opened===false)setWhat(host,b.message||'The computer isn’t running right now.')}).catch(e=>setWhat(host,(e&&(e.error||e.message))||'Couldn’t open the window'))};

  function goLive(b){if(dead)return;isLive=true;q('#sp-screen').classList.add('live');feed=makeFeed(host);feed.connect(b.wsUrl,b.viewer);
   setWhat(host,'');
   setStatus(statusText(bot));Motion.set(capAv,bot.status==='idle'?'idle':'working')}
  function goIdle(msg){if(dead)return;isLive=false;const l=q('#sp-live');l.classList.add('paused');l.lastChild.textContent='OFFLINE';
   q('#sp-cv').style.display='none';setWhat(host,msg||(bot.name+'’s computer is off right now'));
   setStatus('Idle');Motion.set(capAv,'idle')}

  const probe=()=>invoke('grokbot_card_screen',{bot:bot.id}).then(r=>{if(dead)return;let b=null;try{b=unpackResult(r)}catch(_){}
   if(b&&b.live&&b.wsUrl&&b.viewer)goLive(b);else goIdle(b&&b.message)})
   .catch(e=>{if(!dead)goIdle((e&&(e.error||e.message))||undefined)});
  /* VoiceOS can boot a card before it grants tools (the grant rides a later voiceos:init), and a reopened
     notch restores this pane during that boot. Stay on "Connecting…" and probe once the grant lands
     (o.whenReady), instead of giving up for good. */
  let unready=null;
  if(CAN_INVOKE)probe();
  else if(o.whenReady)unready=o.whenReady(()=>{if(unready){unready();unready=null}if(!dead)probe()});
  else goIdle('Live screen isn’t available in this host');

  return {destroy(){dead=true;if(unready)unready();if(feed)feed.disconnect()}};
 }
 function safe(r){try{return unpackResult(r)}catch(_){return null}}
 return {mount};
})();

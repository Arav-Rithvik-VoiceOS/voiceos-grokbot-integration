/* Runtime adapter for the unmodified messaging handoff. Runs in its lexical scope. */
let canInvoke = false;
// New-group compose mode only: its one send, which swaps in the created group's live thread.
let pendingSend = null;
// Live thread sends, by requestId: { localId, message, timer }. They queue behind the live chat's calls.
const liveSends = new Map();
// The posted send holds the card's one action slot until the host's terminal result, even after our 65 s timeout.
const sendTurns = new Map();
let sequence = 0;
let booted = false;
let themeMode = 'dark';
// LiveChat + ComposerKit ride on every thread card except the new-group compose mode.
const liveBridge = typeof LiveChat !== 'undefined' ? LiveChat.bridge() : null;
let liveChat = null;
let liveKit = null;
const gbCalm = matchMedia('(prefers-reduced-motion: reduce)').matches;

/* The card's own memory. VoiceOS rebuilds a result card from its FIRST html every
 * time the notch closes and opens (and a networked card on every hide), and it
 * keeps nothing the card did: the baked draft comes back, typed text and sent
 * messages vanish. Grok Bot's cards are networked, so each tool result has its own
 * origin with working localStorage for the app's lifetime. Keyed by conversation.
 * A plain (srcdoc) card has no storage: every call is a no-op there. */
const cardKey = () => 'gb-card:' + (G ? 'g:' + G.id : !isGroup && SELF ? 'b:' + SELF
  : 'new:' + (Array.isArray(DEMO.args.members) ? DEMO.args.members.join(',') : ''));
const Store = {
  get() { try { return JSON.parse(localStorage.getItem(cardKey()) || 'null') || {}; } catch (_) { return {}; } },
  put(patch) { try { localStorage.setItem(cardKey(), JSON.stringify({ ...Store.get(), ...patch })); } catch (_) {} },
};
function saveDraft(text) { A.message = text; Store.put({ draft: text, draftSet: true }); }

const originalBoot = boot;
boot = function(data, args, mode) {
  if (booted) return;
  booted = true;
  themeMode = mode;
  originalBoot(data, args, mode);
  // Keep late host capability/theme updates from resetting a user's draft.
  const name = document.querySelector('#gname');
  if (name) name.addEventListener('input', () => { A.groupName = name.value; });
  const saved = Store.get();
  // A new group created from this card lives on as its own live thread: a reopened
  // compose card (rebuilt from its first html) swaps straight back to it.
  if (saved.swap && !liveBridge) { swapIn(saved.swap); return; }
  // The last draft the user left, even an empty one, beats the draft baked into the html.
  if (saved.draftSet) {
    A.message = saved.draft || '';
    const input = document.querySelector('#msg');
    if (input) { input.value = A.message; const b = document.querySelector('.send'); if (b) b.disabled = !A.message.trim(); }
  }
  mountLive(saved);
};
// Every keystroke is kept, so closing the notch never loses a draft (re-renders read A.message).
document.addEventListener('input', event => { if (event.target?.id === 'msg') saveDraft(event.target.value); });
// Capture first: the host often supplies {} data and no args for result widgets.
// Fall back to the server's baked live payload, never the package's demo roster.
// The host may send init more than once (tool bridge up/down): boot runs once.
addEventListener('message', event => {
  if (event.data?.type !== 'voiceos:init') return;
  event.stopImmediatePropagation();
  if (event.source !== parent) return;
  const m = event.data;
  canInvoke = m.capabilities?.invokeTool === true;
  themeMode = m.theme?.mode || themeMode;
  document.documentElement.dataset.theme = themeMode;
  inited = true;
  boot(m.data && Object.keys(m.data).length ? m.data : DEMO.data,
    { ...DEMO.args, ...m.args }, themeMode);
  // This listener swallows voiceos:init, so hand the capability to the live
  // conversation (boot above is a no-op once the baked payload booted).
  if (liveBridge) liveBridge.canInvoke = canInvoke;
}, true);

function sendStatus(message, bad = false) {
  let status = document.querySelector('#send-status');
  if (!message) { if (status) { status.remove(); report(); } return; }
  if (!status) {
    status = document.createElement('div');
    status.id = 'send-status'; status.className = 'sys';
    status.setAttribute('role', 'status');
    document.querySelector('#c').before(status);
  }
  status.textContent = message;
  status.style.color = bad ? 'var(--bad)' : 'var(--ink-3)';
  report();
}
// The live chat's own line: its progress and errors never replace or clear the send line above.
function liveStatus(message, bad = false) {
  let line = document.querySelector('#live-status');
  if (!message) { if (line) { line.remove(); report(); } return; }
  if (!line) {
    line = document.createElement('div');
    line.id = 'live-status'; line.className = 'sys';
    line.setAttribute('role', 'status');
    (document.querySelector('#send-status') || document.querySelector('#c')).before(line);
  }
  line.textContent = message;
  line.style.color = bad ? 'var(--bad)' : 'var(--ink-3)';
  report();
}
// The composer's controls; the live conversation's own buttons keep their state (they queue behind the send).
function lockSend(on) {
  document.querySelectorAll('#v-thread input, #v-thread button').forEach(el => { if (!el.closest('.lc-list, .lc-pc')) el.disabled = on; });
}
function unpackResult(result) {
  if (result?.isError) throw new Error('The send failed. Your message is back in the box.');
  if (result?.structuredContent) return result.structuredContent;
  const text = result?.content?.find(block => block.type === 'text')?.text;
  return typeof text === 'string' ? JSON.parse(text) : result;
}
// A message that did not go out returns to the box, unless the user already typed something new.
function giveBack(message) {
  const input = document.querySelector('#msg');
  if (!input || input.value.trim()) return;
  input.value = message; saveDraft(message);
  const b = document.querySelector('.send'); if (b) b.disabled = false;
}

/* The message leaves the box as a bubble, condenses into a glowing pellet with a
 * comet trail, and rides a curved motion path into the bot's orb, which gulps it
 * (the old "sent" card's follow-up animation). Its row in the thread shows when it lands. */
const gbMix = (a, b, t) => { const h = x => [1, 3, 5].map(i => parseInt(x.slice(i, i + 2), 16)); const p = h(a), q = h(b); return 'rgb(' + p.map((v, i) => Math.round(v + (q[i] - v) * t)).join(',') + ')'; };
const gbRamp = t => t < .5 ? gbMix('#ff5fd2', '#8f7cff', t * 2) : gbMix('#8f7cff', '#7cf5c8', (t - .5) * 2);
const FLY_MS = 950;
function orbOf() {
  return document.querySelector('#hd .av') || document.querySelector('#hd');
}
function gulp(orb, color) {
  if (!orb) return;
  if (typeof Motion !== 'undefined' && orb.classList.contains('av')) { Motion.react(orb); setTimeout(() => Motion.set(orb, 'working'), 350); }
  if (gbCalm) return;
  orb.classList.remove('gb-gulp'); void orb.offsetWidth; orb.classList.add('gb-gulp');
  setTimeout(() => orb.classList.remove('gb-gulp'), 850);
  const r = orb.getBoundingClientRect();
  [0, 130].forEach(delay => {
    const w = document.createElement('i'); w.className = 'gb-wave';
    Object.assign(w.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px', animationDelay: delay + 'ms' });
    w.style.setProperty('--c', color);
    document.body.appendChild(w); setTimeout(() => w.remove(), 900 + delay);
  });
}
function launch(text, localId) {
  const orb = orbOf(), input = document.querySelector('#msg');
  const color = (!isGroup && SELF && botById(D, SELF).color) || '#8f7cff';
  const row = () => document.querySelector('[data-lc="' + localId + '"]');
  const land = () => { const r = row(); if (r) r.style.visibility = ''; gulp(orb, color); };
  if (gbCalm || !orb || !input) { land(); return; }
  const r0 = row(); if (r0) r0.style.visibility = 'hidden';
  const s = input.getBoundingClientRect(), o = orb.getBoundingClientRect();
  const lead = document.createElement('div'); lead.className = 'gb-fly probe'; lead.textContent = text; document.body.appendChild(lead);
  const w = Math.min(lead.offsetWidth, s.width), sx = s.left + w / 2, sy = s.top + s.height / 2;
  const ex = o.left + o.width / 2, ey = o.top + o.height / 2, reach = Math.min(innerWidth - 24, Math.max(sx, ex) + 150);
  const path = "path('M " + sx + ' ' + sy + ' C ' + reach + ' ' + (sy - 20) + ', ' + reach + ' ' + (ey + 40) + ', ' + ex + ' ' + ey + "')";
  const set = el => { el.style.setProperty('--path', path); el.style.setProperty('--dur', FLY_MS + 'ms'); el.style.setProperty('--c', color); };
  set(lead); lead.style.setProperty('--w', w + 'px'); lead.className = 'gb-fly lead';
  const ghosts = Array.from({ length: 6 }, (_, i) => {
    const g = document.createElement('i'); g.className = 'gb-fly ghost'; set(g);
    g.style.setProperty('--s', (9 - i) + 'px'); g.style.setProperty('--o', (.8 - i * .12).toFixed(2));
    g.style.setProperty('--d', (38 * (i + 1)) + 'ms'); g.style.setProperty('--col', gbRamp(i / 5));
    document.body.appendChild(g); return g;
  });
  let landed = false;
  const once = () => { if (landed) return; landed = true; land(); };
  lead.addEventListener('animationend', once, { once: true }); setTimeout(once, FLY_MS + 80);
  setTimeout(() => { lead.remove(); ghosts.forEach(g => g.remove()); }, FLY_MS + 420);
}

/* Live thread send: the bubble shows at once as a local row ('sending'), the box
 * clears, and the host's answer settles it — 'sent' (the next refresh swaps in the
 * real message), back to the box on failure, or 'orphan' when unconfirmed (a
 * refresh that finds it confirms it; one that still lacks it 30 s later returns it). */
function settleLive(requestId, status, result, error) {
  const p = liveSends.get(requestId);
  if (!p) return;
  liveSends.delete(requestId);
  clearTimeout(p.timer);
  if (status === 'completed' && result !== undefined) {
    try {
      const body = unpackResult(result);
      if (body?.sent !== true) throw new Error(body?.message || 'The send was not confirmed.');
    } catch (cause) { error = cause.message; status = 'failed'; }
  }
  if (!liveChat) return;
  if (status === 'completed') { liveChat.setLocal(p.localId, 'sent'); liveChat.hurry(); return; }
  if (status === 'unknown') { liveChat.setLocal(p.localId, 'orphan'); liveChat.hurry(); return; }
  liveChat.dropLocal(p.localId);
  giveBack(p.message);
  sendStatus(status === 'cancelled' ? 'Not sent. Your message is back in the box.' : (error || 'Not sent. Your message is back in the box.'), true);
}
// New-group compose: the first send creates the group; the server hands back its live thread.
function finishCompose(status, result, error) {
  const pending = pendingSend;
  if (!pending) return;
  clearTimeout(pending.timer);
  pendingSend = null;
  if (status === 'completed') {
    try {
      const body = result === undefined ? { sent: true } : unpackResult(result);
      if (body?.sent !== true) throw new Error(body?.message || 'The send was not confirmed.');
      saveDraft('');
      if (body.receipt?.html) {
        // host toolResult strips _voiceos_glance, so the server hands the card back as data.
        const html = body.receipt.html.replace('<meta charset="utf-8" />',
          '<meta charset="utf-8" /><meta name="voiceos-receipt-theme" content="' + themeMode + '"><meta name="voiceos-receipt-invoke" content="1">'
          + '<meta name="voiceos-receipt-used" content="' + (liveBridge ? liveBridge.count : 1) + '">');
        Store.put({ swap: html });
        swapIn(html);
        return;
      }
      lockSend(false);
      const input = document.querySelector('#msg'); if (input) input.value = '';
      sendStatus('Sent.');
      return;
    } catch (cause) { error = cause.message; status = 'failed'; }
  }
  if (status === 'unknown') {
    sendStatus('Delivery is unconfirmed. Check Grok Bot before sending again.', true);
    return; // Keep send locked: a timed-out request may already have acted.
  }
  lockSend(false);
  const input = document.querySelector('#msg');
  document.querySelector('.send').disabled = !input.value.trim();
  sendStatus(status === 'cancelled' ? 'Cancelled — your draft is still here.' : (error || 'Not sent. Your draft is still here.'), true);
}
// The Window survives document.write: stop live timers first. Never during parsing,
// where write() would append to this document instead of replacing it.
function swapIn(html) {
  const go = () => { liveStop(); document.open(); document.write(html); document.close(); };
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', go, { once: true }); else go();
}
addEventListener('message', event => {
  if (event.source !== parent || event.data?.type !== 'voiceos:toolResult') return;
  const m = event.data;
  if (!['completed', 'failed', 'cancelled', 'unknown'].includes(m.status)) return;
  const done = sendTurns.get(m.requestId);
  if (done) { sendTurns.delete(m.requestId); done(); }
  const result = m.status === 'completed' && m.resultOmitted ? undefined : m.result;
  if (liveSends.has(m.requestId)) settleLive(m.requestId, m.status, result, m.error);
  else if (pendingSend?.requestId === m.requestId) finishCompose(m.status, result, m.error);
});
// Replace the demo's form submission callback, retaining its exact composer UI.
// VoiceOS uses allow-scripts without allow-forms, so use click / Enter events.
wireComposer = function(root) {
  const form = root.querySelector('#compose');
  // 1:1 keeps the + for ComposerKit's menu (shown once tools are ready); groups drop it.
  const plus = form.querySelector('.plus');
  if (plus) { if (isGroup || !liveBridge || typeof ComposerKit === 'undefined') plus.remove(); else plus.hidden = true; }
  const input = form.querySelector('#msg');
  const button = form.querySelector('.send');
  button.type = 'button';
  const post = (requestId, args, onTimeout) => new Promise(done => {
    sendTurns.set(requestId, done);
    const timer = setTimeout(onTimeout, 65000);
    if (liveSends.has(requestId)) liveSends.get(requestId).timer = timer;
    else if (pendingSend?.requestId === requestId) pendingSend.timer = timer;
    parent.postMessage({ type: 'voiceos:invokeTool', name: 'grokbot_card_send', args, requestId }, '*');
  });
  const go = () => {
    const message = input.value.trim();
    const files = !!(liveKit && liveKit.hasAttachments());
    if ((!message && !files) || pendingSend) return;
    if (files) {
      // Files go as one grokbot_card_files job. The kit locks itself on an
      // unconfirmed delivery, and unlocks once Check status confirms it.
      if (!liveKit.busy()) liveKit.send(message);
      return;
    }
    if (liveKit && liveKit.busy()) return;
    if (!canInvoke) { sendStatus('Sending is unavailable in this host. Your draft is still here.', true); return; }
    if (isGroup && members.length < (G ? 1 : 2)) {
      sendStatus(G ? 'Keep at least one bot in this group.' : 'Add at least two bots to start a group.', true); return;
    }
    // grokbot_card_send has no manifest `confirmation` block, so the host never
    // floats a "Confirm action" dialog over the card. Typing + send here IS the approval.
    const args = isGroup
      ? { ...(G ? { group: G.id } : {}), members: members.slice(), groupName: document.querySelector('#gname').value, message }
      : { bot: A.bot, message };
    const requestId = 'send_' + Date.now() + '_' + (++sequence);
    sendStatus('');
    if (liveChat) {
      // Live thread: the box clears for the next message right away.
      input.value = ''; saveDraft(''); button.disabled = true;
      const localId = liveChat.addLocal(message);
      liveSends.set(requestId, { localId, message, timer: 0 });
      launch(message, localId);
      liveBridge.queue(() => post(requestId, args, () => settleLive(requestId, 'unknown')))
        .catch(e => settleLive(requestId, 'failed', undefined, e.message));
      return;
    }
    lockSend(true);
    sendStatus('Sending…');
    pendingSend = { requestId, timer: 0 };
    post(requestId, args, () => finishCompose('unknown'));
  };
  form.addEventListener('submit', event => event.preventDefault());
  input.addEventListener('input', () => { button.disabled = !input.value.trim(); });
  button.addEventListener('click', event => { event.preventDefault(); go(); });
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); go(); }
  });
};
// Live conversation for 1:1 and existing groups; the new-group mode is unchanged.
function mountLive(saved) {
  const list = document.querySelector('#msgs');
  if (!liveBridge || liveChat || !list || typeof drawThread !== 'function') return;
  const target = G ? { id: G.id, name: G.name, isGroup: true }
    : !isGroup && SELF ? { id: SELF, name: botById(D, SELF).name, isGroup: false } : null;
  if (!target) return;
  // The card's last copy of the conversation is newer than the baked one. A send
  // that was in flight when the card went away is unconfirmed now ('orphan').
  const cached = Array.isArray(saved?.items)
    ? saved.items.map(i => i && i.local === 'sending' ? { ...i, local: 'orphan' } : i) : null;
  liveChat = LiveChat.mount({
    bridge: liveBridge, list, header: document.querySelector('#hd'), target,
    items: cached || (G ? G.thread : D.thread) || [],
    nextBeforeSeq: cached ? saved.before : D.nextBeforeSeq,
    renderItem: liveItem, onBots: liveBots, statusLine: liveStatus,
    onItems: (items, before) => Store.put({ items, before }),
    onLost: item => { giveBack(item.text); sendStatus('A message did not send. It is back in the box.', true); },
  });
  if (cached && cached.some(i => i && i.local)) liveChat.hurry();
  const form = document.querySelector('#compose');
  if (target.isGroup || typeof ComposerKit === 'undefined' || !form) return;
  liveKit = ComposerKit.mount({
    bridge: liveBridge, form, input: form.querySelector('#msg'), sendButton: form.querySelector('.send'),
    bot: { id: target.id, name: target.name }, status: sendStatus,
    onSent: () => { saveDraft(''); if (liveChat) liveChat.hurry(); },
  });
  livePlus();
  liveBridge.onReady(livePlus);
}
function livePlus() { const plus = document.querySelector('#compose .plus'); if (plus) plus.hidden = !liveBridge.canInvoke; }
// msgHtml rows; "Messaged" falls back to the recipient's name, notices get no orb.
// A local (not yet confirmed) send shows "Sending…" under its bubble until the host answers.
function liveItem(m) {
  if (m.local) return msgHtml(m) + (m.local === 'sent' ? '' : '<div class="sys gb-sending">Sending…</div>');
  if (typeof m.sys !== 'string') return msgHtml(m);
  if (!m.bot) return m.sys ? '<div class="sys">' + esc(m.sys) + '</div>' : '';
  const b = (D.bots || []).find(x => x.id === m.bot) || { name: m.sender || m.bot, color: '#888', shape: 'blob' };
  return '<div class="sys">' + esc(m.sys) + ' ' + av(b, 'tiny') + ' ' + esc(b.name) + '</div>';
}
// A refresh's roster updates the header's status and orbs.
function liveBots(bots) {
  if (!bots.length) return;
  D.bots = bots;
  const setState = (a, b) => { const s = b.status || 'idle'; if (a && a.dataset.state !== s) Motion.set(a, s); };
  if (isGroup) { $$('#hd .av[data-bot]').forEach(a => setState(a, botById(D, a.dataset.bot))); return; }
  const b = bots.find(x => x.id === SELF);
  if (!b) return;
  const st = $('#hd .st'), name = $('#hd .t2');
  if (st) st.innerHTML = '<span class="dot ' + dotCls(b) + '"></span>' + statusText(b) + ' · ' + esc(b.label);
  if (name) name.textContent = b.name;
  setState($('#hd .av'), b);
}
function liveStop() {
  // Nothing still queued may run once another card replaces this document: it spends the same host budget.
  if (liveBridge) liveBridge.canInvoke = false;
  if (liveChat) liveChat.destroy();
  if (liveKit) liveKit.destroy();
  liveChat = liveKit = null;
}
// Group avatars remain a usable member-picker even with no selected members.
if (typeof stackHtml === 'function') {
  const originalStack = stackHtml;
  stackHtml = function() {
    return members.length ? originalStack() : '<button class="stack" id="stack" aria-label="Members">+</button>';
  };
}
const savedTheme = document.querySelector('meta[name="voiceos-receipt-theme"]')?.content;
if (savedTheme) themeMode = savedTheme;
// The package's fallback is useful for standalone files; production boots from
// the injected payload immediately so the card cannot flash sample content.
// A card written in place by another (a new group's first send) gets no second
// voiceos:init. The card that wrote it could invoke tools (it just sent), so it can too.
if (document.querySelector('meta[name="voiceos-receipt-invoke"]')) canInvoke = true;
// The card that wrote this document already spent part of the host's per-card action budget.
const receiptUsed = +document.querySelector('meta[name="voiceos-receipt-used"]')?.content || 0;
if (receiptUsed && liveBridge) liveBridge.count = Math.max(liveBridge.count, receiptUsed);
if (liveBridge) liveBridge.canInvoke = canInvoke;
boot(DEMO.data, DEMO.args, themeMode);

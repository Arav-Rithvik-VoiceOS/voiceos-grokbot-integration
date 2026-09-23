/* Runtime adapter for the unmodified messaging handoff. Runs in its lexical scope. */
let canInvoke = false;
let pendingSend = null;
// The posted send holds the card's one action slot until the host's terminal result, even after our 65 s timeout.
let sendTurn = null;
let sequence = 0;
let booted = false;
let themeMode = 'dark';
// Set once a send is unconfirmed: the composer stays locked and this warning stays on the send line.
let lockNote = '';
// LiveChat + ComposerKit ride only on a real thread card; sent receipts have neither.
const liveBridge = typeof LiveChat !== 'undefined' ? LiveChat.bridge() : null;
let liveChat = null;
let liveKit = null;
const originalBoot = boot;
boot = function(data, args, mode) {
  if (booted) return;
  booted = true;
  themeMode = mode;
  originalBoot(data, args, mode);
  // Keep late host capability/theme updates from resetting a user's draft.
  const name = document.querySelector('#gname');
  if (name) name.addEventListener('input', () => { A.groupName = name.value; });
  mountLive();
};
// Capture first: the host often supplies {} data and no args for result widgets.
// Fall back to the server's baked live payload, never the package's demo roster.
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
  // This listener swallows voiceos:init, so hand the capability to the sent
  // cards' follow-up bar and the live conversation (boot above is a no-op once
  // the baked payload booted).
  if (typeof setInvoke === 'function') setInvoke(canInvoke);
  if (liveBridge) liveBridge.canInvoke = canInvoke;
}, true);

function sendStatus(message, bad = false) {
  let status = document.querySelector('#send-status');
  if (!message && lockNote) { message = lockNote; bad = true; }
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
  if (result?.isError) throw new Error('The send failed. Your draft is still here.');
  if (result?.structuredContent) return result.structuredContent;
  const text = result?.content?.find(block => block.type === 'text')?.text;
  return typeof text === 'string' ? JSON.parse(text) : result;
}
function finishSend(status, result, error) {
  const pending = pendingSend;
  if (!pending) return;
  clearTimeout(pending.timer);
  pendingSend = null;
  if (status === 'completed') {
    try {
      const body = unpackResult(result);
      if (body?.sent !== true) throw new Error(body?.message || 'The send was not confirmed.');
      const receipt = body.receipt;
      if (!receipt?.html) {
        // Completed is final even if the host omitted its large result. Never resend.
        sendStatus('Sent. Open the conversation to see the latest messages.');
        if (liveChat) liveChat.refresh();
        return;
      }
      stage('message', '');
      // Host toolResult deliberately strips _voiceos_glance. The server also
      // returns this receipt as data so the calling widget can show 1D / 1K.
      const html = receipt.html.replace('<meta charset="utf-8" />',
        '<meta charset="utf-8" /><meta name="voiceos-receipt-theme" content="' + themeMode + '"><meta name="voiceos-receipt-invoke" content="1">'
        + '<meta name="voiceos-receipt-used" content="' + (liveBridge ? liveBridge.count : 1) + '">');
      liveStop(); // The Window survives document.write: stop live timers first.
      document.open(); document.write(html); document.close();
      return;
    } catch (cause) { error = cause.message; status = 'failed'; }
  }
  if (status === 'unknown') {
    lockNote = 'Delivery is unconfirmed. Check Grok Bot before sending again.';
    sendStatus(lockNote, true);
    return; // Keep send locked: a timed-out request may already have acted.
  }
  lockSend(false);
  const input = document.querySelector('#msg');
  document.querySelector('.send').disabled = !input.value.trim();
  sendStatus(status === 'cancelled' ? 'Cancelled — your draft is still here.' : (error || 'Not sent. Your draft is still here.'), true);
}
addEventListener('message', event => {
  if (event.source !== parent || event.data?.type !== 'voiceos:toolResult') return;
  const m = event.data;
  if (!['completed', 'failed', 'cancelled', 'unknown'].includes(m.status)) return;
  if (sendTurn?.requestId === m.requestId) { const turn = sendTurn; sendTurn = null; turn.done(); }
  if (!pendingSend || pendingSend.requestId !== m.requestId) return;
  if (m.status === 'completed' && m.resultOmitted) {
    clearTimeout(pendingSend.timer); pendingSend = null;
    sendStatus('Sent. Open the conversation to see the latest messages.');
    if (liveChat) liveChat.refresh();
    return;
  }
  finishSend(m.status, m.result, m.error);
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
  const go = () => {
    const message = input.value.trim();
    const files = !!(liveKit && liveKit.hasAttachments());
    if ((!message && !files) || pendingSend || lockNote) return;
    if (files) {
      // Files go as one grokbot_card_files job: no stage(), no receipt. The kit locks
      // itself on an unconfirmed delivery, and unlocks once Check status confirms it.
      if (!liveKit.busy()) liveKit.send(message);
      return;
    }
    if (liveKit && liveKit.busy()) return;
    if (!canInvoke) { sendStatus('Sending is unavailable in this host. Your draft is still here.', true); return; }
    if (isGroup && members.length < (G ? 1 : 2)) {
      sendStatus(G ? 'Keep at least one bot in this group.' : 'Add at least two bots to start a group.', true); return;
    }
    // grokbot_card_send: same handlers as grokbot_send / grokbot_group, but no
    // manifest `confirmation` block — so the host never floats its "Confirm
    // action" dialog over the card. Typing + send here IS the user's approval.
    const args = isGroup
      ? { ...(G ? { group: G.id } : {}), members: members.slice(), groupName: document.querySelector('#gname').value, message }
      : { bot: A.bot, message };
    stage('message', message);
    if (isGroup) { stage('groupName', args.groupName); stage('members', args.members); }
    const requestId = 'send_' + Date.now() + '_' + (++sequence);
    lockSend(true);
    sendStatus('Sending…');
    pendingSend = { requestId, timer: 0 };
    // The host allows one pending action per card, so the send waits its turn behind the
    // live chat's calls. Its 65 s clock starts when it is actually posted.
    const post = () => new Promise(done => {
      if (pendingSend?.requestId !== requestId) return done();
      sendTurn = { requestId, done };
      pendingSend.timer = setTimeout(() => finishSend('unknown'), 65000);
      parent.postMessage({ type: 'voiceos:invokeTool', name: 'grokbot_card_send', args, requestId }, '*');
    });
    if (!liveBridge) post();
    else liveBridge.queue(post).catch(e => { if (pendingSend?.requestId === requestId) finishSend('failed', undefined, e.message); });
  };
  form.addEventListener('submit', event => event.preventDefault());
  input.addEventListener('input', () => { button.disabled = !input.value.trim(); });
  button.addEventListener('click', event => { event.preventDefault(); go(); });
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); go(); }
  });
};
// Live conversation for 1:1 and existing groups; the new-group mode is unchanged.
function mountLive() {
  const list = document.querySelector('#msgs');
  if (!liveBridge || liveChat || !list || typeof drawThread !== 'function') return;
  const target = G ? { id: G.id, name: G.name, isGroup: true }
    : !isGroup && SELF ? { id: SELF, name: botById(D, SELF).name, isGroup: false } : null;
  if (!target) return;
  liveChat = LiveChat.mount({
    bridge: liveBridge, list, header: document.querySelector('#hd'), target,
    items: (G ? G.thread : D.thread) || [], nextBeforeSeq: D.nextBeforeSeq,
    renderItem: liveItem, onBots: liveBots, statusLine: liveStatus,
  });
  const form = document.querySelector('#compose');
  if (target.isGroup || typeof ComposerKit === 'undefined' || !form) return;
  liveKit = ComposerKit.mount({
    bridge: liveBridge, form, input: form.querySelector('#msg'), sendButton: form.querySelector('.send'),
    bot: { id: target.id, name: target.name }, status: sendStatus,
    onSent: () => liveChat && liveChat.refresh(),
    openComputer: () => liveChat && liveChat.openComputer(),
  });
  livePlus();
  liveBridge.onReady(livePlus);
}
function livePlus() { const plus = document.querySelector('#compose .plus'); if (plus) plus.hidden = !liveBridge.canInvoke; }
// msgHtml rows; "Messaged" falls back to the recipient's name, notices get no orb.
function liveItem(m) {
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
  // Nothing still queued may run once the receipt replaces this document: it spends the same host budget.
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
// A receipt written in place by a card gets no second voiceos:init. The card
// that wrote it could invoke tools (it just sent), so the receipt can too.
if (document.querySelector('meta[name="voiceos-receipt-invoke"]')) canInvoke = true;
// The card that wrote this receipt already spent part of the host's per-card action budget.
const receiptUsed = +document.querySelector('meta[name="voiceos-receipt-used"]')?.content || 0;
if (receiptUsed && typeof _used === 'number') _used = Math.max(_used, receiptUsed);
// Once the host says the card's action budget is spent, the follow-up bar stops asking it.
if (typeof _used === 'number') addEventListener('message', event => {
  const m = event.data;
  if (event.source === parent && m?.type === 'voiceos:toolResult' && m.status === 'failed' && /action limit/i.test(m.error || '')) _used = Math.max(_used, 64);
});
if (liveBridge) liveBridge.canInvoke = canInvoke;
boot(DEMO.data, DEMO.args, themeMode);
if (typeof setInvoke === 'function') setInvoke(canInvoke);
